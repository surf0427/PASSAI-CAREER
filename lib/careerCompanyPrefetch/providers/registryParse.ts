/**
 * Company Prefetch — 公的 registry 応答の parser（pure・決定論・never-throw・I/O ゼロ）。
 *
 * 設計の要点（**列番号を信用しない**）:
 *   法人番号システム Web-API の CSV は列数が多く、API 版によって列順が変わりうる。
 *   固定 index に依存した parser は、列がずれた瞬間に **別の値を法人名として保存する**
 *   （= 誤情報を global テーブルへ書く最悪の失敗）。
 *   そこで本 parser は各列を **値の形で同定する**:
 *     - 法人番号 : ちょうど 13 桁の数字である列（CSV 内で一意に判別できる）
 *     - 商号     : 法人番号より後ろで、最初に現れる「数値でも日付でもない非空」列
 *     - 都道府県 : 「都/道/府/県」で終わる 2〜4 文字の列
 *   同定できなければ **その行を捨てる**（推測して埋めない）。
 *
 * 保存しないもの: CSV 全文・応答 body。呼び出し側は candidate だけを受け取る。
 */

import type { RegistryCompanyCandidate } from './types';

/** CSV 1 行を field 配列へ（RFC4180 準拠の最小実装。改行入り quoted field も扱う）。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch === '\r') {
      // CRLF の CR は捨てる（LF 側で行を確定する）。
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** ちょうど 13 桁の数字か（法人番号の形）。 */
function isCorporateNumber(value: string): boolean {
  return /^\d{13}$/.test(value.trim());
}

/** 日付らしい列か（'2026-08-16' / '20260816' / '2026/08/16'）。商号候補から除外する。 */
function looksLikeDate(value: string): boolean {
  const v = value.trim();
  return /^\d{4}[-/]?\d{1,2}[-/]?\d{1,2}$/.test(v);
}

/** 数字・記号だけの列か（区分コード等）。商号候補から除外する。 */
function looksLikeCode(value: string): boolean {
  const v = value.trim();
  return v === '' || /^[\d\s.\-/]+$/.test(v);
}

/** 都道府県らしい列か。 */
function looksLikePrefecture(value: string): boolean {
  const v = value.trim();
  return v.length >= 2 && v.length <= 4 && /[都道府県]$/.test(v);
}

/** カタカナのみの列か（フリガナ）。 */
function isKatakanaOnly(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && /^[ァ-ヶー　\s]+$/.test(v);
}

/** ASCII 英字中心の列か（英語表記名）。 */
function isAsciiName(value: string): boolean {
  const v = value.trim();
  return v.length > 2 && /^[A-Za-z0-9 .,&'()\-]+$/.test(v) && /[A-Za-z]{2,}/.test(v);
}

/**
 * CSV 1 行 → candidate（同定できなければ null）。
 *
 * ★ 「読めなかった行を捨てる」ことが安全側。欠損は null で残し、推測で埋めない。
 */
export function parseRegistryRow(row: readonly string[]): RegistryCompanyCandidate | null {
  if (!Array.isArray(row) || row.length < 3) return null;

  const numberIndex = row.findIndex((c) => isCorporateNumber(c));
  if (numberIndex < 0) return null;

  // 商号: 法人番号より後ろで、最初の「コードでも日付でもない非空」列。
  let nameIndex = -1;
  for (let i = numberIndex + 1; i < row.length; i += 1) {
    const v = row[i].trim();
    if (v === '' || looksLikeCode(v) || looksLikeDate(v)) continue;
    nameIndex = i;
    break;
  }
  if (nameIndex < 0) return null;

  const legalName = row[nameIndex].trim();
  if (legalName === '') return null;

  const rest = row.slice(nameIndex + 1).map((c) => c.trim());

  const prefecture = rest.find((c) => looksLikePrefecture(c)) ?? null;
  // 所在地: 都道府県の直後にある非空・非コード列を最大 2 つ連結する。
  let address: string | null = null;
  if (prefecture) {
    const at = rest.indexOf(prefecture);
    const parts = rest
      .slice(at + 1)
      .filter((c) => c !== '' && !looksLikeCode(c) && !looksLikeDate(c))
      .slice(0, 2);
    address = parts.length > 0 ? [prefecture, ...parts].join('') : prefecture;
  }

  // フリガナ / 英語表記は「形で同定できたときだけ」入れる。
  const legalNameKana = rest.find((c) => isKatakanaOnly(c)) ?? null;
  const legalNameEn = rest.find((c) => isAsciiName(c)) ?? null;

  return {
    corporateNumber: row[numberIndex].trim(),
    legalName,
    legalNameKana,
    legalNameEn,
    prefecture,
    address,
    // 単一行からは判定できない（registry の区分コードを推測で意味付けしない）。
    registrationStatus: null,
    formerNames: [],
  };
}

/**
 * CSV 全体 → 法人番号ごとに 1 件へ畳んだ candidate 配列。
 *
 * history 付きで問い合わせると同一法人番号の行が複数返る。その場合:
 *   - **最後に現れた行**を現在の商号として採用する（registry は時系列順に返す）
 *   - それ以外の行の商号を `formerNames`（旧商号）として保持する
 *     → `career_company_aliases` の `alias_kind='historical_name'` へ流し込む材料になる
 *       （これまで UI が alias を渡さないため常に空だった alias table が、初めて中身を持つ）
 */
export function parseRegistryCsv(text: string): RegistryCompanyCandidate[] {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const rows = parseCsv(text);
  const byNumber = new Map<string, RegistryCompanyCandidate[]>();

  for (const row of rows) {
    const candidate = parseRegistryRow(row);
    if (!candidate) continue;
    const list = byNumber.get(candidate.corporateNumber);
    if (list) list.push(candidate);
    else byNumber.set(candidate.corporateNumber, [candidate]);
  }

  const out: RegistryCompanyCandidate[] = [];
  for (const [, list] of byNumber) {
    const current = list[list.length - 1];
    const formerNames = Array.from(
      new Set(
        list
          .slice(0, -1)
          .map((c) => c.legalName)
          .filter((n) => n !== '' && n !== current.legalName),
      ),
    ).sort();
    out.push({ ...current, formerNames });
  }

  // 決定論順（法人番号昇順）。QA が順序に依存できる。
  return out.sort((a, b) => a.corporateNumber.localeCompare(b.corporateNumber));
}

/**
 * candidate 群を「入力名と正規化一致するもの」へ絞る（pure）。
 *
 * ★ registry は部分一致検索なので、`ソニー` で検索すると「ソニー損保」「ソニー銀行」等も返る。
 *   **部分一致を resolved にしない**（既存 Company Identity の不変条件と同じ）。
 *   normalize 後に完全一致した候補だけを残し、0 件なら unresolved、2 件以上なら ambiguous。
 *
 * @param normalize 呼び出し側が `normalizeCompanyName` を渡す（本 module は pure のまま保つ）。
 */
export function selectExactCandidates(
  rawName: string,
  candidates: readonly RegistryCompanyCandidate[],
  normalize: (value: string) => string,
): RegistryCompanyCandidate[] {
  const target = normalize(rawName);
  if (target === '') return [];
  return candidates.filter((c) => {
    if (normalize(c.legalName) === target) return true;
    if (c.legalNameKana && normalize(c.legalNameKana) === target) return true;
    if (c.legalNameEn && normalize(c.legalNameEn) === target) return true;
    return c.formerNames.some((n) => normalize(n) === target);
  });
}

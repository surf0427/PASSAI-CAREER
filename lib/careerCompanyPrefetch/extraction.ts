/**
 * Company Prefetch — 抽出契約と **決定論的な出典検証**（pure・決定論・never-throw・I/O ゼロ）。
 *
 * ★★ 本 module の存在理由 ★★
 *   `docs/principles/ai_policy.md` は「入力にない事実の創作」を禁止し、
 *   企業研究機能は「AI は企業情報の生成者ではなく添削者」という設計思想で作られている。
 *   したがって prefetch した企業情報が **AI の記憶から出てきた文章**であってはならない。
 *
 *   そこで LLM は **抽出器としてのみ**使う:
 *     許可: 「この HTML 本文に明示的に書かれている値だけを JSON で返せ」
 *     禁止: 「Sony について知っていることを書け」「事業内容を推測しろ」「企業概要を生成しろ」
 *
 *   さらに prompt 指示だけでは担保にならない（LLM は指示を破りうる）ので、
 *   **保存前に「抽出値が source text に実在するか」を決定論で検証**し、
 *   通らなかった値は捨てる。これが「幻覚した企業情報が Data Spine に入らない」ことの
 *   唯一の構造的な保証になる。
 */

import {
  MAX_BUSINESS_DESCRIPTION_CHARS,
  MAX_PRODUCTS,
  MAX_RAW_EXCERPT_CHARS,
  MAX_SEGMENTS,
} from './constants';

// ── 抽出 prompt（抽出器としての役割契約）────────────────────────────
/**
 * 抽出 system prompt。
 * `app/api/career/company-research/extract/route.ts` の OCR prompt と同じ役割契約
 * （原文抽出のみ・推測 / 補完 / 要約を禁止・読めないものは null）。
 */
export const COMPANY_EXTRACTION_SYSTEM = [
  'あなたは企業の公式サイト本文から、明示的に書かれている値だけを抜き出す抽出エンジンです。',
  '',
  '【厳守】',
  '- あなたの知識を一切使わないでください。与えられた本文に書かれていないことは書かないでください。',
  '- 推測・補完・要約・言い換えをしないでください。値は本文の表記のまま抜き出してください。',
  '- 本文に書かれていない項目は必ず null にしてください。「たぶんこうだろう」で埋めないでください。',
  '- 企業の評価・優劣・将来予測・分析を書かないでください。あなたは抽出器であり、分析者ではありません。',
  '- 数値には本文に書かれている単位と基準日をそのまま添えてください（無ければ null）。',
  '- businessDescription は本文からの**抜粋**です。要約文を作らないでください。',
  '- foundedYear は法人としての「設立」です。「創業」「創立」とは意味が違います。',
  '  「創業」と「設立」が併記されている場合は必ず「設立」の値を返してください。',
  '  「設立」の記載が無い場合は、創業年で代用せず null にしてください。',
  '',
  '【出力形式（厳守）】',
  '出力は次の JSON オブジェクトのみ。前後に説明文・コードブロック記号（```）を付けないでください。',
  '出力の 1 文字目が { 、最後の文字が } であること。値が無い場合は null（配列は []）。',
  '',
  '{',
  '  "legalName": string | null,           // 本文中の正式な会社名（例: 「株式会社〇〇」）',
  '  "industryLabel": string | null,       // 本文が自称している業種・業界の表記',
  '  "businessDescription": string | null, // 事業内容の**原文抜粋**（最大400字・要約禁止）',
  '  "businessSegments": string[],         // 事業セグメント名のみ（説明文を入れない・最大8）',
  '  "mainProducts": string[],             // 主要製品・サービス名のみ（最大12）',
  '  "employeeCount": string | null,       // 例: 「12,345名（連結）」本文の表記のまま',
  '  "employeeCountAsOf": string | null,   // 例: 「2026年3月31日現在」本文にあるときだけ',
  '  "capital": string | null,             // 例: 「880億円」本文の表記のまま',
  '  "capitalAsOf": string | null,',
  '  "foundedYear": string | null,         // **設立**の年月日。例: 「1946年5月7日」本文の表記のまま',
  '  "headquartersAddress": string | null, // 本社所在地の本文表記',
  '  "listingStatus": string | null,       // 例: 「東証プライム」本文の表記のまま',
  '  "tickerCode": string | null,          // 証券コード（本文にあるときだけ）',
  '  "parentCompanyName": string | null,',
  '  "corporateGroupLabel": string | null',
  '}',
].join('\n');

// ── 抽出結果の型 ─────────────────────────────────────────────────────
export type ExtractedCompanyProfile = {
  legalName: string | null;
  industryLabel: string | null;
  businessDescription: string | null;
  businessSegments: readonly string[];
  mainProducts: readonly string[];
  employeeCount: string | null;
  employeeCountAsOf: string | null;
  capital: string | null;
  capitalAsOf: string | null;
  foundedYear: string | null;
  headquartersAddress: string | null;
  listingStatus: string | null;
  tickerCode: string | null;
  parentCompanyName: string | null;
  corporateGroupLabel: string | null;
};

export const EMPTY_EXTRACTED_PROFILE: ExtractedCompanyProfile = {
  legalName: null,
  industryLabel: null,
  businessDescription: null,
  businessSegments: [],
  mainProducts: [],
  employeeCount: null,
  employeeCountAsOf: null,
  capital: null,
  capitalAsOf: null,
  foundedYear: null,
  headquartersAddress: null,
  listingStatus: null,
  tickerCode: null,
  parentCompanyName: null,
  corporateGroupLabel: null,
};

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '' || v.toLowerCase() === 'null') return null;
  return v.length > max ? v.slice(0, max) : v;
}

function strArray(value: unknown, max: number, maxChars = 80): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (out.length >= max) break;
    const v = str(item, maxChars);
    if (v === null || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** LLM 応答（parse 済み JSON）→ 型付き抽出結果。未知 key は捨てる。 */
export function normalizeExtractedProfile(raw: unknown): ExtractedCompanyProfile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    legalName: str(r.legalName, 120),
    industryLabel: str(r.industryLabel, 60),
    businessDescription: str(r.businessDescription, MAX_BUSINESS_DESCRIPTION_CHARS),
    businessSegments: strArray(r.businessSegments, MAX_SEGMENTS),
    mainProducts: strArray(r.mainProducts, MAX_PRODUCTS),
    employeeCount: str(r.employeeCount, 60),
    employeeCountAsOf: str(r.employeeCountAsOf, 40),
    capital: str(r.capital, 60),
    capitalAsOf: str(r.capitalAsOf, 40),
    foundedYear: str(r.foundedYear, 40),
    headquartersAddress: str(r.headquartersAddress, 160),
    listingStatus: str(r.listingStatus, 60),
    tickerCode: str(r.tickerCode, 16),
    parentCompanyName: str(r.parentCompanyName, 120),
    corporateGroupLabel: str(r.corporateGroupLabel, 120),
  };
}

// ── 出典検証（決定論）────────────────────────────────────────────────
/**
 * 比較用の正規化。
 * 空白・記号・全角半角の違いで「本文に在るのに無い」と誤判定しないようにする。
 * ただし **文字そのものは落とさない**（別の値を通してしまわないため）。
 */
function toComparable(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[・･,，、.。:：;；'"'"()（）\[\]「」『』【】\-—–_/|~〜]/g, '');
}

/**
 * 抽出値が source text に実在するか（決定論・pure）。
 *
 * ★ ここが「LLM の幻覚を Data Spine へ入れない」最後の関門。
 *   prompt 指示は担保にならないので、**必ず本文と突き合わせる**。
 */
export function isGroundedInSource(value: string, sourceText: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (typeof sourceText !== 'string' || sourceText.trim() === '') return false;
  const needle = toComparable(value);
  // 極端に短い値（1 文字）は誤って一致するため採用しない。
  if (needle.length < 2) return false;
  return toComparable(sourceText).includes(needle);
}

// ── foundedYear の意味固定（創業 ≠ 設立）────────────────────────────
/**
 * `foundedYear` は **法人としての「設立」**（renderer のラベルも「設立」）。
 *
 * 日本企業の会社概要は「創業」と「設立」を併記することが多く、LLM は先に現れる
 * 「創業」を返しうる（canary 実測: 創業 明治22年9月 / 設立 昭和22年11月 の頁で
 * 創業側が保存された）。prompt の指示は担保にならないため、
 * **原文から決定論で確定する**（この module の他の検証と同じ思想）。
 */
const ESTABLISHED_LABEL = '設立';

/** 「設立」ではない創業系ラベル（foundedYear へ昇格させない）。 */
const FOUNDING_LABELS: readonly string[] = ['創業', '創立'];

/** ラベルと日付の間に挟まってよい文字（「設立年月日：」「設立 : 」「設　立\n」等）。 */
const LABEL_GAP = /^[\s　:：;；|｜・･年月日／/\\,，、.。（）()［］[\]＝=－ー\-–—]*/;

/**
 * ラベル〜日付の距離の上限。
 * 離れた場所の年を拾わないための保険（表組みの改行 1 つ分を跨げれば足りる）。
 */
const MAX_LABEL_GAP_CHARS = 12;

/**
 * ラベル直後の日付表記（和暦・西暦）。**原文の表記のまま**返すため加工しない。
 * 先頭一致のみ（「設立以来80年」のような散文から年を拾わない）。
 */
const DATE_AT_START =
  /^(?:(?:明治|大正|昭和|平成|令和)\s*)?\d{1,4}\s*年(?:\s*\d{1,2}\s*月)?(?:\s*\d{1,2}\s*日)?|^\d{4}\s*[./-]\s*\d{1,2}(?:\s*[./-]\s*\d{1,2})?/;

/**
 * ラベル 1 語の照合パターン。
 *
 * ★ 実サイトは表組みの見出しを「設　立」「創　業」のように **文字間へ空白を入れて**
 *   組むことが多い（canary の会社概要ページが実際にこの表記だった）。
 *   単純な `indexOf('設立')` では 1 件も当たらないため、文字間の空白を許容する。
 *   改行は跨がない（無関係な行の 1 文字目と繋げて誤検出しないため）。
 */
function buildLabelPattern(label: string): RegExp {
  const chars = Array.from(label).map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(chars.join('[ \\t\\u3000]*'), 'g');
}

/**
 * `label` の直後に続く日付を原文から切り出す（pure・決定論・作文しない）。
 * ラベルが複数回現れる場合は、**日付が続く最初の 1 件**を採る。
 */
export function findLabeledDate(sourceText: string, label: string): string | null {
  if (typeof sourceText !== 'string' || typeof label !== 'string' || label === '') return null;
  const pattern = buildLabelPattern(label);
  for (;;) {
    const hit = pattern.exec(sourceText);
    if (!hit) return null;
    const after = sourceText.slice(hit.index + hit[0].length);
    const gap = LABEL_GAP.exec(after)?.[0] ?? '';
    if (gap.length <= MAX_LABEL_GAP_CHARS) {
      const matched = DATE_AT_START.exec(after.slice(gap.length))?.[0]?.trim();
      if (matched) return matched;
    }
    // 0 幅マッチで無限ループしない。
    if (pattern.lastIndex <= hit.index) pattern.lastIndex = hit.index + 1;
  }
}

/** 2 つの日付表記が実質同じものを指すか（表記の一部一致を含む）。 */
function refersToSameDate(a: string, b: string): boolean {
  const x = toComparable(a);
  const y = toComparable(b);
  if (x.length < 2 || y.length < 2) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * 抽出された `foundedYear` を「設立」の意味へ正す（pure・決定論）。
 *
 * 契約:
 *   0. 抽出値が無い → `null`（**本関数は fact を新規に生み出さない**。
 *      決定論 parse で LLM が返さなかった値を作ると partial 判定の意味が変わるため）
 *   1. 原文に「設立 <日付>」がある → **その値**（LLM が創業を返していても原文で上書きする）
 *   2. 「設立」が無く、抽出値が「創業 / 創立」の日付と一致する → `null`（昇格させない）
 *   3. それ以外 → 抽出値のまま（出典検証は呼び出し側が別途行う）
 */
export function resolveFoundedYear(
  extractedValue: string | null,
  sourceText: string,
): string | null {
  if (extractedValue === null) return null;

  const established = findLabeledDate(sourceText, ESTABLISHED_LABEL);
  if (established !== null) return established;

  for (const label of FOUNDING_LABELS) {
    const founding = findLabeledDate(sourceText, label);
    if (founding !== null && refersToSameDate(extractedValue, founding)) return null;
  }
  return extractedValue;
}

/** 検証で落とした項目の記録（観測用。値そのものは保持しない）。 */
export type GroundingReport = {
  /** 検証を通った項目数。 */
  kept: number;
  /** 本文に無かったため捨てた項目 key（enum 相当の固定 key 名のみ）。 */
  rejectedKeys: readonly string[];
};

/**
 * 抽出結果から **本文に実在しない値を落とす**（pure）。
 *
 * 落とし方は項目ごとに独立（1 つ幻覚があっても他の正しい値は残す＝部分成功を活かす）。
 */
export function rejectUngroundedValues(
  profile: ExtractedCompanyProfile,
  sourceText: string,
): { profile: ExtractedCompanyProfile; report: GroundingReport } {
  const rejected: string[] = [];
  let kept = 0;

  const keepString = (key: keyof ExtractedCompanyProfile, value: string | null): string | null => {
    if (value === null) return null;
    if (isGroundedInSource(value, sourceText)) {
      kept += 1;
      return value;
    }
    rejected.push(key);
    return null;
  };

  const keepArray = (
    key: keyof ExtractedCompanyProfile,
    values: readonly string[],
  ): readonly string[] => {
    const out = values.filter((v) => isGroundedInSource(v, sourceText));
    if (out.length < values.length) rejected.push(key);
    kept += out.length;
    return out;
  };

  // ★ foundedYear だけは「値が本文に在るか」の前に **意味**を正す（創業 → 設立）。
  //   原文に「設立」が無いのに創業日が入っていたら、ここで落とす（昇格させない）。
  const foundedYear = resolveFoundedYear(profile.foundedYear, sourceText);
  if (profile.foundedYear !== null && foundedYear === null) rejected.push('foundedYear');

  const next: ExtractedCompanyProfile = {
    legalName: keepString('legalName', profile.legalName),
    industryLabel: keepString('industryLabel', profile.industryLabel),
    businessDescription: keepString('businessDescription', profile.businessDescription),
    businessSegments: keepArray('businessSegments', profile.businessSegments),
    mainProducts: keepArray('mainProducts', profile.mainProducts),
    employeeCount: keepString('employeeCount', profile.employeeCount),
    employeeCountAsOf: keepString('employeeCountAsOf', profile.employeeCountAsOf),
    capital: keepString('capital', profile.capital),
    capitalAsOf: keepString('capitalAsOf', profile.capitalAsOf),
    foundedYear: keepString('foundedYear', foundedYear),
    headquartersAddress: keepString('headquartersAddress', profile.headquartersAddress),
    listingStatus: keepString('listingStatus', profile.listingStatus),
    tickerCode: keepString('tickerCode', profile.tickerCode),
    parentCompanyName: keepString('parentCompanyName', profile.parentCompanyName),
    corporateGroupLabel: keepString('corporateGroupLabel', profile.corporateGroupLabel),
  };

  return { profile: next, report: { kept, rejectedKeys: Array.from(new Set(rejected)) } };
}

/**
 * 値の周辺を原文から切り出す（`rawExcerpt` 用・pure）。
 * 見つからなければ null（作文しない）。
 */
export function findRawExcerpt(
  value: string,
  sourceText: string,
  maxChars = MAX_RAW_EXCERPT_CHARS,
): string | null {
  if (!isGroundedInSource(value, sourceText)) return null;
  // 正規化前の原文で素直に探す（見つかればそこを、見つからなければ先頭付近を使わない）。
  const index = sourceText.indexOf(value);
  if (index < 0) return null;
  const start = Math.max(0, index - Math.floor(maxChars / 4));
  return sourceText.slice(start, start + maxChars).trim() || null;
}

/** 抽出結果が「1 つも値を持たない」か（job の partial 判定に使う）。 */
export function isEmptyExtraction(profile: ExtractedCompanyProfile): boolean {
  return (
    profile.businessSegments.length === 0 &&
    profile.mainProducts.length === 0 &&
    profile.legalName === null &&
    profile.industryLabel === null &&
    profile.businessDescription === null &&
    profile.employeeCount === null &&
    profile.capital === null &&
    profile.foundedYear === null &&
    profile.headquartersAddress === null &&
    profile.listingStatus === null &&
    profile.tickerCode === null &&
    profile.parentCompanyName === null &&
    profile.corporateGroupLabel === null
  );
}

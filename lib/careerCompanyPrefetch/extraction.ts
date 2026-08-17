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
  MAX_DEVELOPMENTS,
  MAX_DEVELOPMENT_CHARS,
  MAX_LIST_ITEMS,
  MAX_PRODUCTS,
  MAX_RAW_EXCERPT_CHARS,
  MAX_SEGMENTS,
  MAX_STATEMENT_CHARS,
} from './constants';

// ── 抽出 prompt（抽出器としての役割契約）────────────────────────────
/**
 * 全ページ共通の抽出契約（役割・禁止事項）。
 *
 * ★ ページ別 prompt はこの前置きを **必ず** 共有する。
 *   ここが「抽出器であって生成器ではない」という契約の唯一の定義箇所。
 */
const EXTRACTION_PREAMBLE: readonly string[] = [
  'あなたは企業の公式サイト本文から、明示的に書かれている値だけを抜き出す抽出エンジンです。',
  '',
  '【厳守】',
  '- あなたの知識を一切使わないでください。与えられた本文に書かれていないことは書かないでください。',
  '- 推測・補完・要約・言い換えをしないでください。値は本文の表記のまま抜き出してください。',
  '- 本文に書かれていない項目は必ず null にしてください。「たぶんこうだろう」で埋めないでください。',
  '- 企業の評価・優劣・将来予測・分析を書かないでください。あなたは抽出器であり、分析者ではありません。',
  '- 数値には本文に書かれている単位と基準日をそのまま添えてください（無ければ null）。',
];

/** ページ別 prompt の共通末尾（出力形式の固定）。 */
function extractionSystem(rules: readonly string[], schemaLines: readonly string[]): string {
  return [
    ...EXTRACTION_PREAMBLE,
    ...rules,
    '',
    '【出力形式（厳守）】',
    '出力は次の JSON オブジェクトのみ。前後に説明文・コードブロック記号（```）を付けないでください。',
    '出力の 1 文字目が { 、最後の文字が } であること。値が無い場合は null（配列は []）。',
    '',
    '{',
    ...schemaLines,
    '}',
  ].join('\n');
}

/**
 * 会社概要ページの抽出 system prompt。
 * `app/api/career/company-research/extract/route.ts` の OCR prompt と同じ役割契約
 * （原文抽出のみ・推測 / 補完 / 要約を禁止・読めないものは null）。
 */
export const COMPANY_EXTRACTION_SYSTEM = extractionSystem(
  [
    '- businessDescription は本文からの**抜粋**です。要約文を作らないでください。',
    '- foundedYear は法人としての「設立」です。「創業」「創立」とは意味が違います。',
    '  「創業」と「設立」が併記されている場合は必ず「設立」の値を返してください。',
    '  「設立」の記載が無い場合は、創業年で代用せず null にしてください。',
    '- selfDescribedStrengths は「企業が自社の強みとして書いている記述」だけです。',
    '  あなたが強みだと考えたことを書かないでください。記載が無ければ [] です。',
    '- targetCustomers は本文が挙げている顧客・取引先の**区分名や社名**だけです（推測禁止）。',
  ],
  [
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
    '  "corporateGroupLabel": string | null,',
    '  "representativeName": string | null,  // 代表者名（本文の表記のまま）',
    '  "representativeTitle": string | null, // 代表者の役職（例: 「代表取締役社長」）',
    '  "businessModel": string | null,       // 収益の上げ方・提供形態の**原文抜粋**（最大300字）',
    '  "targetCustomers": string[],          // 本文が挙げる顧客・取引先の区分名や社名（最大8）',
    '  "overseasPresence": string | null,    // 海外展開・海外拠点の**原文抜粋**（最大300字）',
    '  "groupCompanies": string[],           // 本文が挙げるグループ会社名（最大8）',
    '  "selfDescribedStrengths": string[]    // 自社が強みとして書いている記述（各最大300字・最大8）',
  ],
);

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
  representativeName: string | null;
  representativeTitle: string | null;
  businessModel: string | null;
  targetCustomers: readonly string[];
  overseasPresence: string | null;
  groupCompanies: readonly string[];
  selfDescribedStrengths: readonly string[];
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
  representativeName: null,
  representativeTitle: null,
  businessModel: null,
  targetCustomers: [],
  overseasPresence: null,
  groupCompanies: [],
  selfDescribedStrengths: [],
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
    representativeName: str(r.representativeName, 80),
    representativeTitle: str(r.representativeTitle, 60),
    businessModel: str(r.businessModel, MAX_STATEMENT_CHARS),
    targetCustomers: strArray(r.targetCustomers, MAX_LIST_ITEMS),
    overseasPresence: str(r.overseasPresence, MAX_STATEMENT_CHARS),
    groupCompanies: strArray(r.groupCompanies, MAX_LIST_ITEMS, 120),
    selfDescribedStrengths: strArray(r.selfDescribedStrengths, MAX_LIST_ITEMS, MAX_STATEMENT_CHARS),
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
    representativeName: keepString('representativeName', profile.representativeName),
    representativeTitle: keepString('representativeTitle', profile.representativeTitle),
    businessModel: keepString('businessModel', profile.businessModel),
    targetCustomers: keepArray('targetCustomers', profile.targetCustomers),
    overseasPresence: keepString('overseasPresence', profile.overseasPresence),
    groupCompanies: keepArray('groupCompanies', profile.groupCompanies),
    selfDescribedStrengths: keepArray('selfDescribedStrengths', profile.selfDescribedStrengths),
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

/**
 * 「1 つも値を持たない」か（pure・object の全 field を機械的に見る）。
 *
 * ★ field を追加したときに更新を忘れても壊れないよう **列挙しない**
 *   （旧実装は列挙式だったため、新 key だけが取れたケースを空と誤判定しうる）。
 *   `*AsOf` は単独では意味を持たないため除外する（基準日だけ取れても値が無い＝空）。
 */
function isEmptyRecord(record: Readonly<Record<string, unknown>>): boolean {
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith('AsOf')) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return false;
      continue;
    }
    if (value !== null && value !== undefined && value !== '') return false;
  }
  return true;
}

/** 抽出結果が「1 つも値を持たない」か（job の partial 判定に使う）。 */
export function isEmptyExtraction(profile: ExtractedCompanyProfile): boolean {
  return isEmptyRecord(profile as unknown as Record<string, unknown>);
}

// ════════════════════════════════════════════════════════════════════════
// ページ別抽出（理念 / IR / 採用 / ニュース）
//
// ★ 設計方針:
//   - **ページごとに 1 回**抽出する（1 回の巨大 call にしない）。
//     理由: `stop_reason === 'max_tokens'` はその call の結果を丸ごと捨てるため、
//     1 call に全項目を詰めると 1 箇所の長文で全項目を失う。
//   - 検証（原文に実在するか）は **その page の本文に対して**行う。
//     IR ページの数字を採用ページの本文で検証してしまわないため、
//     抽出単位と検証単位を必ず一致させる。
//   - 正規化 / 検証 / 空判定は spec 駆動（`FieldSpec`）で共通化する。
//     key を足すときに 3 箇所を書き換える必要が無い＝ drift しない。
// ════════════════════════════════════════════════════════════════════════

/** 1 field の正規化仕様（string か array か・上限）。 */
export type FieldSpec =
  | { kind: 'string'; max: number }
  | { kind: 'array'; max: number; maxChars: number };

/** ある抽出型 T の全 field に対する仕様（field を足すと型エラーで気付ける）。 */
export type FieldSpecMap<T> = Readonly<Record<keyof T & string, FieldSpec>>;

type SpecOf<T> = FieldSpecMap<T>;

/** spec に従って未知 key を捨て、型どおりに正規化する（pure）。 */
export function normalizeBySpec<T>(raw: unknown, spec: SpecOf<T>): T {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(spec) as [string, FieldSpec][]) {
    out[key] =
      field.kind === 'string'
        ? str(r[key], field.max)
        : strArray(r[key], field.max, field.maxChars);
  }
  return out as T;
}

/**
 * spec に従って **本文に実在しない値を落とす**（pure）。
 *
 * `rejectUngroundedValues`（会社概要用）と同じ思想の汎用版。
 * 落とし方は項目ごとに独立（1 つ幻覚があっても他の正しい値は残す）。
 */
export function rejectUngroundedBySpec<T>(
  value: T,
  spec: SpecOf<T>,
  sourceText: string,
): { value: T; report: GroundingReport } {
  const record = value as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const rejected: string[] = [];
  let kept = 0;

  for (const [key, field] of Object.entries(spec) as [string, FieldSpec][]) {
    if (field.kind === 'string') {
      const v = record[key];
      if (typeof v !== 'string' || v === '') {
        out[key] = null;
        continue;
      }
      if (isGroundedInSource(v, sourceText)) {
        kept += 1;
        out[key] = v;
      } else {
        rejected.push(key);
        out[key] = null;
      }
      continue;
    }
    const items = Array.isArray(record[key]) ? (record[key] as string[]) : [];
    const filtered = items.filter((item) => isGroundedInSource(item, sourceText));
    if (filtered.length < items.length) rejected.push(key);
    kept += filtered.length;
    out[key] = filtered;
  }

  return { value: out as T, report: { kept, rejectedKeys: Array.from(new Set(rejected)) } };
}

/** spec 駆動の空判定。 */
export function isEmptyBySpec<T>(value: T): boolean {
  return isEmptyRecord(value as unknown as Record<string, unknown>);
}

// ── 理念ページ（経営理念 / ビジョン / 価値観）────────────────────────
export type ExtractedCompanyPhilosophy = {
  missionStatement: string | null;
  visionStatement: string | null;
  corporateValues: readonly string[];
};

export const PHILOSOPHY_SPEC: SpecOf<ExtractedCompanyPhilosophy> = {
  missionStatement: { kind: 'string', max: MAX_STATEMENT_CHARS },
  visionStatement: { kind: 'string', max: MAX_STATEMENT_CHARS },
  corporateValues: { kind: 'array', max: MAX_LIST_ITEMS, maxChars: MAX_STATEMENT_CHARS },
};

export const COMPANY_PHILOSOPHY_EXTRACTION_SYSTEM = extractionSystem(
  [
    '- 経営理念・ミッション・ビジョン・行動指針は、本文に書かれている**そのままの文**を返してください。',
    '  言い換え・短縮・意訳をしないでください。',
    '- 本文に理念の記載が無ければ、すべて null / [] にしてください（会社説明文で代用しないこと）。',
  ],
  [
    '  "missionStatement": string | null, // 経営理念 / ミッション / パーパスの原文（最大300字）',
    '  "visionStatement": string | null,  // ビジョン / 目指す姿の原文（最大300字）',
    '  "corporateValues": string[]        // バリュー / 行動指針 / 価値観の原文（各最大300字・最大8）',
  ],
);

// ── IR ページ（財務 / 戦略 / 市場環境）──────────────────────────────
export type ExtractedCompanyIr = {
  fiscalPeriodLabel: string | null;
  revenue: string | null;
  operatingProfit: string | null;
  netProfit: string | null;
  segmentPerformance: readonly string[];
  financialHighlights: string | null;
  midTermPlanSummary: string | null;
  growthStrategy: string | null;
  strategicInvestmentAreas: readonly string[];
  statedChallenges: readonly string[];
  businessRisks: readonly string[];
  marketEnvironment: string | null;
  marketPositionClaims: readonly string[];
  namedCompetitors: readonly string[];
};

export const IR_SPEC: SpecOf<ExtractedCompanyIr> = {
  fiscalPeriodLabel: { kind: 'string', max: 40 },
  revenue: { kind: 'string', max: 80 },
  operatingProfit: { kind: 'string', max: 80 },
  netProfit: { kind: 'string', max: 80 },
  segmentPerformance: { kind: 'array', max: MAX_LIST_ITEMS, maxChars: 120 },
  financialHighlights: { kind: 'string', max: MAX_STATEMENT_CHARS },
  midTermPlanSummary: { kind: 'string', max: MAX_STATEMENT_CHARS },
  growthStrategy: { kind: 'string', max: MAX_STATEMENT_CHARS },
  strategicInvestmentAreas: { kind: 'array', max: MAX_LIST_ITEMS, maxChars: 120 },
  statedChallenges: { kind: 'array', max: MAX_LIST_ITEMS, maxChars: MAX_STATEMENT_CHARS },
  businessRisks: { kind: 'array', max: MAX_LIST_ITEMS, maxChars: MAX_STATEMENT_CHARS },
  marketEnvironment: { kind: 'string', max: MAX_STATEMENT_CHARS },
  marketPositionClaims: { kind: 'array', max: MAX_LIST_ITEMS, maxChars: 120 },
  namedCompetitors: { kind: 'array', max: MAX_LIST_ITEMS, maxChars: 80 },
};

export const COMPANY_IR_EXTRACTION_SYSTEM = extractionSystem(
  [
    '★ 金額・数値は絶対に計算・換算・丸めをしないでください。本文の表記のまま返してください。',
    '  （例: 「売上収益 13兆207億円」→ "13兆207億円"。「130,207百万円」→ "130,207百万円"）',
    '- 本文に決算期の記載が無ければ fiscalPeriodLabel は null にしてください。年を推測しないこと。',
    '- 売上・利益が本文に無ければ null です。**別の数字で代用しないでください**。',
    '- statedChallenges / businessRisks は「企業自身が課題 / リスクとして書いている記述」だけです。',
    '  あなたが課題だと考えたことを書かないでください。',
    '- marketPositionClaims は「シェア1位」「業界最大手」など**企業自身の主張の原文**だけです。',
    '- namedCompetitors は本文が競合として名前を挙げている会社名だけです。推測で社名を書かないこと。',
    '- リンク名・目次・PDF タイトルだけの行から内容を推測しないでください（本文に無ければ null）。',
  ],
  [
    '  "fiscalPeriodLabel": string | null,      // 例: 「2026年3月期」本文の表記のまま',
    '  "revenue": string | null,                // 売上高 / 売上収益。単位込みで本文の表記のまま',
    '  "operatingProfit": string | null,        // 営業利益（またはそれに相当する本文の項目）',
    '  "netProfit": string | null,              // 当期純利益',
    '  "segmentPerformance": string[],          // 例: 「ゲーム事業 売上4兆円」原文のまま（最大8）',
    '  "financialHighlights": string | null,    // 業績のハイライト記述の原文抜粋（最大300字）',
    '  "midTermPlanSummary": string | null,     // 中期経営計画の記述の原文抜粋（最大300字）',
    '  "growthStrategy": string | null,         // 成長戦略の記述の原文抜粋（最大300字）',
    '  "strategicInvestmentAreas": string[],    // 重点投資領域の原文表記（最大8）',
    '  "statedChallenges": string[],            // 自社が課題として述べている記述（最大8）',
    '  "businessRisks": string[],               // 自社が事業リスクとして述べている記述（最大8）',
    '  "marketEnvironment": string | null,      // 市場環境・業界動向の記述の原文抜粋（最大300字）',
    '  "marketPositionClaims": string[],        // 自社の市場ポジションの主張の原文（最大8）',
    '  "namedCompetitors": string[]             // 本文が競合として挙げた社名のみ（最大8）',
  ],
);

// ── 採用ページ（求める人物像 / 職種 / 社風 / 働き方）──────────────────
export type ExtractedCompanyRecruiting = {
  desiredCandidateProfile: string | null;
  recruitingOverview: string | null;
  jobCategories: readonly string[];
  organizationalCulture: string | null;
  workingStyle: string | null;
  trainingPrograms: readonly string[];
  careerDevelopment: string | null;
};

export const RECRUITING_SPEC: SpecOf<ExtractedCompanyRecruiting> = {
  desiredCandidateProfile: { kind: 'string', max: MAX_STATEMENT_CHARS },
  recruitingOverview: { kind: 'string', max: MAX_STATEMENT_CHARS },
  jobCategories: { kind: 'array', max: MAX_LIST_ITEMS, maxChars: 60 },
  organizationalCulture: { kind: 'string', max: MAX_STATEMENT_CHARS },
  workingStyle: { kind: 'string', max: MAX_STATEMENT_CHARS },
  trainingPrograms: { kind: 'array', max: MAX_LIST_ITEMS, maxChars: 120 },
  careerDevelopment: { kind: 'string', max: MAX_STATEMENT_CHARS },
};

export const COMPANY_RECRUITING_EXTRACTION_SYSTEM = extractionSystem(
  [
    '- 「求める人物像」は採用ページが明記している文だけです。企業理念から推測しないでください。',
    '- 社風・働き方は本文の記述の原文抜粋です。あなたの印象・評価を書かないでください。',
    '- 選考フロー・締切・給与は抽出対象では**ありません**（年度で変わるため保存しない）。',
    '- 職種名は本文に列挙されているものだけです。一般的な職種名を補わないでください。',
  ],
  [
    '  "desiredCandidateProfile": string | null, // 求める人物像の原文抜粋（最大300字）',
    '  "recruitingOverview": string | null,      // 採用の方針・概要の原文抜粋（最大300字）',
    '  "jobCategories": string[],                // 募集職種名のみ（最大8）',
    '  "organizationalCulture": string | null,   // 社風・組織文化の記述の原文抜粋（最大300字）',
    '  "workingStyle": string | null,            // 働き方（勤務形態・制度）の記述の原文抜粋（最大300字）',
    '  "trainingPrograms": string[],             // 研修・育成制度の名称や記述（最大8）',
    '  "careerDevelopment": string | null        // キャリア形成支援の記述の原文抜粋（最大300字）',
  ],
);

// ── ニュースページ（最近の動向）──────────────────────────────────────
export type ExtractedCompanyDevelopments = {
  recentDevelopments: readonly string[];
  productLaunches: readonly string[];
  partnerships: readonly string[];
  mergersAcquisitions: readonly string[];
};

export const DEVELOPMENTS_SPEC: SpecOf<ExtractedCompanyDevelopments> = {
  recentDevelopments: { kind: 'array', max: MAX_DEVELOPMENTS, maxChars: MAX_DEVELOPMENT_CHARS },
  productLaunches: { kind: 'array', max: MAX_DEVELOPMENTS, maxChars: MAX_DEVELOPMENT_CHARS },
  partnerships: { kind: 'array', max: MAX_DEVELOPMENTS, maxChars: MAX_DEVELOPMENT_CHARS },
  mergersAcquisitions: { kind: 'array', max: MAX_DEVELOPMENTS, maxChars: MAX_DEVELOPMENT_CHARS },
};

export const COMPANY_DEVELOPMENTS_EXTRACTION_SYSTEM = extractionSystem(
  [
    '- 見出しは本文（ニュース一覧）の**表記のまま**返してください。日付が併記されていれば含めます。',
    '- ニュースを全部並べないでください。企業の事業・組織・戦略に関わるものだけを選びます。',
    '  （採用イベント告知・サイト保守のお知らせ・受賞の類は除外してください。）',
    '- 分類（新製品 / 提携 / M&A）は**見出しにそう書かれているもの**だけです。推測で分類しないこと。',
    '  分類できないものは recentDevelopments にだけ入れてください。',
    '- 1 件ずつが本文に実在する見出しであること。要約して 1 件に統合しないでください。',
  ],
  [
    '  "recentDevelopments": string[],  // 事業に関わる発表の見出し（日付込み・最大6）',
    '  "productLaunches": string[],     // 新製品・新サービス発表の見出し（最大6）',
    '  "partnerships": string[],        // 業務提携・協業の見出し（最大6）',
    '  "mergersAcquisitions": string[]  // M&A・資本参加の見出し（最大6）',
  ],
);

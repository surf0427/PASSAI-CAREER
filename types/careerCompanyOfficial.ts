/**
 * Company Data Spine — Official Company Data（Global Layer / Company Prefetch）。
 *
 * 位置づけ:
 *   「その企業について、**出典 URL に遡れる形で**取得した公開事実」の契約。
 *   全ユーザー共有の **非個人データ**（authority: global_shared_server_authoritative）であり、
 *   localStorage canonical の対象外・`CareerSourceKind`（Personal Memory の由来 Source）にも
 *   追加しない。
 *
 * 絶対に混同しない 3 つ（型でも物理テーブルでも分ける）:
 *   1. Official Fact       — 外部の一次情報から取得した事実。**必ず source を持つ**。
 *   2. User Private Evidence — 本人の企業研究メモ（types/careerCompanyResearch.ts・localStorage 原本）。
 *   3. AI Derived          — AI が facts から導いた要約。**facts へ昇格させない**（別テーブル）。
 *
 * 既存 domain との関係（再実装しない）:
 *   - canonical company id / alias / 解決結果 : types/careerCompanyKnowledge.ts
 *   - user × company の応募文脈              : types/careerCompanyApplication.ts
 *   - Layer 5 の共有企業知見（ユーザー投稿）  : types/careerCompanyKnowledge.ts（**別 domain**）
 *
 * 本ファイルは型のみ（repo 規約）。ロジックは lib/careerCompanyOfficial/* / lib/careerCompanyPrefetch/*。
 */

import type { CompanyCanonicalId } from '@/types/careerCompanyKnowledge';

// ── Fact group（freshness policy と provider の単位）──────────────────
/**
 * 事実の鮮度特性による区分。TTL・取得 provider・prefetch 対象かがここで決まる。
 *
 * Phase 1 で実際に取得するのは `identity` / `profile` / `navigation` の 3 つだけ。
 * `ir` / `recruiting` / `news` は **契約だけ**先に固定する（将来 provider を足せる形を壊さない）。
 */
export type CompanyFactGroup =
  | 'identity' // 法人 identity（登記名 / 法人番号 / 本社 / 設立）
  | 'profile' // 会社概要（事業内容 / 規模 / 上場区分）
  | 'navigation' // 公式サイト内の入口 URL（採用 / IR / ニュース）
  | 'ir' // 決算・IR（Phase 1 では取得しない）
  | 'recruiting' // 採用・選考（Phase 1 では取得しない）
  | 'news'; // ニュース（Phase 1 では取得しない）

export const COMPANY_FACT_GROUPS: readonly CompanyFactGroup[] = [
  'identity',
  'profile',
  'navigation',
  'ir',
  'recruiting',
  'news',
];

/** Phase 1 の prefetch 対象（ここに無い group は自動取得しない）。 */
export const PREFETCH_FACT_GROUPS: readonly CompanyFactGroup[] = [
  'identity',
  'profile',
  'navigation',
];

// ── Source（出典）────────────────────────────────────────────────────
/** 出典の種別。AI 生成は **含まれない**（derived は別 domain）。 */
export type CompanySourceType =
  | 'corporate_registry' // 公的法人登記（法人番号システム等）
  | 'official_site' // 企業公式サイト
  | 'ir_document' // IR 資料
  | 'press_release' // プレスリリース
  | 'job_posting' // 採用ページ
  | 'search_result'; // 検索 provider の応答（候補発見のみ・fact の直接根拠にしない）

export const COMPANY_SOURCE_TYPES: readonly CompanySourceType[] = [
  'corporate_registry',
  'official_site',
  'ir_document',
  'press_release',
  'job_posting',
  'search_result',
];

/**
 * 1 URL = 1 件の出典。**すべての official fact はこれを 1 件必ず指す**。
 *
 * 保持しないもの: 取得した HTML 全文 / ページ本文 / user 識別子。
 *   本文は `contentHash` でのみ同一性を判定する（再取得の抑止に使う）。
 */
export type OfficialCompanySource = {
  /** 永続化後に採番される id。未永続なら null。 */
  sourceId: string | null;
  companyId: CompanyCanonicalId;
  sourceUrl: string;
  sourceType: CompanySourceType;
  /** host 部分のみ（照合・観測に使う）。 */
  sourceDomain: string;
  httpStatus: number | null;
  /** 本文の SHA-256（本文そのものは保存しない）。 */
  contentHash: string | null;
  /** ISO。取得時刻。 */
  fetchedAt: string;
  /** ISO。ページから取得できたときだけ（推測しない）。 */
  publishedAt: string | null;
};

// ── Fact（事実）──────────────────────────────────────────────────────
/**
 * 事実の値。原文の抜粋と基準日を保持し、**言い換え・要約をしない**。
 *
 * `value` は string | number | string[] のみ（自由な object を入れない）。
 */
export type CompanyFactValue = {
  value: string | number | readonly string[];
  /** 単位（'名' / '百万円' 等）。原文にあるときだけ。 */
  unit?: string;
  /** 基準日（'2026年3月31日現在' 等の原文表記）。推測しない。 */
  asOf?: string;
  /** 原文の該当箇所（≤ 400 字）。抽出値の検証と UI の根拠表示に使う。 */
  rawExcerpt?: string;
};

/**
 * 取得方法。**LLM は抽出器としてのみ使う**（生成器として使わない）。
 *   - structured_api  : 構造化 API の応答（AI 不使用・最も信頼できる）
 *   - html_structured : HTML の構造（JSON-LD / meta / table）から決定論で抽出
 *   - llm_extraction  : LLM による抽出。★ 保存前に「値が原文に実在する」ことを決定論検証する
 */
export type CompanyFactExtractionMethod =
  | 'structured_api'
  | 'html_structured'
  | 'llm_extraction';

export const COMPANY_FACT_EXTRACTION_METHODS: readonly CompanyFactExtractionMethod[] = [
  'structured_api',
  'html_structured',
  'llm_extraction',
];

/**
 * Phase 1 で扱う fact key。**列を増やさずに項目を増やせる**ようにするため EAV 形とし、
 * key は union で固定する（自由文字列を許さない＝未知 key を保存しない）。
 */
export type CompanyFactKey =
  // identity group
  | 'corporateNumber'
  | 'legalName'
  | 'legalNameKana'
  | 'legalNameEn'
  | 'headquartersPrefecture'
  | 'headquartersAddress'
  | 'foundedYear'
  | 'registrationStatus'
  // profile group
  | 'officialDomain'
  | 'officialUrl'
  | 'aboutPageUrl'
  | 'industryLabel'
  | 'businessDescription'
  | 'businessSegments'
  | 'mainProducts'
  | 'employeeCount'
  | 'capital'
  | 'listingStatus'
  | 'tickerCode'
  | 'parentCompanyName'
  | 'corporateGroupLabel'
  // navigation group
  | 'recruitUrl'
  | 'irUrl'
  | 'newsroomUrl'
  | 'midTermPlanUrl';

export const COMPANY_FACT_KEYS: readonly CompanyFactKey[] = [
  'corporateNumber',
  'legalName',
  'legalNameKana',
  'legalNameEn',
  'headquartersPrefecture',
  'headquartersAddress',
  'foundedYear',
  'registrationStatus',
  'officialDomain',
  'officialUrl',
  'aboutPageUrl',
  'industryLabel',
  'businessDescription',
  'businessSegments',
  'mainProducts',
  'employeeCount',
  'capital',
  'listingStatus',
  'tickerCode',
  'parentCompanyName',
  'corporateGroupLabel',
  'recruitUrl',
  'irUrl',
  'newsroomUrl',
  'midTermPlanUrl',
];

/** fact key → 所属 group（TTL 判定と部分成功の単位）。 */
export const COMPANY_FACT_KEY_GROUP: Readonly<Record<CompanyFactKey, CompanyFactGroup>> = {
  corporateNumber: 'identity',
  legalName: 'identity',
  legalNameKana: 'identity',
  legalNameEn: 'identity',
  headquartersPrefecture: 'identity',
  headquartersAddress: 'identity',
  foundedYear: 'identity',
  registrationStatus: 'identity',
  officialDomain: 'profile',
  officialUrl: 'profile',
  aboutPageUrl: 'profile',
  industryLabel: 'profile',
  businessDescription: 'profile',
  businessSegments: 'profile',
  mainProducts: 'profile',
  employeeCount: 'profile',
  capital: 'profile',
  listingStatus: 'profile',
  tickerCode: 'profile',
  parentCompanyName: 'profile',
  corporateGroupLabel: 'profile',
  recruitUrl: 'navigation',
  irUrl: 'navigation',
  newsroomUrl: 'navigation',
  midTermPlanUrl: 'navigation',
};

/**
 * 1 事実 = 1 件。
 *
 * ★ 不変条件: `sourceId` は **永続化時点で必ず非 null**（DDL 側も NOT NULL）。
 *   出典の無い値を official fact として保存する経路を型と DB の両方で塞ぐ。
 */
export type OfficialCompanyFact = {
  companyId: CompanyCanonicalId;
  factGroup: CompanyFactGroup;
  factKey: CompanyFactKey;
  factValue: CompanyFactValue;
  /** 出典。永続化前の中間表現では source を値で持ち、永続化時に id へ解決する。 */
  sourceId: string | null;
  extractionMethod: CompanyFactExtractionMethod;
  /** 0..1。extraction method と検証結果から決定論で導く（AI に自己申告させない）。 */
  confidence: number;
  /** ISO。 */
  fetchedAt: string;
};

/** 永続化前の中間表現（source をまだ id に解決していない）。 */
export type DraftOfficialCompanyFact = Omit<OfficialCompanyFact, 'sourceId'> & {
  /** この fact の根拠となる source の URL（同 job 内で永続化した source と突き合わせる）。 */
  sourceUrl: string;
};

// ── Derived（AI 生成物・facts とは物理的に分離）──────────────────────
export type CompanyDerivedKind = 'profile_summary' | 'research_starting_points';

/**
 * AI が facts から導いた派生情報。
 * ★ `usage` は常に `ai_derived_not_fact`。facts テーブルへは絶対に入れない。
 */
export type CompanyDerivedRecord = {
  companyId: CompanyCanonicalId;
  derivedKind: CompanyDerivedKind;
  content: string;
  /** 根拠にした fact key（トレーサビリティ）。 */
  basedOnFactKeys: readonly CompanyFactKey[];
  model: string;
  promptRevision: string;
  generatedAt: string;
};

// ── Freshness ────────────────────────────────────────────────────────
/** 鮮度分類。`missing` を `stale` と混同しない（負の証拠にしない）。 */
export type CompanyFactFreshness = 'fresh' | 'stale' | 'missing';

/** group 単位の鮮度評価結果。 */
export type CompanyFactGroupFreshness = {
  factGroup: CompanyFactGroup;
  freshness: CompanyFactFreshness;
  /** 最新の取得時刻（missing なら null）。 */
  fetchedAt: string | null;
  /** TTL 満了時刻（missing なら null）。 */
  validUntil: string | null;
  /** 経過秒（missing なら null）。 */
  ageSeconds: number | null;
};

// ── 読み出し契約（Context Orchestrator の上流）────────────────────────
/** 1 件の fact の表示用 projection（consumer が見る唯一の形）。 */
export type CompanyOfficialFactView = {
  factKey: CompanyFactKey;
  factGroup: CompanyFactGroup;
  /** 表示用に整形済みの値（配列は「、」結合。原文の言い換えはしない）。 */
  displayValue: string;
  unit: string | null;
  asOf: string | null;
  sourceUrl: string;
  sourceType: CompanySourceType;
  fetchedAt: string;
  freshness: CompanyFactFreshness;
  extractionMethod: CompanyFactExtractionMethod;
};

/**
 * consumer（企業研究 / ES / 面接 / 志望動機 / Career AI）へ渡す唯一の形。
 *
 * ★ この型は **AI 生成物を含まない**（derived は別途・別 block で渡す）。
 */
export type CompanyOfficialContext = {
  companyId: CompanyCanonicalId;
  displayName: string;
  /** 表示可能な fact（fetchedAt 新しい順・group 順で決定論に並ぶ）。 */
  facts: readonly CompanyOfficialFactView[];
  /** group 単位の鮮度（部分的に古い・部分的に欠けている状態を消さずに運ぶ）。 */
  groups: readonly CompanyFactGroupFreshness[];
  /** 参照した出典 URL の一意リスト（決定論順）。 */
  sourceUrls: readonly string[];
  /** 最も古い fact の取得時刻（asOf 表示の下限）。 */
  oldestFetchedAt: string | null;
  /** 最も新しい fact の取得時刻。 */
  newestFetchedAt: string | null;
};

/** 読み出しの status。既存 context loader の思想（empty と unavailable を混同しない）に揃える。 */
export type CompanyOfficialReadStatus =
  | 'ready' // 全対象 group が fresh
  | 'stale' // データはあるが TTL 超過（**読める**。SWR で使う）
  | 'partial' // 一部 group のみ存在（identity だけある等）
  | 'unavailable' // 取得できなかった / 未 provision / 該当なし
  | 'disabled'; // flag OFF / gate 不成立（正常な fail-closed）

export type CompanyOfficialUnavailableReason =
  | 'not_provisioned' // DDL 未適用（42P01）
  | 'no_company' // companyId が解決できていない
  | 'no_facts' // 企業はあるが fact が 1 件も無い
  | 'lookup_error';

export type CompanyOfficialDisabledReason =
  | 'flag_off'
  | 'not_configured'
  | 'unauthenticated'
  | 'not_targeted';

/**
 * 読み出し結果。**data を持てるのは ready / stale / partial のみ**（型で固定）。
 * unavailable / disabled を「情報が無いという証拠」として render できない形にする。
 */
export type CompanyOfficialReadResult =
  | { status: 'ready'; data: CompanyOfficialContext }
  | { status: 'stale'; data: CompanyOfficialContext }
  | { status: 'partial'; data: CompanyOfficialContext }
  | { status: 'unavailable'; reason: CompanyOfficialUnavailableReason }
  | { status: 'disabled'; reason: CompanyOfficialDisabledReason };

/** data を持つ status のみ絞り込む type guard（consumer の唯一の data 取得口）。 */
export function hasCompanyOfficialData(
  r: CompanyOfficialReadResult,
): r is Extract<CompanyOfficialReadResult, { data: CompanyOfficialContext }> {
  return r.status === 'ready' || r.status === 'stale' || r.status === 'partial';
}

// ── テーブル名（drift 防止のため 1 箇所で定義）────────────────────────
export const CAREER_COMPANY_OFFICIAL_TABLES = {
  sources: 'career_company_sources',
  facts: 'career_company_official_facts',
  derived: 'career_company_derived',
  jobs: 'career_company_enrichment_jobs',
} as const;

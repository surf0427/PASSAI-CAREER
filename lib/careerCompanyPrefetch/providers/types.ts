/**
 * Company Prefetch — provider 契約（pure 型 + 純関数のみ。I/O を持たない）。
 *
 * なぜ interface を切るか:
 *   Identity resolution と Company research では **最適な取得方式が違う**。
 *     - Identity  : 決定論的な registry 照合（公的法人登記）。AI を使わない。
 *     - Research  : 検索 + 公式サイト取得 + 抽出。
 *   さらに provider（検索 API / 企業 DB SaaS / 公的 API）は将来差し替わる。
 *   route / job service が特定 provider に直接依存すると差し替えが全経路に波及するため、
 *   本ファイルの interface だけに依存させる。
 *
 * 全 provider の共通契約:
 *   - **never-throw**（失敗は結果型で返す）
 *   - 固定 enum の失敗理由のみ（provider の raw message を外へ出さない）
 *   - 呼び出し側は「取れなかった」と「該当が無い」を区別できる
 */

import type { CompanySourceType } from '@/types/careerCompanyOfficial';

// ── 共通 ─────────────────────────────────────────────────────────────
/** provider 呼び出しの失敗理由（固定 enum）。 */
export type ProviderFailure =
  | 'not_configured' // 必要な env（endpoint / API key）が無い → 呼ばない
  | 'disabled' // 外部取得 flag が OFF
  | 'timeout'
  | 'rate_limited'
  | 'provider_error' // 5xx / 想定外レスポンス
  | 'blocked_url' // SSRF guard で弾かれた
  | 'parse_error'; // 応答は返ったが契約どおりに読めない（★ 誤読して保存しない）

/** provider が取得した「生の出典」（永続化前）。 */
export type ProviderSourceRef = {
  sourceUrl: string;
  sourceType: CompanySourceType;
  sourceDomain: string;
  httpStatus: number | null;
  contentHash: string | null;
  fetchedAt: string;
  publishedAt: string | null;
};

// ── Identity provider（公的 registry）─────────────────────────────────
/**
 * registry から得た 1 法人の候補。
 * ★ ここに載る値はすべて **registry 由来の一次情報**であり、AI は一切関与しない。
 */
export type RegistryCompanyCandidate = {
  /** 法人番号（13 桁）。名寄せの真の一意キー。 */
  corporateNumber: string;
  /** 登記上の商号。 */
  legalName: string;
  legalNameKana: string | null;
  legalNameEn: string | null;
  prefecture: string | null;
  address: string | null;
  /** 登記の状態（存続 / 閉鎖など。registry の原文表記）。 */
  registrationStatus: string | null;
  /** 過去の商号（変更履歴）。alias（historical_name）へ流し込む。 */
  formerNames: readonly string[];
};

/**
 * registry 照合の結果。
 *
 * ★ `ambiguous` を `resolved` へ昇格させない（既存 Company Identity と同じ不変条件）。
 *   1 社に絞れないなら、profile enrichment へは進ませない。
 */
export type RegistryLookupResult =
  | { status: 'resolved'; candidate: RegistryCompanyCandidate; source: ProviderSourceRef }
  | { status: 'ambiguous'; candidates: readonly RegistryCompanyCandidate[]; source: ProviderSourceRef }
  | { status: 'unresolved'; source: ProviderSourceRef | null }
  | { status: 'failed'; reason: ProviderFailure };

export interface CorporateRegistryProvider {
  /** provider 名（観測用。secret を含めない）。 */
  readonly name: string;
  /** 必要な env が揃っているか（揃っていなければ呼ばない＝I/O ゼロ）。 */
  isConfigured(): boolean;
  /** free-text 企業名から法人を照合する。never-throw。 */
  lookupByName(rawName: string): Promise<RegistryLookupResult>;
}

// ── Search provider（official domain discovery 用）────────────────────
export type SearchHit = {
  url: string;
  title: string;
  snippet: string;
};

export type SearchResult =
  | { status: 'ok'; hits: readonly SearchHit[]; source: ProviderSourceRef }
  | { status: 'empty'; source: ProviderSourceRef | null }
  | { status: 'failed'; reason: ProviderFailure };

export interface CompanySearchProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** 企業の公式サイト候補を探す。**「1 位だから公式」とは扱わない**（呼び出し側が検証する）。 */
  searchOfficialSite(query: string): Promise<SearchResult>;
}

// ── Official site provider（会社概要の取得 + 抽出）─────────────────────
/**
 * 公式サイトから取得できた素材。
 * ★ HTML 全文は返さない（呼び出し側が保存しないようにするため、text へ落として上限を掛ける）。
 */
export type OfficialSiteDocument = {
  url: string;
  /** タグ除去済みの本文テキスト（上限適用済み）。 */
  text: string;
  /** <title> の内容（domain 検証に使う）。 */
  title: string;
  /** ページ内で見つかった絶対 URL（採用 / IR / ニュース の入口検出に使う）。 */
  links: readonly { href: string; label: string }[];
  source: ProviderSourceRef;
};

export type OfficialSiteFetchResult =
  | { status: 'ok'; document: OfficialSiteDocument }
  | { status: 'failed'; reason: ProviderFailure };

export interface OfficialSiteProvider {
  readonly name: string;
  isConfigured(): boolean;
  fetchDocument(url: string): Promise<OfficialSiteFetchResult>;
}

/** provider 一式（job service は個別 provider ではなくこの束に依存する）。 */
export type CompanyPrefetchProviders = {
  registry: CorporateRegistryProvider;
  search: CompanySearchProvider;
  site: OfficialSiteProvider;
};

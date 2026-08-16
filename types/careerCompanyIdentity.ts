/**
 * Company Data Spine — Company Identity (L0) の boundary 型（Phase A / R1）。
 *
 * 位置づけ:
 *   企業を一意に指す `companyId` を canonical key として導入するための **境界型のみ**。
 *   企業判定ロジック（正規化 / 解決 / alias 衝突 / 旧社名 / 統合候補）は
 *   **既存の `lib/careerCompanyKnowledge/identity.ts` を再利用**する（再実装しない）。
 *   本ファイルは「API 境界で必要な形」だけを足す。
 *
 * 絶対に守ること:
 *   - `companyId` は **追加情報**。既存の free-text `companyName` を置換・削除しない。
 *   - `ambiguous` を勝手に `resolved` へ変換しない（型で候補のまま運ぶ）。
 *   - Company Identity は **個人データではない**（下記 authority class 参照）。
 *   - Layer 5 Community（contribution / moderation / consent）へは一切接続しない。
 */

import type { CompanyCanonicalId } from '@/types/careerCompanyKnowledge';

// ── Authority class ────────────────────────────────────────────────
/**
 * Company Identity / 将来の Official Facts の権威区分。
 *
 * 既存 `CareerSourceAuthorityClass`（lib/careerSourceData/types.ts）は
 *   - `device_canonical_mirrored`（localStorage canonical + Supabase mirror）
 *   - `server_authoritative`（server 著作・**owner-scoped**）
 * の 2 つで、**どちらも個人データ**を前提にしている。
 *
 * 企業マスタは「server 著作かつ全ユーザー共有の非個人データ」であり、どちらにも当てはまらない。
 * そのため第 3 の区分を **本ファイルに独立して**定義する。
 *
 * ★ 重要: この区分を `CareerSourceKind` / `CAREER_SOURCE_AUTHORITY` に追加してはいけない。
 *   `CareerSourceKind` は **Personal Memory（Layer 2）の由来 Source** の語彙であり、
 *   企業マスタは Personal Memory の source ではない（個人の投影元ではない）。
 */
export type CareerCompanySpineAuthorityClass = 'global_shared_server_authoritative';

export const CAREER_COMPANY_SPINE_AUTHORITY: CareerCompanySpineAuthorityClass =
  'global_shared_server_authoritative';

/** Company Identity が使う production table 名（DDL と一致させる）。 */
export const CAREER_COMPANY_IDENTITY_TABLES = {
  master: 'career_company_master',
  aliases: 'career_company_aliases',
} as const;

// ── 企業参照（既存ログへ optional で足す形）──────────────────────────
/**
 * 既存機能のログ / draft / target が企業を指すときの参照形。
 *
 * `companyName` は **既存フィールドをそのまま維持**するための free-text。
 * `companyId` は登録済み企業を選んだときにだけ付く追加情報（欠損が正常）。
 */
export type CareerCompanyRef = {
  companyId?: string;
  companyName?: string;
};

// ── Resolver API 境界 ───────────────────────────────────────────────
/** 候補 1 件（表示に必要な最小形）。内部 record 全体を client へ出さない。 */
export type CompanyResolveCandidate = {
  companyId: CompanyCanonicalId;
  displayName: string;
};

/**
 * 企業名解決の結果（API 境界形）。
 *
 * 既存 `CompanyIdentityResolution` は `ambiguous` の候補を **ID のみ**で持つため、
 * 表示用に displayName を添えた形を境界で用意する（判定自体は既存純関数が行う）。
 *
 * ★ `unresolved` の `suggestions` は「部分一致した参考候補」であり、
 *   **解決結果ではない**。UI はこれを自動選択してはいけない。
 */
export type CompanyResolveResult =
  | {
      status: 'resolved';
      companyId: CompanyCanonicalId;
      displayName: string;
      matchedAlias: string | null;
    }
  | { status: 'ambiguous'; candidates: readonly CompanyResolveCandidate[] }
  | { status: 'unresolved'; suggestions: readonly CompanyResolveCandidate[] };

/** Company Identity を利用できない理由（fail-open で free-text へ倒すための区分）。 */
export type CompanyIdentityDisabledReason =
  | 'flag_off' // feature flag 未設定
  | 'not_configured' // Supabase env 未設定
  | 'unauthenticated' // 未ログイン（匿名を含む）
  | 'lookup_error'; // 取得失敗

/**
 * Resolver / lookup / register の共通レスポンス外皮。
 *
 * ★ `available:false` でも HTTP 200 を返す。呼び出し側（CompanyPicker）は
 *   これを「free-text へ倒す」合図として扱い、既存機能を止めない。
 */
export type CompanyIdentityEnvelope<T> =
  | { available: true; data: T }
  | { available: false; reason: CompanyIdentityDisabledReason };

/**
 * 登録結果（Phase 1 で union 化）。
 *
 * - `registered` : 新規作成（`created:true`）または既存企業へ寄せた（`created:false`）。
 *   同一 normalized 企業が既にあれば **新規作成せず** `created:false` で既存 ID を返す。
 *   ★ この「既存」判定は `normalized_name` だけでなく **alias も含む**（Phase 1）。
 * - `ambiguous`  : 入力名（または別表記）が **複数社**に一致した。★ 勝手に確定しない。
 *   UI は候補を提示してユーザーに選ばせること（自動選択したら invariant 違反）。
 *
 * `ambiguous` は「同じ alias を持つ別法人」が存在しうるため必要になる
 * （例: ブランド名・グループ名・地域法人。DB 制約で一律禁止すると誤 merge 相当になる）。
 */
export type CompanyRegisterResult =
  | {
      status: 'registered';
      companyId: CompanyCanonicalId;
      displayName: string;
      created: boolean;
    }
  | { status: 'ambiguous'; candidates: readonly CompanyResolveCandidate[] };

// ── ローカル表示キャッシュ ───────────────────────────────────────────
/**
 * 端末に持つ「最近使った企業」の **表示キャッシュ**。
 *
 * ★ canonical ではない（canonical は server の企業マスタ）。
 *   companyId → displayName を offline でも描けるようにするためだけの derived cache で、
 *   失われても CompanyPicker / 各機能の動作に影響しない（再取得できる）。
 *   新しい truth store ではない。
 */
export type CareerCompanyDirectoryEntry = {
  companyId: CompanyCanonicalId;
  displayName: string;
  /** 最後にこの企業を選択した時刻（ISO）。並び順にだけ使う。 */
  lastUsedAt: string;
};

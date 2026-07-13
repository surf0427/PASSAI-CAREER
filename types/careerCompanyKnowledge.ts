/**
 * Company Knowledge Base (Layer 5) — domain **contract types**（P17-A §6）。
 *
 * 位置づけ（production 非接続・offline foundation）:
 *   「明示共有され・審査・構造化された企業集合知」を将来他ユーザーへ還元するための型契約を
 *   先に固定する。本 series では DB / API / UI / prompt / 実投稿へは接続しない。
 *
 * 重要な分離（絶対）:
 *   - private owner-scoped company research（types/careerCompanyResearch.ts・localStorage 原本）とは
 *     **独立 domain**。private の型を流用せず、自動昇格もしない。
 *   - contributor identity（氏名 / email / 大学 / 応募 ID / auth user id）を **保持しない**。
 *     撤回 / dedup 用の opaque key は内部専用（`__` prefix）で public/read projection へ出さない。
 *   - ユーザー体験談を企業の確定事実へ変換しない（evidenceKind で区別）。
 *
 * 本ファイルは型のみ（repo 規約）。ロジックは lib/careerCompanyKnowledge/*。
 */

// ── Company identity ────────────────────────────────────────────────
/** 正規化済み canonical company id（synthetic。外部企業 DB は使わない）。 */
export type CompanyCanonicalId = string;

export type CompanyMasterRecord = {
  companyId: CompanyCanonicalId;
  displayName: string;
  /** 正規化名（大小・法人格・空白除去後）。alias collision 検出に使う。 */
  normalizedName: string;
  aliases: readonly string[];
  /** 企業グループ参照（親会社 / グループ持株）。無ければ null。 */
  corporateGroupId: string | null;
};

/**
 * free-text 企業名 → identity 解決結果。
 * free-text を即座に確定 ID へ変換せず、ambiguous / unresolved を型で表現する。
 */
export type CompanyIdentityResolution =
  | { status: 'resolved'; companyId: CompanyCanonicalId; displayName: string; matchedAlias: string | null }
  | { status: 'ambiguous'; candidates: readonly CompanyCanonicalId[] }
  | { status: 'unresolved' };

/** alias collision（同一 alias が複数 company を指す）検出結果。 */
export type AliasCollision = {
  alias: string; // normalized
  companyIds: readonly CompanyCanonicalId[];
};

// ── Evidence 分類 ───────────────────────────────────────────────────
/** evidence の性質（公式 / 企業提供 / 体験談 / 要約）。体験談を事実化しない。 */
export type CompanyEvidenceKind =
  | 'official'
  | 'company_provided'
  | 'user_experience'
  | 'inferred_summary';

/** 内容カテゴリ（ES 設問 / 面接設問 / 選考フロー / 説明会メモ / 求める人物像 / 一般メモ）。 */
export type CompanyContentCategory =
  | 'es_question'
  | 'interview_question'
  | 'selection_flow'
  | 'briefing_note'
  | 'desired_candidate_profile'
  | 'general_note';

/** source 区分（自己体験 / 公開公式 / 企業公式 / 伝聞）。 */
export type CompanySourceCategory =
  | 'self_experience'
  | 'public_official'
  | 'company_official'
  | 'secondhand';

/** 選考区分（インターン / 本選考）。 */
export type SelectionCategory = 'internship' | 'full_time' | 'unknown';

/** 職種区分（role / occupation）。 */
export type RoleCategory =
  | 'engineering'
  | 'sales'
  | 'corporate'
  | 'research'
  | 'consulting'
  | 'other'
  | 'unknown';

// ── Explicit-share consent（personal processing とは別）─────────────────
/**
 * 企業集合知への明示共有状態。default は not_shared（private のまま）。
 * share_granted のみが「他ユーザーへ還元可能な候補」に入る（自動昇格はしない）。
 */
export type CompanyKnowledgeConsentState =
  | 'not_shared'
  | 'share_requested'
  | 'share_granted'
  | 'share_revoked';

// ── Moderation / Privacy / Confidentiality ─────────────────────────────
export type ModerationState = 'pending' | 'approved' | 'rejected' | 'blocked';
/** PII scan 状態。not_scanned を安全と見なさない（fail-closed）。 */
export type PiiScanState = 'not_scanned' | 'clean' | 'pii_detected';
/** 秘密情報リスク。unknown を safe と見なさない（fail-closed）。 */
export type ConfidentialityRiskState = 'unknown' | 'low' | 'elevated' | 'restricted';
export type AbuseReportState = 'none' | 'reported' | 'upheld';

export type ModerationRejectionReason =
  | 'contains_pii'
  | 'confidential_information'
  | 'defamatory'
  | 'off_topic'
  | 'unverifiable'
  | 'spam'
  | 'legal_hold';

export type ContributionModeration = {
  state: ModerationState;
  piiScan: PiiScanState;
  confidentiality: ConfidentialityRiskState;
  abuse: AbuseReportState;
  /** rejected / blocked のときの理由（それ以外は null）。 */
  rejectionReason: ModerationRejectionReason | null;
};

// ── Freshness ───────────────────────────────────────────────────────
export type FreshnessClassification = 'fresh' | 'aging' | 'stale' | 'unknown';

// ── Contribution record（内部保持形）─────────────────────────────────
/**
 * 1 件の企業知見 contribution（内部形）。
 * projection へ出さない内部専用 key は `__` prefix（contributor opaque key / content fingerprint）。
 * contributor 実体情報（氏名 / email / 大学 / 応募 ID / auth user id）は **型に存在しない**。
 */
export type CompanyKnowledgeContribution = {
  contributionId: string;
  /** 企業解決結果（ambiguous / unresolved の可能性を保持）。 */
  company: CompanyIdentityResolution;
  contentCategory: CompanyContentCategory;
  sourceCategory: CompanySourceCategory;
  evidenceKind: CompanyEvidenceKind;
  /** 観測時期（必須）。'2026' / '2026-spring' 等の粗い粒度。 */
  observedPeriod: string;
  selectionCategory: SelectionCategory;
  roleCategory: RoleCategory;
  /** 構造化された短い要約（本文全文・PII・投稿者情報を含めない）。 */
  bodySummary: string;
  consentState: CompanyKnowledgeConsentState;
  /** 投稿時刻相当（ISO・粗粒度）。 */
  submittedAt: string;
  moderation: ContributionModeration;
  provenanceNote: string | null;
  privacyClassification: 'shared_company_knowledge';
  /** 内部専用: 撤回 / dedup 用の匿名 opaque key。projection へ出さない。 */
  __contributorOpaqueKey: string;
  /** 内部専用: dedup 用の content fingerprint。projection へ出さない。 */
  __contentFingerprint: string;
  /** logical exclusion（revoke 相当）。true は read されない。 */
  __excluded?: boolean;
};

// ── Dedup / Conflict ────────────────────────────────────────────────
export type DedupRelation =
  | 'exact_duplicate'
  | 'probable_duplicate'
  | 'independent_corroboration'
  | 'conflicting'
  | 'unrelated';

/** conflict は自動統合しない。unresolved のまま保持する。 */
export type ConflictResolution = 'unresolved';

// ── Confidence 根拠 ─────────────────────────────────────────────────
/** confidence の根拠（数値だけでなく由来を保持する）。 */
export type ConfidenceBasis = {
  value: number; // 0..1
  corroborationCount: number; // 独立裏付け件数
  evidenceKind: CompanyEvidenceKind;
  freshness: FreshnessClassification;
  /** 単一投稿は general trend として扱わない（表示側の抑止フラグ）。 */
  singleReport: boolean;
};

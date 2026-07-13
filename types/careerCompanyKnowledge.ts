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
  // ── P17-B 追加（すべて optional・後方互換）─────────────────────────
  /** 登記上の正式名称（display と別管理）。 */
  legalName?: string;
  /** 過去社名（現在名で上書きせず履歴保持）。 */
  historicalNames?: readonly string[];
  /** 親法人 / 子法人参照（corporate group と単一法人を混同しない）。 */
  parentId?: CompanyCanonicalId | null;
  subsidiaryIds?: readonly CompanyCanonicalId[];
  /** identity version（社名変更・統合で増える）。 */
  identityVersion?: number;
  /** この identity version の有効期間（ISO・null は現行）。 */
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};

/** identity の統合 / 分割候補（自動確定しない・人手 review 前提）。 */
export type CompanyIdentityAdjustment =
  | { kind: 'merge_candidate'; companyIds: readonly CompanyCanonicalId[]; reason: string }
  | { kind: 'split_candidate'; companyId: CompanyCanonicalId; reason: string };

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
  // ── P17-B 追加（すべて optional・後方互換）─────────────────────────
  /** lifecycle 状態。設定時は published のみ read 対象（未設定は P17-A の gate に従う）。 */
  lifecycleState?: ContributionLifecycleState;
  /** legal hold（true は read 除外・invalidation 対象）。 */
  legalHold?: boolean;
  /** contribution version（改訂で増える）。 */
  version?: number;
  /** この contribution を supersede した後継 id（履歴 lineage）。 */
  supersededBy?: string | null;
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

// ════════════════════════════════════════════════════════════════════
// P17-B additions — lifecycle / consent snapshot / PII / evidence / version
// ════════════════════════════════════════════════════════════════════

// ── Contribution lifecycle（offline state machine）─────────────────────
export type ContributionLifecycleState =
  | 'draft'
  | 'consent_pending'
  | 'submitted'
  | 'privacy_review'
  | 'moderation_pending'
  | 'approved'
  | 'published'
  | 'rejected'
  | 'revoked'
  | 'blocked'
  | 'legal_hold'
  | 'expired';

export type ContributionLifecycleAction =
  | 'submit'
  | 'grant_consent'
  | 'withdraw'
  | 'start_privacy_review'
  | 'pass_privacy_review'
  | 'fail_privacy_review'
  | 'start_moderation'
  | 'approve'
  | 'reject'
  | 'publish'
  | 'revoke'
  | 'block'
  | 'legal_hold'
  | 'release_legal_hold'
  | 'expire';

export type LifecycleTransitionResult =
  | { ok: true; from: ContributionLifecycleState; to: ContributionLifecycleState }
  | { ok: false; from: ContributionLifecycleState; reason: LifecycleRejectReason };

export type LifecycleRejectReason =
  | 'invalid_transition'
  | 'consent_required'
  | 'privacy_review_incomplete'
  | 'moderation_incomplete'
  | 'terminal_state';

/** transition の audit（決定的・identity を持たない）。 */
export type LifecycleAuditEntry = {
  contributionId: string;
  action: ContributionLifecycleAction;
  from: ContributionLifecycleState;
  to: ContributionLifecycleState;
  at: string; // ISO
  actorClass: ConsentActorClass;
};

// ── Explicit-share consent snapshot（Layer 5 専用・offline）─────────────
export type ConsentActorClass = 'contributor' | 'moderator' | 'system' | 'legal';

/** commercial 可否・consent text は仮決定せず PROVISIONAL/未確定として保持。 */
export type CompanyKnowledgeConsentSnapshot = {
  contributionId: string;
  scope: 'company_knowledge_contribution';
  policyVersion: number;
  grantedAt: string | null; // ISO
  revokedAt: string | null; // ISO
  consentSource: 'explicit_ui' | 'imported_optin' | 'unknown';
  actorClass: ConsentActorClass;
  /** 許可された用途（PROVISIONAL）。 */
  permittedUses: readonly string[];
  /** 禁止された用途（commercial 等・確定していないものは含めない）。 */
  prohibitedUses: readonly string[];
  /** snapshot 版（revoke / 再取得で増える。lineage 追跡）。 */
  snapshotVersion: number;
};

export type ConsentEffectiveState = 'granted' | 'revoked' | 'never_granted';

// ── Offline PII / confidentiality（expanded・fail-closed）───────────────
export type PiiScanStateExpanded =
  | 'not_scanned'
  | 'clean'
  | 'suspected'
  | 'confirmed'
  | 'scan_failed';

export type ConfidentialityLevel = 'unknown' | 'low' | 'medium' | 'high' | 'prohibited';

export type PiiFindingKind =
  | 'email'
  | 'phone'
  | 'url_identifier'
  | 'application_id'
  | 'name_label'
  | 'university_plus_name'
  | 'employee_name'
  | 'interviewer_name'
  | 'confidential_marker';

export type PiiFinding = {
  kind: PiiFindingKind;
  /** 一致した箇所の粗い痕跡（raw 全文は保持しない・種別 + 位置のみ）。 */
  excerptHint: string;
  /** confirmed（確度高）か suspected（安全側で検出）か。 */
  severity: 'suspected' | 'confirmed';
};

export type PiiScanResult = {
  state: PiiScanStateExpanded;
  confidentiality: ConfidentialityLevel;
  findings: readonly PiiFinding[];
  /** publish 可否（medium/high/prohibited / suspected/confirmed は不可）。 */
  publishable: boolean;
};

// ── Evidence aggregation / trend eligibility ───────────────────────────
export type CorroborationBucket = 'single' | 'few' | 'several' | 'many';

export type EvidenceGroupKey = {
  companyId: CompanyCanonicalId;
  contentCategory: CompanyContentCategory;
  selectionCategory: SelectionCategory;
  roleCategory: RoleCategory;
};

export type TrendEligibility =
  | { eligible: true; bucket: CorroborationBucket }
  | { eligible: false; reason: 'single_report' | 'insufficient_independent' | 'conflicting' };

export type AggregatedEvidenceGroup = {
  key: EvidenceGroupKey;
  /** 独立 contributor 数の bucket（生 count を出さない）。 */
  corroboration: CorroborationBucket;
  independentContributorCount: number; // 内部判定用（projection へは bucket のみ）
  officialCount: number;
  userExperienceCount: number;
  hasConflict: boolean;
  observedPeriods: readonly string[];
  freshness: FreshnessClassification;
  trend: TrendEligibility;
  /** group 内の代表 contribution id（決定論）。 */
  representativeId: string;
  memberIds: readonly string[];
};

// ── Version / freshness / history ─────────────────────────────────────
export type CompanyKnowledgeStaleReason =
  | 'observed_period_old'
  | 'superseded'
  | 'policy_version_changed'
  | 'revoked';

export type ContributionRevision = {
  contributionId: string;
  version: number;
  generatedAt: string; // ISO
  observedPeriod: string;
  supersedes: string | null;
  supersededBy: string | null;
  staleReason: CompanyKnowledgeStaleReason | null;
};

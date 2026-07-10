/**
 * Consent Ledger domain — versioned append-only consent の **型定義**（P14-C）。
 *
 * 位置づけ（P14-A decision C / P14-B の後続・production 非接続）:
 *   P14-B は pure な eligibility 契約のみを固定した。P14-C はその source of truth となる
 *   **append-only Consent Ledger** の domain model / 状態遷移 / repository 契約を production 非接続で固定する。
 *   本ファイルは型のみ（repo 規約: 型は types/）。ロジックは lib/careerConsent/*。
 *
 * source of truth 原則:
 *   - mutable な現在値 boolean を唯一の真実にしない。**append-only event 列**を正とし、
 *     現在状態は reducer で導出する。
 *   - user_id / ledger event id / idempotency key / server sequence / exact timestamp / actor 詳細は
 *     ledger 内部専用。Aggregated Insight artifact や consent receipt へ流さない。
 *   - Layer 5（company_knowledge_contribution）は Layer 4 consent へ流用しない。
 *
 * production 非接続（P14-C 禁止範囲）: DB / SQL / migration / RLS / API / UI / Supabase / service-role /
 *   localStorage を source of truth にする処理 / matching 接続 / AI 接続 は作らない。
 */

import type { ConsentScope } from '@/types/careerAggregate';

// re-export（consumer が careerAggregate を再 import せず scope 語彙を扱えるよう）。
export type { ConsentScope };

/** ledger event の action 種別（不要に増やさない）。 */
export type ConsentAction =
  | 'consent_granted'
  | 'consent_withdrawn'
  | 'consent_reconfirmed'
  | 'consent_policy_superseded'
  | 'account_deletion_requested'
  | 'account_deleted';

/** 誰が記録したか（自由記述 actor 詳細は保存しない）。 */
export type ConsentActorType = 'user' | 'system' | 'legal' | 'import';

/** account 系 event 用の subject-level sentinel scope。 */
export const ACCOUNT_SCOPE = 'account' as const;
export type LedgerScope = ConsentScope | typeof ACCOUNT_SCOPE;

export type LegalReviewMarker = 'LEGAL_REVIEW_REQUIRED';

/**
 * append-only ledger event。**内部専用 field を含む**（receipt / aggregate へは出さない）。
 * consent copy は本文を複製せず version / digest で参照する。
 */
export type ConsentLedgerEvent = {
  /** 内部専用: ledger event ID。 */
  ledgerEventId: string;
  /** 内部専用: subject user ID。 */
  subjectUserId: string;
  scope: LedgerScope;
  action: ConsentAction;
  /** grant / reconfirm に必須の同意 version（数値）。account/withdrawal では null 可。 */
  consentVersion: number | null;
  /** notice version（copy は本文複製せず参照）。 */
  noticeVersion: string | null;
  /** policy digest（copy の同一性参照）。 */
  policyDigest: string | null;
  /** 内部専用: server-authoritative な順序。subject 内で単調増加。 */
  serverSequence: number;
  /** 内部専用: server 生成の記録時刻（ISO）。 */
  recordedAt: string;
  /** 効力発生時刻（ISO）。未来日・不正値は拒否。 */
  effectiveAt: string;
  /** 記録元 surface のラベル（PII なし・enum 相当）。 */
  sourceSurface: string;
  /** 内部専用: idempotency key（subject + scope + operation 単位）。 */
  idempotencyKey: string;
  actorType: ConsentActorType;
  legalReviewMarker?: LegalReviewMarker | null;
  provenance?: string;
};

/** ledger event の内部専用 field（receipt / aggregate へ出してはいけない key）。 */
export const LEDGER_INTERNAL_ONLY_FIELDS: readonly string[] = [
  'ledgerEventId',
  'subjectUserId',
  'serverSequence',
  'recordedAt',
  'idempotencyKey',
];

// ── Policy manifest ────────────────────────────────────────────────
export type PolicyStatus = 'PROVISIONAL' | 'FIXED';
export type LegalReviewStatus = 'REQUIRED' | 'NOT_REQUIRED' | 'PENDING';

/** scope 単位の現在必要 policy（version は scope 単位）。 */
export type ConsentPolicyManifestEntry = {
  scope: ConsentScope;
  /** eligibility 照合に使う数値 version（P14-B の requiredVersion と整合）。 */
  requiredVersion: number;
  /** 法的 version と誤解されないための development policy 識別子。 */
  developmentVersion: string;
  noticeVersion: string;
  purposeSummaryVersion: string;
  policyDigest: string;
  effectiveFrom: string; // ISO
  status: PolicyStatus;
  legalReview: LegalReviewStatus;
  /** optional（任意 opt-in） or required。aggregate scope は optional。 */
  optionality: 'optional' | 'required';
  /** 通常機能アクセスが本 scope に依存するか（aggregate は false）。 */
  normalFeatureAccessDependency: boolean;
  /** grant 前の過去データ backfill 方針（既定 prohibited）。 */
  historicalBackfill: 'prohibited' | 'explicit_scope_required';
  /** aggregate audience（該当しない scope は null）。 */
  aggregateAudience: 'internal' | 'user_facing' | 'ai_context' | null;
  /** これらの version は superseded（reconsent が必要）。 */
  supersededVersions: readonly number[];
  /** Layer 4 で利用可能な scope か（Layer 5 は false）。 */
  usableInLayer4: boolean;
};

export type ConsentPolicyManifest = Record<ConsentScope, ConsentPolicyManifestEntry>;

// ── Reducer state ──────────────────────────────────────────────────
export type ConsentStateStatus =
  | 'never_granted'
  | 'active'
  | 'withdrawn'
  | 'version_outdated'
  | 'account_deletion_pending'
  | 'account_deleted'
  | 'invalid_ledger';

/** reducer が導出する scope 単位の現在状態。 */
export type ScopeConsentState = {
  scope: ConsentScope;
  status: ConsentStateStatus;
  consentVersion: number | null;
  noticeVersion: string | null;
  grantedAt: string | null; // 最新有効 grant の effectiveAt
  withdrawnAt: string | null;
  lastUpdatedAt: string | null;
  reconsentRequired: boolean;
  requiredVersion: number;
};

/** subject 全 scope の導出状態 + account 全体状態。 */
export type DerivedConsentState = {
  subjectPresent: boolean;
  accountStatus: 'active' | 'deletion_pending' | 'deleted';
  invalidLedger: boolean;
  byScope: Record<ConsentScope, ScopeConsentState>;
};

// ── Consent receipt（本人向け・public view model）──────────────────
export type ConsentReceiptEntry = {
  scope: ConsentScope;
  status: ConsentStateStatus;
  consentVersion: number | null;
  noticeVersion: string | null;
  grantedAt: string | null;
  withdrawnAt: string | null;
  lastUpdatedAt: string | null;
  sourceSurface: string | null;
  legalReviewStatus: LegalReviewStatus;
  currentPolicyVersion: string; // developmentVersion
  reconsentRequired: boolean;
  normalFeaturesUnaffected: true;
};

export type ConsentReceipt = {
  entries: ConsentReceiptEntry[];
  accountStatus: DerivedConsentState['accountStatus'];
};

/** receipt へ出してはいけない内部専用 field。 */
export const RECEIPT_FORBIDDEN_FIELDS: readonly string[] = [
  'ledgerEventId',
  'idempotencyKey',
  'serverSequence',
  'subjectUserId',
  'recordedAt',
  'actorId',
  'ip',
  'deviceFingerprint',
];

// ── Idempotency / ordering ─────────────────────────────────────────
export type IdempotencyClassification = 'new' | 'duplicate' | 'conflict';

export type OrderingIssue =
  | 'duplicate_sequence'
  | 'conflicting_sequence'
  | 'non_finite_sequence'
  | 'future_effective_timestamp'
  | 'invalid_effective_timestamp';

export type OrderingValidation = {
  ok: boolean;
  issues: OrderingIssue[];
};

// ── Ledger event build result ──────────────────────────────────────
export type LedgerEventRejectReason =
  | 'unknown_action'
  | 'missing_scope'
  | 'missing_version'
  | 'missing_policy_digest'
  | 'missing_notice_version'
  | 'missing_server_sequence'
  | 'invalid_effective_timestamp'
  | 'prohibited_evidence_field';

export type LedgerEventBuildResult =
  | { ok: true; event: ConsentLedgerEvent }
  | { ok: false; reason: LedgerEventRejectReason };

// ── Aggregate eligibility adapter result ───────────────────────────
/** P14-B eligibility を ledger-derived state から呼んだ結果（ledger 由来 status も返す）。 */
export type LedgerEligibilityResult = {
  eligible: boolean;
  /** P14-B の status か、ledger 固有の理由。 */
  status: string;
  requiredScope: ConsentScope;
  ledgerStatus: ConsentStateStatus;
};

// ── Impact plans ───────────────────────────────────────────────────
export type WithdrawalImpactAction =
  | 'stop_future_use'
  | 'exclude_events_after_effective_at'
  | 'recompute_open_buckets'
  | 'invalidate_cached_aggregates'
  | 'stop_ai_context_use'
  | 'stop_user_facing_use'
  | 'historical_aggregate_legal_review'
  | 'no_action_required';

export type AccountDeletionImpactAction =
  | 'stop_new_consent_grant'
  | 'deactivate_all_aggregate_scopes'
  | 'stop_future_event_eligibility'
  | 'request_raw_event_deletion'
  | 'recompute_open_buckets'
  | 'invalidate_cached_aggregates'
  | 'stop_ai_context_use'
  | 'consent_ledger_retention_legal_review'
  | 'aggregate_recompute_legal_review'
  | 'reregistration_is_separate_subject';

export type ImpactPlan<TAction extends string> = {
  /** 技術的に確定する必須アクション。 */
  technicalActions: TAction[];
  /** 法務確認が必要な項目（コードで断定しない）。 */
  legalReviewItems: string[];
};

export type WithdrawalImpactPlan = ImpactPlan<WithdrawalImpactAction>;
export type AccountDeletionImpactPlan = ImpactPlan<AccountDeletionImpactAction>;

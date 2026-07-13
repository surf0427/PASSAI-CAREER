/**
 * Data Spine — Layer 4 / 5 共通 production-readiness governance contract（P17-B §C・§12）。
 *
 * 位置づけ（production 非接続・offline foundation）:
 *   Layer 4 aggregate と Layer 5 company knowledge の双方が、将来 production 接続時に
 *   「生成 / 検証 / privacy / publish / freshness / lineage / invalidation / rollback」を
 *   一貫した状態と audit で扱えるよう、**型と変換規則**を先に固定する。
 *
 * 本ファイルは型のみ（repo 規約）。変換ロジックは lib/careerDataGovernance/*。
 * production 非接続: DB / cron / monitoring service / 実データへ接続しない。
 */

import type {
  ContextSourceBlockedReason,
  ContextSourceStaleReason,
  ContextSourceUnavailableReason,
} from '@/types/careerContextSource';

// ── 各状態軸 ─────────────────────────────────────────────────────────
export type GenerationState = 'pending' | 'generating' | 'generated' | 'failed';
export type PublishState = 'unpublished' | 'published' | 'withdrawn';
export type ValidationState = 'unvalidated' | 'valid' | 'invalid';
/** privacy review。not_reviewed / failed は fail-closed（serve しない）。 */
export type PrivacyReviewState = 'not_reviewed' | 'passed' | 'failed';
export type GovernanceFreshnessState = 'fresh' | 'aging' | 'stale' | 'expired' | 'unknown';

export type InvalidationReason =
  | 'consent_revoked'
  | 'user_deleted'
  | 'source_corrected'
  | 'policy_changed'
  | 'quality_failed'
  | 'legal_hold'
  | 'manual';

export type RollbackReason =
  | 'bad_calculation_version'
  | 'privacy_incident'
  | 'data_quality'
  | 'policy_violation'
  | 'manual';

/** どの一次データ由来か（lineage 追跡・raw を持たない）。 */
export type SourceKind =
  | 'career_user_events'
  | 'company_knowledge_contribution'
  | 'synthetic';

export type SourceLineage = {
  sourceKind: SourceKind;
  /** batch / observed window の粗い表現（exact timestamp ではない）。 */
  sourceWindow: string | null;
  /** 取り込み watermark（欠落は read 不可判定に使う）。 */
  inputWatermark: string | null;
  calculationVersion: string | null;
  policyVersion: number | null;
  /** consent snapshot の版（revoke 追跡用）。 */
  consentSnapshotVersion: string | null;
};

/** 1 artifact / projection の governance 状態束。 */
export type GovernanceState = {
  generation: GenerationState;
  publish: PublishState;
  validation: ValidationState;
  privacyReview: PrivacyReviewState;
  freshness: GovernanceFreshnessState;
  lineage: SourceLineage;
  /** 無効化されている場合の理由（null=有効）。 */
  invalidation: InvalidationReason | null;
  /** rollback 中の理由（null=通常）。 */
  rollback: RollbackReason | null;
};

// ── governance → ContextSourceResult 変換規則 ─────────────────────────
/**
 * governance 状態を read 可否へ写像した結果。
 * serve=false のときは ContextSourceResult の非 available status（unavailable/blocked/stale）へ
 * 対応する reason を返す（available には決してしない）。
 */
export type GovernanceReadDisposition =
  | { serve: true }
  | { serve: false; status: 'unavailable'; reason: ContextSourceUnavailableReason }
  | { serve: false; status: 'blocked'; reason: ContextSourceBlockedReason }
  | { serve: false; status: 'stale'; reason: ContextSourceStaleReason };

// ── Audit ───────────────────────────────────────────────────────────
export type DataSpineComponent =
  | 'aggregated_insight'
  | 'company_knowledge';

export type AuditEventType =
  | 'created'
  | 'validated'
  | 'blocked'
  | 'approved'
  | 'published'
  | 'revoked'
  | 'invalidated'
  | 'regenerated'
  | 'expired'
  | 'moderation_changed'
  | 'consent_changed'
  | 'legal_hold_changed'
  | 'rollback_requested'
  | 'rollback_completed';

/**
 * audit event（監視・追跡用）。
 * user identity / raw content / exact sensitive count を **含めない**。
 */
export type DataSpineAuditEvent = {
  eventType: AuditEventType;
  component: DataSpineComponent;
  /** 対象 artifact / contribution / batch を指す opaque key（identity ではない）。 */
  subjectKey: string;
  /** 追跡用 correlation opaque key。 */
  correlationKey: string;
  occurredAt: string; // ISO（呼び出し側が注入）
  reasonCode: string | null;
  calculationVersion: string | null;
  policyVersion: number | null;
};

// ── Monitoring ───────────────────────────────────────────────────────
export type MonitoringSeverity = 'info' | 'warning' | 'critical';

export type MonitoringSignalKind =
  | 'blocked_rate'
  | 'stale_rate'
  | 'moderation_backlog'
  | 'consent_revoke_backlog'
  | 'invalidation_backlog'
  | 'batch_failure'
  | 'privacy_scan_failure'
  | 'alias_collision'
  | 'conflict_rate'
  | 'insufficient_evidence_rate';

/**
 * monitoring signal（集約指標）。
 * exact sensitive count / identity / raw を含めない。rate は 0..1、count は bucket 文字列。
 */
export type MonitoringSignal = {
  kind: MonitoringSignalKind;
  severity: MonitoringSeverity;
  component: DataSpineComponent;
  /** rate 系（0..1）。count 系は null。 */
  rate: number | null;
  /** count 系の安全 bucket（生 count を出さない）。rate 系は null。 */
  countBucket: string | null;
  observedAt: string; // ISO
  policyVersion: number | null;
};

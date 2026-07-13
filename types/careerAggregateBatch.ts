/**
 * Aggregated Insight (Layer 4) — batch / lineage / propagation contract（P17-B §10-11）。
 *
 * production batch を将来実装するための **型契約**。本 series では executor / cron / DB を作らない。
 * exact sensitive count は持たず bucket 化する。個人を逆算できる情報を保持しない。
 *
 * 型のみ（repo 規約）。ロジックは lib/careerAggregate/{batchManifest,invalidation,batchRepository}.ts。
 */

import type { AggregateMetricKey, CalculationVersion } from '@/types/careerAggregate';

export type BatchState = 'started' | 'completed' | 'failed';
export type BatchValidationState = 'unvalidated' | 'valid' | 'invalid';
export type BatchPublishState = 'unpublished' | 'published' | 'rolled_back';

export type BatchIncompleteReason =
  | 'watermark_gap'
  | 'source_unavailable'
  | 'consent_snapshot_missing'
  | 'partial_window'
  | 'timeout';

export type BatchRollbackMeta = {
  reason:
    | 'bad_calculation_version'
    | 'privacy_incident'
    | 'data_quality'
    | 'policy_violation'
    | 'manual';
  at: string; // ISO
};

/**
 * batch manifest（1 回の集計実行の lineage / 状態）。
 * source/eligible event count は生値を持たず bucket 文字列で保持する。
 */
export type AggregateBatchManifest = {
  batchId: string;
  /** 二重生成防止用の idempotency key。 */
  idempotencyKey: string;
  metricKey: AggregateMetricKey;
  calculationVersion: CalculationVersion;
  policyVersion: number;
  sourceWindowStart: string; // ISO
  sourceWindowEnd: string; // ISO
  inputWatermark: string; // ISO（取り込み境界）
  consentSnapshotVersion: string;
  state: BatchState;
  /** incomplete の理由（null=完全）。incomplete batch は available にしない。 */
  incompleteReason: BatchIncompleteReason | null;
  sourceEventCountBucket: string;
  eligibleEventCountBucket: string;
  suppressedResultCount: number;
  /** 生成された artifact の opaque id 群。 */
  generatedArtifactIds: readonly string[];
  validationState: BatchValidationState;
  publishState: BatchPublishState;
  rollback: BatchRollbackMeta | null;
  startedAt: string; // ISO
  completedAt: string | null; // ISO
};

// ── Revoke / Deletion propagation（offline model）──────────────────────
export type PropagationTrigger = 'consent_revoke' | 'user_deletion' | 'contribution_exclusion';

export type PropagationState =
  | 'requested'
  | 'affected_identified'
  | 'invalidated'
  | 'regeneration_requested'
  | 'completed'
  | 'failed';

/**
 * propagation の起点。個人を逆算できる情報は持たず、
 * 影響 batch を特定するための metric / window / consent snapshot 版のみを持つ。
 */
export type PropagationRequest = {
  requestId: string;
  trigger: PropagationTrigger;
  /** 対象を指す opaque key（個人特定不能）。 */
  subjectOpaqueKey: string;
  /** 影響範囲特定用（個人ではなく集計座標）。 */
  metricKey: AggregateMetricKey;
  affectedWindowStart: string; // ISO
  affectedWindowEnd: string; // ISO
  requestedAt: string; // ISO
};

export type PropagationRecord = {
  request: PropagationRequest;
  affectedBatchIds: readonly string[];
  state: PropagationState;
  regenerationRequested: boolean;
  completedAt: string | null;
  failureReason: string | null;
};

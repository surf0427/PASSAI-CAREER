/**
 * Aggregated Insight (Layer 4) — Supabase batch write repository（P17-C §8・client injection）。
 *
 * env read なし / client 生成なし / 実 DB call なし（batch port 注入）。
 * domain manifest / artifact → row 写像。禁止 field を row へ入れない。
 * 部分成功を成功扱いしない（affected を返し caller が照合）。
 */

import type {
  DataSpineBatchPort,
  DbRow,
  DbWriteResult,
} from '@/lib/careerDataSpineDb/types';
import type { AggregateBatchManifest } from '@/types/careerAggregateBatch';
import type { SafeAggregateArtifact } from '@/types/careerAggregate';

const BATCHES_TABLE = 'career_aggregate_batches';
const ARTIFACTS_TABLE = 'career_aggregate_artifacts';

function manifestToRow(m: AggregateBatchManifest): DbRow {
  return {
    id: m.batchId,
    idempotency_key: m.idempotencyKey,
    metric_key: m.metricKey,
    calculation_version: m.calculationVersion,
    policy_version: m.policyVersion,
    source_window_start: m.sourceWindowStart,
    source_window_end: m.sourceWindowEnd,
    input_watermark: m.inputWatermark,
    consent_snapshot_version: m.consentSnapshotVersion,
    status: m.state,
    validation_state: m.validationState,
    publish_state: m.publishState,
    incomplete_reason: m.incompleteReason,
    source_event_count_bucket: m.sourceEventCountBucket,
    eligible_event_count_bucket: m.eligibleEventCountBucket,
    suppressed_result_count: m.suppressedResultCount,
    rollback_reason: m.rollback ? m.rollback.reason : null,
    rollback_at: m.rollback ? m.rollback.at : null,
    started_at: m.startedAt,
    completed_at: m.completedAt,
  };
}

function artifactToRow(batchId: string, artifactId: string, a: SafeAggregateArtifact): DbRow {
  return {
    id: artifactId,
    batch_id: batchId,
    metric_key: a.metricKey,
    feature_key: a.feature,
    calculation_version: a.calculationVersion,
    policy_version: a.provenance.policyStatus === 'FIXED' ? 1 : 0,
    kind: a.kind,
    safe_artifact: a, // 安全 payload（禁止 field を含まない domain 型のみ）。
    suppression_reason: a.kind === 'suppressed' ? a.suppression.reason : null,
    sample_size_bucket: a.kind === 'valid' ? a.sampleSizeBucket : null,
    cohort_type: a.cohortType,
    cohort_value: a.cohortValue,
    time_bucket: a.timeBucket,
    source_window_start: a.sourceWindowStart,
    source_window_end: a.sourceWindowEnd,
    invalidated: false,
    generated_at: a.generatedAt,
    expires_at: a.expiresAt,
  };
}

export function createSupabaseAggregateBatchRepository(batchPort: DataSpineBatchPort) {
  return {
    /** manifest を upsert（idempotency_key 制約で二重生成を防ぐ）。 */
    async putManifest(m: AggregateBatchManifest): Promise<DbWriteResult> {
      return batchPort.upsert(BATCHES_TABLE, [manifestToRow(m)], 'idempotency_key');
    },
    /** artifact を insert（禁止 field を含まない safe payload のみ）。 */
    async putArtifact(batchId: string, artifactId: string, a: SafeAggregateArtifact): Promise<DbWriteResult> {
      return batchPort.insert(ARTIFACTS_TABLE, [artifactToRow(batchId, artifactId, a)]);
    },
  };
}

export type SupabaseAggregateBatchRepository = ReturnType<typeof createSupabaseAggregateBatchRepository>;

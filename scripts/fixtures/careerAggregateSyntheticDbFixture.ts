/*
 * scripts/fixtures/careerAggregateSyntheticDbFixture.ts
 *
 * PASSAI CAREER — Layer 4 synthetic round-trip fixture（P17-E・dev-only）。
 *
 * synthetic data のみ。user_id / auth.uid() / email / 氏名を含めない。
 * clearly synthetic（data_classification='synthetic' + 'synthetic-' id prefix）。
 * deterministic。valid / suppressed / stale / invalidated / incomplete を表現。
 */

import {
  SYNTHETIC_CONSULTATION_ARTIFACT_ID,
  SYNTHETIC_CONSULTATION_BATCH_ID,
} from '@/lib/careerAggregate/server/runtimeTypes';
import type { DbRow } from '@/lib/careerDataSpineDb/types';

export type SyntheticCase = 'valid' | 'suppressed' | 'stale' | 'invalidated' | 'incomplete';
export const SYNTHETIC_CASES: readonly SyntheticCase[] = ['valid', 'suppressed', 'stale', 'invalidated', 'incomplete'];

// career_aggregate_{batches,artifacts}.id は uuid 列。case ごとに固定 UUID(v4) を割り当てる。
// batch は 00000000-...-000N、artifact は 10000000-...-000N（衝突せず・FK 一致）。valid は共有定数と一致。
const CASE_INDEX: Record<SyntheticCase, number> = { valid: 1, suppressed: 2, stale: 3, invalidated: 4, incomplete: 5 };
function batchUuid(c: SyntheticCase): string {
  return c === 'valid' ? SYNTHETIC_CONSULTATION_BATCH_ID : `00000000-0000-4000-8000-00000000000${CASE_INDEX[c]}`;
}
function artifactUuid(c: SyntheticCase): string {
  return c === 'valid' ? SYNTHETIC_CONSULTATION_ARTIFACT_ID : `10000000-0000-4000-8000-00000000000${CASE_INDEX[c]}`;
}

/** UUID(v4) 妥当性（seed / validator の型契約検証用）。 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// 決定論的な時刻（マシン時刻非依存）。
const GENERATED_AT = '2026-07-01T00:00:00.000Z';
const FUTURE_EXPIRY = '2026-12-31T00:00:00.000Z'; // valid: 十分未来
const PAST_EXPIRY = '2026-07-02T00:00:00.000Z'; // stale: 過去
const WINDOW_START = '2026-05-01T00:00:00.000Z';
const WINDOW_END = '2026-06-01T00:00:00.000Z';
const WATERMARK = '2026-06-02T00:00:00.000Z';

function ids(c: SyntheticCase): { batchId: string; artifactId: string } {
  return { batchId: batchUuid(c), artifactId: artifactUuid(c) };
}

export function syntheticBatchRow(c: SyntheticCase): DbRow {
  const { batchId } = ids(c);
  const incomplete = c === 'incomplete';
  return {
    id: batchId,
    // idempotency_key は text 列（人間可読の synthetic marker を維持）。
    idempotency_key: `synthetic-${c}-idem`,
    metric_key: 'feature_usage_prevalence',
    calculation_version: 'feature_usage_prevalence@1',
    policy_version: 1,
    source_window_start: WINDOW_START,
    source_window_end: WINDOW_END,
    input_watermark: WATERMARK,
    consent_snapshot_version: 'synthetic-cs-1',
    status: incomplete ? 'started' : 'completed',
    validation_state: incomplete ? 'invalid' : 'valid',
    publish_state: incomplete ? 'unpublished' : 'published',
    incomplete_reason: incomplete ? 'watermark_gap' : '',
    source_event_count_bucket: '100–499',
    eligible_event_count_bucket: '50–99',
    suppressed_result_count: c === 'suppressed' ? 1 : 0,
    rollback_reason: '',
    data_classification: 'synthetic',
    started_at: GENERATED_AT,
    completed_at: incomplete ? null : GENERATED_AT,
  };
}

export function syntheticArtifactRow(c: SyntheticCase): DbRow {
  const { batchId, artifactId } = ids(c);
  const suppressed = c === 'suppressed';
  const stale = c === 'stale';
  const invalidated = c === 'invalidated';

  const safe: Record<string, unknown> = suppressed
    ? {
        kind: 'suppressed',
        metricKey: 'feature_usage_prevalence',
        calculationVersion: 'feature_usage_prevalence@1',
        feature: 'interview',
        cohortType: 'all',
        cohortValue: 'all',
        timeBucket: '2026-05',
        sourceWindowStart: WINDOW_START,
        sourceWindowEnd: WINDOW_END,
        generatedAt: GENERATED_AT,
        expiresAt: FUTURE_EXPIRY,
        consentScope: 'user_facing_aggregated_insight',
        provenance: { metricKey: 'feature_usage_prevalence', calculationVersion: 'feature_usage_prevalence@1', consentScope: 'user_facing_aggregated_insight', audience: 'user_facing', policyStatus: 'PROVISIONAL', rolledUpFrom: null },
        qualityStatus: 'valid',
        disclaimerKey: 'aggregate_general_trend_v1',
        suppression: { suppressed: true, reason: 'below_audience_threshold' },
      }
    : {
        kind: 'valid',
        metricKey: 'feature_usage_prevalence',
        calculationVersion: 'feature_usage_prevalence@1',
        feature: 'interview',
        cohortType: 'all',
        cohortValue: 'all',
        timeBucket: '2026-05',
        sourceWindowStart: WINDOW_START,
        sourceWindowEnd: WINDOW_END,
        generatedAt: GENERATED_AT,
        expiresAt: stale ? PAST_EXPIRY : FUTURE_EXPIRY,
        consentScope: 'user_facing_aggregated_insight',
        provenance: { metricKey: 'feature_usage_prevalence', calculationVersion: 'feature_usage_prevalence@1', consentScope: 'user_facing_aggregated_insight', audience: 'user_facing', policyStatus: 'PROVISIONAL', rolledUpFrom: null },
        qualityStatus: 'valid',
        disclaimerKey: 'aggregate_general_trend_v1',
        numerator: 30,
        denominator: 60,
        prevalence: 0.5,
        sampleSizeBucket: '50–99',
        suppression: { suppressed: false },
      };

  return {
    id: artifactId,
    batch_id: batchId,
    metric_key: 'feature_usage_prevalence',
    feature_key: 'interview',
    calculation_version: 'feature_usage_prevalence@1',
    policy_version: 1,
    kind: safe.kind,
    safe_artifact: safe,
    suppression_reason: suppressed ? 'below_audience_threshold' : null,
    sample_size_bucket: suppressed ? null : '50–99',
    cohort_type: 'all',
    cohort_value: 'all',
    time_bucket: '2026-05',
    source_window_start: WINDOW_START,
    source_window_end: WINDOW_END,
    invalidated: invalidated,
    data_classification: 'synthetic',
    generated_at: GENERATED_AT,
    expires_at: stale ? PAST_EXPIRY : FUTURE_EXPIRY,
  };
}

export type SyntheticDatasetEntry = { case: SyntheticCase; batch: DbRow; artifact: DbRow };

/** 全ケースの {batch, artifact} を deterministic に返す。 */
export function syntheticDataset(): SyntheticDatasetEntry[] {
  return SYNTHETIC_CASES.map((c) => ({ case: c, batch: syntheticBatchRow(c), artifact: syntheticArtifactRow(c) }));
}

/**
 * 期待される shadow read の結果（validate / QA の参照）。
 * incomplete（未検証 batch）は governance の fail-closed 順（privacyReview not_reviewed）で
 * blocked へ倒れる（＝available にならない）。task 上 unavailable/blocked いずれも安全側。
 */
export const EXPECTED_READ_STATUS: Record<SyntheticCase, string> = {
  valid: 'available',
  suppressed: 'suppressed',
  stale: 'stale',
  invalidated: 'blocked',
  incomplete: 'blocked',
};

/** row に含まれてはいけない identity / raw field。 */
export const PROHIBITED_ROW_FIELDS: readonly string[] = [
  'user_id', 'auth_uid', 'email', 'contributor_name', 'university', 'application_id', 'name',
];

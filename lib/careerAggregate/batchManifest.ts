/**
 * Aggregated Insight (Layer 4) — batch manifest builders / validation（P17-B §10）。
 *
 * production batch を将来実装するための pure helper。executor / cron / DB は作らない。
 * manifest → 共通 governance state への写像を提供し、read 可否を共通規則で判定できるようにする。
 *
 * pure・決定論（Date.now 非使用）。
 */

import type {
  AggregateBatchManifest,
  BatchIncompleteReason,
  BatchRollbackMeta,
} from '@/types/careerAggregateBatch';
import type { AggregateMetricKey, CalculationVersion } from '@/types/careerAggregate';
import type { GovernanceState, InvalidationReason } from '@/types/careerDataGovernance';

export type BuildManifestInput = {
  batchId: string;
  idempotencyKey: string;
  metricKey: AggregateMetricKey;
  calculationVersion: CalculationVersion;
  policyVersion: number;
  sourceWindowStart: string;
  sourceWindowEnd: string;
  inputWatermark: string;
  consentSnapshotVersion: string;
  startedAt: string;
};

/** started manifest を作る（pure）。 */
export function startBatchManifest(input: BuildManifestInput): AggregateBatchManifest {
  return {
    batchId: input.batchId,
    idempotencyKey: input.idempotencyKey,
    metricKey: input.metricKey,
    calculationVersion: input.calculationVersion,
    policyVersion: input.policyVersion,
    sourceWindowStart: input.sourceWindowStart,
    sourceWindowEnd: input.sourceWindowEnd,
    inputWatermark: input.inputWatermark,
    consentSnapshotVersion: input.consentSnapshotVersion,
    state: 'started',
    incompleteReason: null,
    sourceEventCountBucket: '0',
    eligibleEventCountBucket: '0',
    suppressedResultCount: 0,
    generatedArtifactIds: [],
    validationState: 'unvalidated',
    publishState: 'unpublished',
    rollback: null,
    startedAt: input.startedAt,
    completedAt: null,
  };
}

/** complete 遷移（生成 artifact / count bucket を確定）。 */
export function completeBatchManifest(
  m: AggregateBatchManifest,
  input: {
    completedAt: string;
    sourceEventCountBucket: string;
    eligibleEventCountBucket: string;
    suppressedResultCount: number;
    generatedArtifactIds: readonly string[];
  },
): AggregateBatchManifest {
  return {
    ...m,
    state: 'completed',
    completedAt: input.completedAt,
    sourceEventCountBucket: input.sourceEventCountBucket,
    eligibleEventCountBucket: input.eligibleEventCountBucket,
    suppressedResultCount: input.suppressedResultCount,
    generatedArtifactIds: input.generatedArtifactIds,
  };
}

export function failBatchManifest(m: AggregateBatchManifest, completedAt: string): AggregateBatchManifest {
  return { ...m, state: 'failed', completedAt };
}

export function markIncomplete(
  m: AggregateBatchManifest,
  reason: BatchIncompleteReason,
): AggregateBatchManifest {
  return { ...m, incompleteReason: reason };
}

/** validation を適用（必須 lineage を検査して valid/invalid を確定）。 */
export function validateBatchManifest(m: AggregateBatchManifest): AggregateBatchManifest {
  const lineageOk =
    m.sourceWindowStart !== '' &&
    m.sourceWindowEnd !== '' &&
    m.inputWatermark !== '' &&
    m.consentSnapshotVersion !== '' &&
    m.state === 'completed' &&
    m.incompleteReason === null;
  return { ...m, validationState: lineageOk ? 'valid' : 'invalid' };
}

/** publish（valid かつ completed かつ incomplete でないときのみ published へ）。 */
export function publishBatchManifest(m: AggregateBatchManifest): AggregateBatchManifest {
  if (m.validationState !== 'valid' || m.state !== 'completed' || m.incompleteReason !== null) {
    return m; // publish 不可（状態不変）
  }
  return { ...m, publishState: 'published' };
}

export function rollbackBatchManifest(
  m: AggregateBatchManifest,
  rollback: BatchRollbackMeta,
): AggregateBatchManifest {
  return { ...m, publishState: 'rolled_back', rollback };
}

/**
 * manifest → 共通 governance state へ写像する（read 可否を共通規則で判定するため）。
 * invalidation は propagation 側から注入する（invalidated=true のとき reason を渡す）。
 */
export function manifestToGovernanceState(
  m: AggregateBatchManifest,
  opts: { freshness: GovernanceState['freshness']; invalidation?: InvalidationReason | null } = {
    freshness: 'fresh',
  },
): GovernanceState {
  return {
    generation:
      m.state === 'completed' && m.incompleteReason === null
        ? 'generated'
        : m.state === 'failed'
          ? 'failed'
          : 'generating', // started / incomplete は未生成扱い（available にしない）
    publish:
      m.publishState === 'published'
        ? 'published'
        : m.publishState === 'rolled_back'
          ? 'withdrawn'
          : 'unpublished',
    validation: m.validationState,
    // L4 の privacy 安全は projection の構造 default-deny で担保。valid のときのみ passed とみなす。
    privacyReview: m.validationState === 'valid' ? 'passed' : 'not_reviewed',
    freshness: opts.freshness,
    lineage: {
      sourceKind: 'career_user_events',
      sourceWindow: `${m.sourceWindowStart}/${m.sourceWindowEnd}`,
      inputWatermark: m.inputWatermark,
      calculationVersion: m.calculationVersion,
      policyVersion: m.policyVersion,
      consentSnapshotVersion: m.consentSnapshotVersion,
    },
    invalidation: opts.invalidation ?? null,
    rollback: m.rollback ? m.rollback.reason : null,
  };
}

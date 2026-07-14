/**
 * Aggregated Insight (Layer 4) — Supabase read repository（P17-C §8・client injection）。
 *
 * 厳守:
 *   - env read なし / client 生成なし / app・route import なし / 実 DB call なし（port 注入）。
 *   - never-throw read（DB error は判別 union → ContextSourceResult 非 available へ）。
 *   - row validation・malformed row / unknown enum fail-closed。
 *   - incomplete / failed / invalidated / stale artifact を available にしない（共通 governance 経由）。
 *   - raw row を上位へ返さない（validated domain のみ）。
 *
 * production caller は今回作らない（loader からの DI 想定）。
 */

import { manifestToGovernanceState } from './batchManifest';
import { evaluateGovernanceDisposition } from '@/lib/careerDataGovernance/state';
import type { BatchAwareReadResult } from './batchRepository';
import type { AggregateBatchManifest } from '@/types/careerAggregateBatch';
import type { SafeAggregateArtifact } from '@/types/careerAggregate';
import type { GovernanceFreshnessState, InvalidationReason } from '@/types/careerDataGovernance';
import type { DataSpineReadPort, DbRow } from '@/lib/careerDataSpineDb/types';

const BATCHES_TABLE = 'career_aggregate_batches';
const ARTIFACTS_TABLE = 'career_aggregate_artifacts';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function bool(v: unknown): boolean {
  return v === true;
}

/** safe_artifact jsonb を SafeAggregateArtifact として最小検証する（fail-closed）。 */
export function parseArtifactPayload(row: DbRow): SafeAggregateArtifact | null {
  const payload = row.safe_artifact;
  if (!payload || typeof payload !== 'object') return null;
  const a = payload as Record<string, unknown>;
  const kind = a.kind;
  if (kind !== 'valid' && kind !== 'zero' && kind !== 'suppressed') return null; // unknown enum fail-closed
  if (str(a.metricKey) === '' || str(a.expiresAt) === '' || str(a.generatedAt) === '') return null;
  return payload as SafeAggregateArtifact;
}

/** batch row → governance 用 manifest（read に必要な field のみ・fail-closed）。 */
export function parseBatchManifest(row: DbRow): AggregateBatchManifest | null {
  const status = row.status;
  if (status !== 'started' && status !== 'completed' && status !== 'failed') return null;
  const validationState = row.validation_state;
  if (validationState !== 'unvalidated' && validationState !== 'valid' && validationState !== 'invalid') return null;
  const publishState = row.publish_state;
  if (publishState !== 'unpublished' && publishState !== 'published' && publishState !== 'rolled_back') return null;
  return {
    batchId: str(row.id),
    idempotencyKey: str(row.idempotency_key),
    metricKey: 'feature_usage_prevalence',
    calculationVersion: (str(row.calculation_version) || 'feature_usage_prevalence@1') as AggregateBatchManifest['calculationVersion'],
    policyVersion: num(row.policy_version),
    sourceWindowStart: str(row.source_window_start),
    sourceWindowEnd: str(row.source_window_end),
    inputWatermark: str(row.input_watermark),
    consentSnapshotVersion: str(row.consent_snapshot_version),
    state: status,
    incompleteReason: (str(row.incomplete_reason) || null) as AggregateBatchManifest['incompleteReason'],
    sourceEventCountBucket: str(row.source_event_count_bucket),
    eligibleEventCountBucket: str(row.eligible_event_count_bucket),
    suppressedResultCount: num(row.suppressed_result_count),
    generatedArtifactIds: [],
    validationState,
    publishState,
    rollback: str(row.rollback_reason)
      ? { reason: str(row.rollback_reason) as NonNullable<AggregateBatchManifest['rollback']>['reason'], at: str(row.rollback_at) }
      : null,
    startedAt: str(row.started_at),
    completedAt: str(row.completed_at) || null,
  };
}

export function createSupabaseAggregateReadRepository(readPort: DataSpineReadPort) {
  async function selectOne(table: string, id: string): Promise<{ row: DbRow | null } | { error: BatchAwareReadResult }> {
    const res = await readPort.select({ table, eq: { id }, limit: 1 });
    if (!res.ok) {
      // すべての DB error は fail-closed で unavailable（table_missing / permission_denied 含む）。
      return { error: { status: 'unavailable', reason: 'lookup_error' } };
    }
    return { row: res.rows[0] ?? null };
  }

  return {
    /** artifact を governed に読む（never-throw）。 */
    async readArtifact(artifactId: string, now: number): Promise<BatchAwareReadResult> {
      try {
        const art = await selectOne(ARTIFACTS_TABLE, artifactId);
        if ('error' in art) return art.error;
        if (!art.row) return { status: 'missing' };

        const artifact = parseArtifactPayload(art.row);
        if (!artifact) return { status: 'unavailable', reason: 'lookup_error' }; // malformed fail-closed

        const batchId = str(art.row.batch_id);
        const batch = await selectOne(BATCHES_TABLE, batchId);
        if ('error' in batch) return batch.error;
        if (!batch.row) return { status: 'unavailable', reason: 'lookup_error' };

        const manifest = parseBatchManifest(batch.row);
        if (!manifest) return { status: 'unavailable', reason: 'lookup_error' };

        const exp = Date.parse(artifact.expiresAt);
        const freshness: GovernanceFreshnessState = Number.isNaN(exp) ? 'unknown' : exp <= now ? 'expired' : 'fresh';
        const invalidation: InvalidationReason | null = bool(art.row.invalidated) ? 'consent_revoked' : null;

        const gov = manifestToGovernanceState(manifest, { freshness, invalidation });
        const disposition = evaluateGovernanceDisposition(gov);
        if (!disposition.serve) {
          if (disposition.status === 'blocked') return { status: 'blocked', reason: disposition.reason };
          if (disposition.status === 'stale') return { status: 'stale' };
          return { status: 'unavailable', reason: disposition.reason };
        }
        if (artifact.kind === 'suppressed') return { status: 'suppressed', artifact };
        return { status: 'available', artifact };
      } catch {
        return { status: 'unavailable', reason: 'unknown' };
      }
    },
  };
}

export type SupabaseAggregateReadRepository = ReturnType<typeof createSupabaseAggregateReadRepository>;

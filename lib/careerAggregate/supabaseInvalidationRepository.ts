/**
 * Aggregated Insight (Layer 4) — Supabase invalidation / regeneration repository（P17-C §8）。
 *
 * env read なし / client 生成なし / 実 DB call なし（write + read port 注入）。
 * 個人を逆算できる情報を row へ入れない（opaque correlation key + metric/window のみ）。
 */

import type {
  DataSpineReadPort,
  DataSpineWritePort,
  DbRow,
  DbWriteResult,
} from '@/lib/careerDataSpineDb/types';
import type { PropagationRecord } from '@/types/careerAggregateBatch';

const INVALIDATIONS_TABLE = 'career_aggregate_invalidations';
const REGEN_TABLE = 'career_aggregate_regeneration_requests';

function recordToRow(rec: PropagationRecord): DbRow {
  return {
    correlation_key: rec.request.requestId,
    trigger: rec.request.trigger,
    metric_key: rec.request.metricKey,
    affected_window_start: rec.request.affectedWindowStart,
    affected_window_end: rec.request.affectedWindowEnd,
    propagation_state: rec.state,
    completed_at: rec.completedAt,
    failure_reason: rec.failureReason,
  };
}

export function createSupabaseAggregateInvalidationRepository(deps: {
  writePort: DataSpineWritePort;
  readPort: DataSpineReadPort;
}) {
  return {
    /** invalidation を記録（correlation_key 制約で idempotent）。 */
    async putInvalidation(rec: PropagationRecord): Promise<DbWriteResult> {
      return deps.writePort.insert(INVALIDATIONS_TABLE, [recordToRow(rec)]);
    },
    /** propagation state を更新。 */
    async updatePropagationState(correlationKey: string, state: string, completedAt: string | null): Promise<DbWriteResult> {
      return deps.writePort.update(
        INVALIDATIONS_TABLE,
        { propagation_state: state, completed_at: completedAt },
        { eq: { correlation_key: correlationKey } },
      );
    },
    /** regeneration request を記録。 */
    async putRegenerationRequest(invalidationId: string, metricKey: string): Promise<DbWriteResult> {
      return deps.writePort.insert(REGEN_TABLE, [
        { invalidation_id: invalidationId, metric_key: metricKey, requested_state: 'requested' },
      ]);
    },
    /** propagation state を読む（never-throw・DB error は null）。 */
    async readPropagationState(correlationKey: string): Promise<string | null> {
      const res = await deps.readPort.select({ table: INVALIDATIONS_TABLE, eq: { correlation_key: correlationKey }, limit: 1 });
      if (!res.ok) return null;
      const row = res.rows[0];
      return row && typeof row.propagation_state === 'string' ? row.propagation_state : null;
    },
  };
}

export type SupabaseAggregateInvalidationRepository = ReturnType<typeof createSupabaseAggregateInvalidationRepository>;

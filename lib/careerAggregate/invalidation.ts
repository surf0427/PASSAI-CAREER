/**
 * Aggregated Insight (Layer 4) — revoke / deletion propagation model（P17-B §11）。
 *
 * offline model。executor / cron / DB は作らない。個人を逆算できる情報を保持しない
 * （影響 batch は metric × window で特定する。user-level 逆引きはしない）。
 *
 * 状態機械: requested → affected_identified → invalidated → regeneration_requested → completed
 *   （regeneration 完了前は fail-closed で serve しない）。
 *
 * SLA 値は確定せず PROVISIONAL policy として分離する。pure・決定論。
 */

import type {
  AggregateBatchManifest,
  PropagationRecord,
  PropagationRequest,
  PropagationState,
} from '@/types/careerAggregateBatch';

/** SLA（PROVISIONAL・法務未確定）。値はコードで確定しない。 */
export type PropagationSlaPolicy = {
  maxHoursToInvalidate: number;
  maxHoursToRegenerate: number;
  status: 'PROVISIONAL' | 'FIXED';
};
export const PROPAGATION_SLA: PropagationSlaPolicy = {
  maxHoursToInvalidate: 24,
  maxHoursToRegenerate: 72,
  status: 'PROVISIONAL',
};

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = Date.parse(aStart);
  const ae = Date.parse(aEnd);
  const bs = Date.parse(bStart);
  const be = Date.parse(bEnd);
  if ([as, ae, bs, be].some((t) => Number.isNaN(t))) return false;
  return as < be && bs < ae;
}

/** 影響 batch を特定する（metric 一致 + window 重複・決定論順）。 */
export function findAffectedBatches(
  manifests: readonly AggregateBatchManifest[],
  request: PropagationRequest,
): string[] {
  return manifests
    .filter(
      (m) =>
        m.metricKey === request.metricKey &&
        m.publishState === 'published' &&
        overlaps(m.sourceWindowStart, m.sourceWindowEnd, request.affectedWindowStart, request.affectedWindowEnd),
    )
    .map((m) => m.batchId)
    .sort();
}

/** propagation を開始する（requested state）。 */
export function startPropagation(
  request: PropagationRequest,
  manifests: readonly AggregateBatchManifest[],
): PropagationRecord {
  const affectedBatchIds = findAffectedBatches(manifests, request);
  return {
    request,
    affectedBatchIds,
    state: affectedBatchIds.length > 0 ? 'affected_identified' : 'requested',
    regenerationRequested: false,
    completedAt: null,
    failureReason: null,
  };
}

const ORDER: readonly PropagationState[] = [
  'requested',
  'affected_identified',
  'invalidated',
  'regeneration_requested',
  'completed',
];

/** 次状態へ進める（後退・スキップは不可・pure）。 */
export function advancePropagation(
  record: PropagationRecord,
  to: PropagationState,
  at: string,
): PropagationRecord {
  if (to === 'failed') {
    return { ...record, state: 'failed', failureReason: 'propagation_failed', completedAt: at };
  }
  const fromIdx = ORDER.indexOf(record.state);
  const toIdx = ORDER.indexOf(to);
  if (fromIdx < 0 || toIdx < 0 || toIdx !== fromIdx + 1) return record; // 隣接前進のみ
  return {
    ...record,
    state: to,
    regenerationRequested: to === 'regeneration_requested' ? true : record.regenerationRequested,
    completedAt: to === 'completed' ? at : record.completedAt,
  };
}

/**
 * 影響 batch がまだ serve 可能か（fail-closed）。
 * propagation が completed になるまで、影響 batch は invalidated 扱いで serve しない。
 */
export function isBatchServable(record: PropagationRecord | null, batchId: string): boolean {
  if (!record) return true; // propagation 無し = 通常
  if (!record.affectedBatchIds.includes(batchId)) return true;
  return record.state === 'completed'; // regeneration 完了まで serve しない
}

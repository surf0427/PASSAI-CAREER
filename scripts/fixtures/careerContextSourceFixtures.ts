/*
 * scripts/fixtures/careerContextSourceFixtures.ts
 *
 * PASSAI CAREER — Shared Context Source boundary synthetic fixtures（P17-A §3・dev-only）。
 *
 * ContextSourceResult の status / reason 網羅・「available のみ data を持つ」不変条件を
 * QA から検証するためのサンプルと compile-only guard。
 */

import type {
  ContextSourceResult,
  ContextSourceBlockedReason,
  ContextSourceDisabledReason,
  ContextSourceEmptyReason,
  ContextSourceStaleReason,
  ContextSourceUnavailableReason,
} from '@/types/careerContextSource';

/** 全 non-available status のサンプル（reason union を網羅）。 */
export const EMPTY_REASONS: readonly ContextSourceEmptyReason[] = ['no_evidence', 'no_eligible_data'];
export const UNAVAILABLE_REASONS: readonly ContextSourceUnavailableReason[] = [
  'unknown',
  'not_checked',
  'lookup_error',
];
export const DISABLED_REASONS: readonly ContextSourceDisabledReason[] = [
  'not_connected',
  'flag_off',
  'shadow_only',
];
export const BLOCKED_REASONS: readonly ContextSourceBlockedReason[] = [
  'consent',
  'legal',
  'moderation',
  'privacy',
];
export const STALE_REASONS: readonly ContextSourceStaleReason[] = [
  'freshness_expired',
  'incomplete_batch',
];

/** サンプル available（data を持つ唯一の variant）。 */
export function sampleAvailable(): ContextSourceResult<{ note: string }> {
  return {
    status: 'available',
    data: { note: 'ok' },
    provenance: {
      layer: 'aggregated_insight',
      generatedAt: '2026-07-01T00:00:00.000Z',
      sourceWindow: '2026-05',
      calculationVersion: 'feature_usage_prevalence@1',
      policyStatus: 'PROVISIONAL',
    },
    confidence: 0.7,
    freshness: {
      generatedAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-07-09T00:00:00.000Z',
      observedPeriod: null,
      classification: 'fresh',
    },
    privacy: 'anonymous_aggregate',
    usage: 'reference_only',
  };
}

/**
 * compile-only guard: non-available result が data を運べないことを型で確認する。
 * （実行時は何もしない。tsx/tsc の型検査で保証される。）
 */
export function assertNoDataOnNonAvailable(r: ContextSourceResult<unknown>): boolean {
  if (r.status === 'available') return 'data' in r;
  // @ts-expect-error — non-available variant は data フィールドを型に持たない。
  return r.data === undefined;
}

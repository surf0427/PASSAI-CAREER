/**
 * Data Spine — synthetic-only readiness profile（P17-E §10・pure）。
 *
 * P17-C の real readiness（法務 gate を含む全 12 項目）を **緩めない**。
 * synthetic round-trip / synthetic shadow 専用の別 profile として定義する。
 *
 * 分離要件:
 *   - synthetic profile は法務項目（cohort/retention/consent 等）を免除する。
 *   - ただし配置・identity・table placement（非法務の技術決定）は要求する。
 *   - 型で real readiness と区別し、synthetic READY が real-data READY へ **昇格しない**。
 */

import {
  evaluateReadiness,
  type ReadinessConfig,
  type ReadinessDecisionKey,
  type ReadinessResult,
} from './readiness';

/** synthetic shadow に必要な非法務 decision のみ。 */
export const SYNTHETIC_REQUIRED_DECISIONS: readonly ReadinessDecisionKey[] = [
  'target_project',
  'identity_strategy',
  'table_placement',
];

/** synthetic 専用結果（`mode:'synthetic'` brand で real と型分離）。 */
export type SyntheticReadinessResult =
  | { mode: 'synthetic'; ready: true }
  | { mode: 'synthetic'; ready: false; missing: readonly ReadinessDecisionKey[] };

/** synthetic readiness を評価する（法務項目は不要・非法務項目は必須）。 */
export function evaluateSyntheticReadiness(
  config: ReadinessConfig | null | undefined,
): SyntheticReadinessResult {
  const missing = SYNTHETIC_REQUIRED_DECISIONS.filter((k) => config?.[k] !== true);
  return missing.length === 0 ? { mode: 'synthetic', ready: true } : { mode: 'synthetic', ready: false, missing };
}

/** shadow に synthetic READY か（synthetic profile のみ）。 */
export function isSyntheticReadyForShadow(config: ReadinessConfig | null | undefined): boolean {
  return evaluateSyntheticReadiness(config).ready;
}

/**
 * real-data READY か（全 12 項目・法務含む）。**本 series では満たせない前提**。
 * synthetic profile を real READY として誤用させないため、real 判定は evaluateReadiness に委譲する。
 */
export function isRealReadyForActivation(config: ReadinessConfig | null | undefined): boolean {
  const r: ReadinessResult = evaluateReadiness(config);
  return r.ready;
}

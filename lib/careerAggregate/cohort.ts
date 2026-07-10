/**
 * Cohort guard — unique-user threshold / suppression 判定（P14-B / P14-A §Cohort policy）。
 *
 * 原則:
 *   - **unique-user 数**で判定（event 数ではない）。
 *   - absolute lower bound 未満は常に suppressed。
 *   - audience 別 threshold（internal/user_facing/ai_context）。first insight は user_facing=50。
 *   - 閾値は全て PROVISIONAL（COHORT_THRESHOLDS.status）。
 *   - prohibited dimension / 任意複合 dimension / 不正 time granularity は reject。
 *   - graduation_year 不足時は all へ roll-up 候補を返す（適用は pipeline 側）。
 *
 * pure function。DB 非依存。
 */

import {
  ALLOWED_COHORT_TYPES,
  COHORT_THRESHOLDS,
  PROHIBITED_DIMENSIONS,
  rollUpCohortCandidate,
} from './policy';
import type {
  AggregateAudience,
  CohortDecision,
  CohortType,
  SuppressionReason,
  TimeBucketGranularity,
} from '@/types/careerAggregate';

function audienceThreshold(audience: AggregateAudience): number {
  switch (audience) {
    case 'internal':
      return COHORT_THRESHOLDS.internal;
    case 'user_facing':
      return COHORT_THRESHOLDS.userFacing;
    case 'ai_context':
      return COHORT_THRESHOLDS.aiContext;
    default:
      return COHORT_THRESHOLDS.aiContext; // 最保守 fallback
  }
}

/**
 * cohort dimension 妥当性（許可 cohort type / 単一 dimension / prohibited でない / month 粒度）を検証。
 * 問題があれば suppressed decision を返す（数値を持たせない）。
 */
export function validateCohortSpec(input: {
  cohortType: CohortType;
  /** 交差 dimension があれば配列で渡す（graduation_year × company 等）。 */
  extraDimensions?: readonly string[];
  timeGranularity: TimeBucketGranularity | string;
}): { ok: true } | { suppressed: true; reason: SuppressionReason; rollUpCandidate: null } {
  // 任意複合 dimension は禁止（交差での小セル化を防ぐ）。
  if (Array.isArray(input.extraDimensions) && input.extraDimensions.length > 0) {
    // prohibited と交差の両方を判定するが、交差が存在する時点で unsupported。
    const hasProhibited = input.extraDimensions.some((d) => PROHIBITED_DIMENSIONS.includes(d));
    return {
      suppressed: true,
      reason: hasProhibited ? 'prohibited_dimension' : 'unsupported_dimension_intersection',
      rollUpCandidate: null,
    };
  }

  if (!(ALLOWED_COHORT_TYPES as readonly string[]).includes(input.cohortType)) {
    return { suppressed: true, reason: 'prohibited_dimension', rollUpCandidate: null };
  }

  if (input.timeGranularity !== 'month') {
    return { suppressed: true, reason: 'unsafe_time_granularity', rollUpCandidate: null };
  }

  return { ok: true };
}

/**
 * unique-user 数 + audience から suppression を判定する（pure）。
 * denominator（eligible unique users）を渡す前提。
 */
export function evaluateCohort(input: {
  uniqueUsers: number;
  audience: AggregateAudience;
  cohortType: CohortType;
}): CohortDecision {
  const n = Number.isFinite(input.uniqueUsers) ? input.uniqueUsers : 0;

  if (n < COHORT_THRESHOLDS.absoluteLowerBound) {
    return {
      suppressed: true,
      reason: 'below_absolute_minimum',
      rollUpCandidate: rollUpCohortCandidate(input.cohortType),
    };
  }

  const threshold = audienceThreshold(input.audience);
  if (n < threshold) {
    return {
      suppressed: true,
      reason: 'below_audience_threshold',
      rollUpCandidate: rollUpCohortCandidate(input.cohortType),
    };
  }

  return { suppressed: false, audience: input.audience, thresholdApplied: threshold };
}

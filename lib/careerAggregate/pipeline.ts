/**
 * Pure synthetic pipeline — Layer 4 論理フローを DB 非依存で再現（P14-B / P14-A §Pipeline）。
 *
 *   Synthetic event
 *   → Consent eligibility
 *   → Default-deny projection
 *   → Internal dedup identity
 *   → Duplicate / retry removal
 *   → User-level boolean contribution
 *   → Month bucketing
 *   → Fixed metric grouping
 *   → Unique-user cohort count
 *   → Audience threshold
 *   → Suppression（+ roll-up）
 *   → Safe aggregate artifact
 *
 * production 非接続: pure function のみ。Supabase / production reader / owner-scoped reader を
 *   import しない。synthetic identifier は入力にのみ現れ、artifact へは残さない。
 */

import { AUDIENCE_REQUIRED_SCOPE, FEATURE_USAGE_PREVALENCE, FRESHNESS_DELAY_HOURS } from './policy';
import { evaluateConsentEligibility } from './consent';
import { projectAggregateContribution } from './projection';
import { boundContributions, countUniqueUsersForFeature, countUniqueUsersInMonth } from './contribution';
import { evaluateCohort, validateCohortSpec } from './cohort';
import { buildSuppressedArtifact, buildValidArtifact, buildZeroArtifact } from './artifact';
import type {
  AggregateAudience,
  AggregateQualityStatus,
  CalculationVersion,
  CareerEventFeature,
  CohortType,
  ConsentRecord,
  InternalProjectedContribution,
  RawAggregateEventInput,
  SafeAggregateArtifact,
} from '@/types/careerAggregate';

const HOUR_MS = 60 * 60 * 1000;

export type FeatureUsagePrevalenceInput = {
  events: readonly RawAggregateEventInput[];
  consentByUser: Record<string, ConsentRecord | undefined>;
  accountTypeByUser?: Record<string, string | undefined>;
  /** graduation_year cohort 用の user→卒年 割当（synthetic。raw profile reader へは接続しない）。 */
  cohortByUser?: Record<string, string | undefined>;
  target: {
    feature: CareerEventFeature;
    cohortType: CohortType;
    cohortValue: string;
    monthBucket: string; // YYYY-MM
    audience: AggregateAudience;
  };
  window: { sourceWindowStart: string; sourceWindowEnd: string };
  generatedAt: string; // ISO
  now: number; // epoch ms
  qualityStatus?: AggregateQualityStatus;
  /** version mismatch を試すための上書き（既定は metric の calculationVersion）。 */
  calculationVersionOverride?: string;
  options?: {
    allowRollUp?: boolean;
    freshnessDelayHours?: number;
    /** 任意複合 dimension（graduation_year × company 等）を試す用。 */
    extraDimensions?: readonly string[];
  };
};

function parseMs(occurredAt: unknown): number | null {
  if (typeof occurredAt === 'number') return Number.isFinite(occurredAt) ? occurredAt : null;
  if (typeof occurredAt === 'string') {
    const t = Date.parse(occurredAt);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function runFeatureUsagePrevalence(input: FeatureUsagePrevalenceInput): SafeAggregateArtifact {
  const metric = FEATURE_USAGE_PREVALENCE;
  const audience = input.target.audience;
  const consentScope = AUDIENCE_REQUIRED_SCOPE[audience];
  const qualityStatus: AggregateQualityStatus = input.qualityStatus ?? 'valid';
  const freshnessHours = input.options?.freshnessDelayHours ?? FRESHNESS_DELAY_HOURS;
  const freshnessCutoff = input.now - freshnessHours * HOUR_MS;

  const baseFor = (cohortType: CohortType, cohortValue: string, rolledUpFrom: CohortType | null) => ({
    feature: input.target.feature,
    cohortType,
    cohortValue,
    timeBucket: input.target.monthBucket,
    sourceWindowStart: input.window.sourceWindowStart,
    sourceWindowEnd: input.window.sourceWindowEnd,
    generatedAt: input.generatedAt,
    audience,
    consentScope,
    qualityStatus,
    rolledUpFrom,
  });

  // calculation version mismatch は数値を出さず suppressed。
  if (
    input.calculationVersionOverride !== undefined &&
    input.calculationVersionOverride !== (metric.calculationVersion as CalculationVersion)
  ) {
    return buildSuppressedArtifact(
      baseFor(input.target.cohortType, input.target.cohortValue, null),
      'invalid_calculation_version',
    );
  }

  // cohort dimension 妥当性（prohibited dimension / 任意複合 / 不正粒度）。
  const spec = validateCohortSpec({
    cohortType: input.target.cohortType,
    extraDimensions: input.options?.extraDimensions,
    timeGranularity: 'month',
  });
  if ('suppressed' in spec) {
    return buildSuppressedArtifact(
      baseFor(input.target.cohortType, input.target.cohortValue, null),
      spec.reason,
    );
  }

  const inCohort = (userKey: string, cohortType: CohortType, cohortValue: string): boolean => {
    if (cohortType === 'all') return true;
    return input.cohortByUser?.[userKey] === cohortValue;
  };

  const computeNumbers = (cohortType: CohortType, cohortValue: string) => {
    const projected: InternalProjectedContribution[] = [];
    for (const raw of input.events) {
      const userKey =
        raw && typeof raw.user_id === 'string' && raw.user_id.trim() !== '' ? raw.user_id.trim() : '';
      if (userKey === '') continue;
      if (!inCohort(userKey, cohortType, cohortValue)) continue;

      const ms = parseMs(raw.occurred_at);
      // freshness delay: 直近 window 内（incomplete）の event は寄与させない。
      if (ms !== null && ms > freshnessCutoff) continue;

      const eligibility = evaluateConsentEligibility({
        consent: input.consentByUser[userKey],
        audience,
        eventOccurredAt: ms ?? Number.NaN,
      });
      const res = projectAggregateContribution({
        raw,
        eligibility,
        metric,
        accountType: input.accountTypeByUser?.[userKey] ?? null,
      });
      if (res.ok && res.contribution.monthBucket === input.target.monthBucket) {
        projected.push(res.contribution);
      }
    }
    const bounded = boundContributions(projected);
    return {
      numerator: countUniqueUsersForFeature(bounded, input.target.feature, input.target.monthBucket),
      denominator: countUniqueUsersInMonth(bounded, input.target.monthBucket),
    };
  };

  const allowRollUp = input.options?.allowRollUp === true;

  // 1st pass（要求 cohort）。
  let { numerator, denominator } = computeNumbers(input.target.cohortType, input.target.cohortValue);
  const decision = evaluateCohort({ uniqueUsers: denominator, audience, cohortType: input.target.cohortType });

  if (!decision.suppressed) {
    return buildValidArtifact(baseFor(input.target.cohortType, input.target.cohortValue, null), {
      numerator,
      denominator,
    });
  }

  // suppressed: roll-up 可能かを判定。
  const canRollUp = allowRollUp && decision.rollUpCandidate === 'all' && input.target.cohortType === 'graduation_year';
  if (!canRollUp) {
    // roll-up しない場合、eligible contributor 0 は zero（既知ゼロ）として区別する。
    if (denominator === 0) return buildZeroArtifact(baseFor(input.target.cohortType, input.target.cohortValue, null));
    return buildSuppressedArtifact(baseFor(input.target.cohortType, input.target.cohortValue, null), decision.reason);
  }

  // roll-up: graduation_year → all で再集計・再判定。
  ({ numerator, denominator } = computeNumbers('all', 'all'));
  const rolledBase = baseFor('all', 'all', 'graduation_year');
  const decision2 = evaluateCohort({ uniqueUsers: denominator, audience, cohortType: 'all' });
  if (!decision2.suppressed) {
    return buildValidArtifact(rolledBase, { numerator, denominator });
  }
  if (denominator === 0) return buildZeroArtifact(rolledBase);
  return buildSuppressedArtifact(rolledBase, decision2.reason);
}

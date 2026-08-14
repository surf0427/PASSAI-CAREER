/**
 * Safe Aggregate Artifact builder（P14-B / P14-A §Safe artifact）。
 *
 * safe artifact は将来 aggregate store / fixed read model へ渡せる **公開型**。
 * 以下を **決して**含めない: user_id / hashed id / client_event_id / raw event id / exact timestamp /
 * raw metadata / company / score_band / raw row 逆参照 key。
 *
 * variant:
 *   - valid:      denominator >= threshold。numerator / denominator / prevalence / sampleSizeBucket。
 *   - zero:       eligible contributor 0（既知ゼロ・suppressed とは別）。ratio を持たない。
 *   - suppressed: cohort 不足 / 品質不良等。numerator / denominator / ratio を **持たない**。
 *
 * pure function。DB / Date.now 非依存（generatedAt は呼び出し側が注入）。
 */

import {
  AGGREGATE_DISCLAIMER_KEY,
  AGGREGATE_TTL_HOURS,
  FEATURE_USAGE_PREVALENCE,
} from './policy';
import type {
  AggregateAudience,
  AggregateProvenance,
  AggregateQualityStatus,
  CareerEventFeature,
  CohortType,
  ConsentScope,
  SafeAggregateArtifact,
  SafeAggregateArtifactBase,
  SampleSizeBucket,
  SuppressedAggregateArtifact,
  SuppressionReason,
  ValidAggregateArtifact,
  ZeroAggregateArtifact,
} from '@/types/careerAggregate';

const HOUR_MS = 60 * 60 * 1000;

/** unique-user 数を粗い bucket へ（生の小 count を出さない・threshold 未満は valid で現れない）。 */
export function toSampleSizeBucket(uniqueUsers: number): SampleSizeBucket {
  if (uniqueUsers >= 500) return '500+';
  if (uniqueUsers >= 200) return '200–499';
  if (uniqueUsers >= 100) return '100–199';
  return '50–99'; // valid は user_facing threshold(50) 以上のみここへ来る
}

function isoAfterHours(generatedAtIso: string, hours: number): string {
  const t = Date.parse(generatedAtIso);
  if (Number.isNaN(t)) return generatedAtIso;
  return new Date(t + hours * HOUR_MS).toISOString();
}

type BaseInput = {
  feature: CareerEventFeature;
  cohortType: CohortType;
  cohortValue: string;
  timeBucket: string; // YYYY-MM
  sourceWindowStart: string; // ISO
  sourceWindowEnd: string; // ISO
  generatedAt: string; // ISO
  audience: AggregateAudience;
  consentScope: ConsentScope;
  qualityStatus: AggregateQualityStatus;
  rolledUpFrom?: CohortType | null;
  /** Closure Batch（`D-C2`）: retention policy version（未確定なら null）。 */
  retentionPolicyVersion?: string | null;
};

/**
 * 現行 metric（feature_usage_prevalence）の唯一の入力 data class。
 * `lib/careerAggregate/sourceEligibility.ts` の allowlist と一致していること（QA が固定）。
 */
export const AGGREGATE_SOURCE_DATA_CLASS = 'event.feature_usage' as const;

function buildBase(input: BaseInput): SafeAggregateArtifactBase {
  const provenance: AggregateProvenance = {
    metricKey: FEATURE_USAGE_PREVALENCE.metricKey,
    calculationVersion: FEATURE_USAGE_PREVALENCE.calculationVersion,
    consentScope: input.consentScope,
    audience: input.audience,
    policyStatus: FEATURE_USAGE_PREVALENCE.status,
    rolledUpFrom: input.rolledUpFrom ?? null,
    // ★ この metric の唯一の eligible source（`sourceEligibility.ts` の allowlist と一致）。
    //   artifact 自身から「どの分類の data 由来か」を追えるようにする（Human 指示 §10）。
    sourceDataClass: AGGREGATE_SOURCE_DATA_CLASS,
    retentionPolicyVersion: input.retentionPolicyVersion ?? null,
  };
  return {
    metricKey: FEATURE_USAGE_PREVALENCE.metricKey,
    calculationVersion: FEATURE_USAGE_PREVALENCE.calculationVersion,
    feature: input.feature,
    cohortType: input.cohortType,
    cohortValue: input.cohortValue,
    timeBucket: input.timeBucket,
    sourceWindowStart: input.sourceWindowStart,
    sourceWindowEnd: input.sourceWindowEnd,
    generatedAt: input.generatedAt,
    expiresAt: isoAfterHours(input.generatedAt, AGGREGATE_TTL_HOURS),
    consentScope: input.consentScope,
    provenance,
    qualityStatus: input.qualityStatus,
    disclaimerKey: AGGREGATE_DISCLAIMER_KEY,
  };
}

/** suppressed artifact（数値を持たせない）。 */
export function buildSuppressedArtifact(
  input: BaseInput,
  reason: SuppressionReason,
): SuppressedAggregateArtifact {
  return { ...buildBase(input), kind: 'suppressed', suppression: { suppressed: true, reason } };
}

/** zero artifact（eligible contributor 0 の既知ゼロ）。 */
export function buildZeroArtifact(input: BaseInput): ZeroAggregateArtifact {
  return { ...buildBase(input), kind: 'zero', denominator: 0, suppression: { suppressed: false } };
}

/**
 * valid artifact（十分な cohort）。denominator 必須。numerator<=denominator を保証。
 * quality が valid でない場合は valid を作らず suppressed（品質不良を valid として返さない）。
 */
export function buildValidArtifact(
  input: BaseInput,
  numbers: { numerator: number; denominator: number },
): ValidAggregateArtifact | SuppressedAggregateArtifact {
  if (input.qualityStatus === 'stale') return buildSuppressedArtifact(input, 'stale_source');
  if (input.qualityStatus === 'incomplete') return buildSuppressedArtifact(input, 'incomplete_batch');
  if (input.qualityStatus === 'failed') return buildSuppressedArtifact(input, 'quality_check_failed');

  const denominator = Math.max(0, Math.floor(numbers.denominator));
  const numerator = Math.max(0, Math.min(denominator, Math.floor(numbers.numerator)));
  const prevalence = denominator > 0 ? numerator / denominator : 0;

  return {
    ...buildBase(input),
    kind: 'valid',
    numerator,
    denominator,
    prevalence,
    sampleSizeBucket: toSampleSizeBucket(denominator),
    suppression: { suppressed: false },
  };
}

/** artifact が公開数値を持つか（valid のみ true）。renderer / consumer の分岐用。 */
export function artifactHasPublicNumbers(a: SafeAggregateArtifact): a is ValidAggregateArtifact {
  return a.kind === 'valid';
}

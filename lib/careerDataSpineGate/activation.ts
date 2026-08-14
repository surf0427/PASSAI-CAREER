// PASSAI CAREER — Layer 4 / Layer 5 の **統合 activation gate**
// （Collective Intelligence Closure / `D-C7`）。
//
// Human 指示 §28 / §29:
//
// ```text
// Layer 4 / Layer 5 は minimum でも
//   feature flag AND infrastructure ready AND policy ready AND consent ready
// が揃わなければ OFF。Layer 5 はさらに moderation ready を要求。
// ```
//
// 既存の three-gate 群（flags / readiness / canary）はそのまま再利用し、
// 本 module は **1 つの連言判定**へまとめる。個々の gate を書き直さない。
//
// ★ `ACTIVATION_READY ≠ PRODUCTION_ENABLED`:
//   本 module が返す `activated` は「今この request で使ってよいか」であり、
//   `ACTIVATION_READY`（実装が完成しているか）とは別概念。
//   実装完成度は `evaluateActivationReadiness()` が返す。
//
// pure / deterministic / never-throw。env 読み取りは呼び出し側が注入する
// （本 module 自身は process.env を読まない＝テスト可能・default OFF を固定できる）。

import {
  evaluateLayerReadiness,
  LAYER4_REQUIRED_DECISIONS,
  LAYER5_REQUIRED_DECISIONS,
  type ReadinessConfig,
  type ReadinessDecisionKey,
} from '@/lib/careerDataSpinePolicy/readiness';
import {
  evaluateRetentionPolicy,
  type AggregateRetentionConfig,
} from '@/lib/careerAggregate/retention';

export type DataSpineLayer = 'layer4' | 'layer5';

/** activation を阻害している要因（enum のみ。値・識別子を含めない）。 */
export type ActivationBlocker =
  | 'flag_off'
  | 'user_not_canary'
  | 'infrastructure_not_ready'
  | 'policy_not_ready'
  | 'consent_not_ready'
  | 'moderation_not_ready'
  | 'retention_not_configured'
  | 'cohort_threshold_not_configured'
  | 'legal_not_approved';

export type ActivationInput = {
  layer: DataSpineLayer;
  /** feature flag（env 由来。呼び出し側が読む）。 */
  flagEnabled: boolean;
  /** requesting user が canary allowlist に居るか（server auth 由来 userId で判定済み）。 */
  userIsCanary: boolean;
  /** infra readiness（table / RLS / RPC / job が用意されているか）。 */
  infrastructureReady: boolean;
  /** policy readiness decision の承認状況。 */
  readinessConfig: ReadinessConfig | null | undefined;
  /** その user のその層向け consent が有効か（consent registry の判定結果）。 */
  consentReady: boolean;
  /** moderation backend が稼働しているか（Layer 5 のみ必須）。 */
  moderationReady: boolean;
  /** retention 設定（Layer 4 のみ必須）。 */
  retentionConfig?: AggregateRetentionConfig | null;
  /** cohort threshold が設定済みか（Layer 4 のみ必須）。 */
  cohortThresholdConfigured?: boolean;
  /** 法務承認（Layer 4/5 共通で必須）。 */
  legalApproved: boolean;
};

export type ActivationDecision =
  | { activated: true; layer: DataSpineLayer }
  | { activated: false; layer: DataSpineLayer; blockers: readonly ActivationBlocker[] };

/**
 * 層の activation 判定（**全条件の連言・fail-closed**）。
 *
 * ★ blocker は **すべて**返す（最初の 1 件で打ち切らない）。
 *   operator が「あと何が必要か」を一度に把握できるようにするため。
 * ★ 未指定 / undefined はすべて「未達」として扱う（`=== true` 判定）。
 */
export function evaluateActivation(input: ActivationInput): ActivationDecision {
  const blockers: ActivationBlocker[] = [];
  const layer = input?.layer === 'layer5' ? 'layer5' : 'layer4';

  if (input?.flagEnabled !== true) blockers.push('flag_off');
  if (input?.userIsCanary !== true) blockers.push('user_not_canary');
  if (input?.infrastructureReady !== true) blockers.push('infrastructure_not_ready');
  if (input?.consentReady !== true) blockers.push('consent_not_ready');
  if (input?.legalApproved !== true) blockers.push('legal_not_approved');

  const required: readonly ReadinessDecisionKey[] =
    layer === 'layer5' ? LAYER5_REQUIRED_DECISIONS : LAYER4_REQUIRED_DECISIONS;
  if (!evaluateLayerReadiness(input?.readinessConfig, required).ready) {
    blockers.push('policy_not_ready');
  }

  if (layer === 'layer4') {
    if (evaluateRetentionPolicy(input?.retentionConfig).status !== 'CONFIGURED') {
      blockers.push('retention_not_configured');
    }
    if (input?.cohortThresholdConfigured !== true) {
      blockers.push('cohort_threshold_not_configured');
    }
  }

  if (layer === 'layer5') {
    // ★ moderation backend が無い状態で shared knowledge を公開しない。
    if (input?.moderationReady !== true) blockers.push('moderation_not_ready');
  }

  return blockers.length === 0
    ? { activated: true, layer }
    : { activated: false, layer, blockers: [...new Set(blockers)].sort() };
}

/** 何も設定されていない状態（＝production の既定）を表す入力。 */
export const EMPTY_ACTIVATION_INPUT: Omit<ActivationInput, 'layer'> = {
  flagEnabled: false,
  userIsCanary: false,
  infrastructureReady: false,
  readinessConfig: null,
  consentReady: false,
  moderationReady: false,
  retentionConfig: null,
  cohortThresholdConfigured: false,
  legalApproved: false,
};

// ── ACTIVATION_READY（実装完成度）─────────────────────────────────
//
// ★ これは「有効化してよいか」ではなく「**実装が完成しているか**」の判定。
//   Human 指示 §34 の定義:
//     code path complete + schema complete/drafted + RLS complete + consent gates complete
//     + privacy guards complete + moderation gate complete(必要な層) + QA complete + default OFF

export type ActivationReadinessAspect =
  | 'code_path'
  | 'schema'
  | 'rls'
  | 'consent_gates'
  | 'privacy_guards'
  | 'moderation_gate'
  | 'qa'
  | 'default_off';

export const ACTIVATION_READINESS_ASPECTS: readonly ActivationReadinessAspect[] = [
  'code_path',
  'schema',
  'rls',
  'consent_gates',
  'privacy_guards',
  'moderation_gate',
  'qa',
  'default_off',
];

/** Layer 別に必要な aspect（Layer 4 は moderation を要求しない）。 */
export const LAYER_REQUIRED_ASPECTS: Readonly<
  Record<DataSpineLayer, readonly ActivationReadinessAspect[]>
> = {
  layer4: ['code_path', 'schema', 'rls', 'consent_gates', 'privacy_guards', 'qa', 'default_off'],
  layer5: ACTIVATION_READINESS_ASPECTS,
};

export type ActivationReadinessResult =
  | { ready: true; layer: DataSpineLayer }
  | { layer: DataSpineLayer; ready: false; missing: readonly ActivationReadinessAspect[] };

/**
 * 実装完成度の判定（fail-closed）。
 *
 * ★ `ready: true` になっても **production で有効になるわけではない**。
 *   有効化には `evaluateActivation()` の全条件が別途必要（＝Human decision + infra + flag）。
 */
export function evaluateActivationReadiness(
  layer: DataSpineLayer,
  aspects: Partial<Record<ActivationReadinessAspect, boolean>> | null | undefined,
): ActivationReadinessResult {
  const required = LAYER_REQUIRED_ASPECTS[layer] ?? LAYER_REQUIRED_ASPECTS.layer5;
  const missing = required.filter((a) => aspects?.[a] !== true);
  return missing.length === 0 ? { ready: true, layer } : { layer, ready: false, missing };
}

/**
 * ★ 「事故で有効化されない」ことを保証する検証（Human 指示 §29）。
 *
 * 以下はいずれも activation の根拠として **認めない**:
 *   - `NODE_ENV === 'production'`
 *   - env 未設定を true とみなす
 *   - 空 allowlist を全ユーザー許可とみなす
 *   - legal approval 未設定を approved とみなす
 *   - moderation module が存在するだけで ready とみなす
 *
 * 本関数は「与えられた根拠が accidental-enable パターンに該当しないか」を返す。
 */
export function isAccidentalEnablePattern(evidence: {
  nodeEnvIsProduction?: boolean;
  envVarUnset?: boolean;
  allowlistEmpty?: boolean;
  legalApprovalUnset?: boolean;
  moderationModuleExistsOnly?: boolean;
}): boolean {
  return (
    evidence.nodeEnvIsProduction === true ||
    evidence.envVarUnset === true ||
    evidence.allowlistEmpty === true ||
    evidence.legalApprovalUnset === true ||
    evidence.moderationModuleExistsOnly === true
  );
}

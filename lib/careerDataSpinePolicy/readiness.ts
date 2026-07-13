/**
 * Data Spine — production readiness gate（P17-C §9・pure）。
 *
 * 未決定の法務・技術判断が残ったまま loader を有効化できないようにする。
 * code default は NOT READY。partial config は NOT READY。全 approved のみ READY。
 *
 * ここでは具体的な法務値を hard-code しない（「承認済みか」という boolean のみ）。
 */

export type ReadinessDecisionKey =
  | 'target_project'
  | 'identity_strategy'
  | 'table_placement'
  | 'cohort_threshold'
  | 'retention'
  | 'revoke_delete_sla'
  | 'explicit_share_consent_version'
  | 'commercial_use'
  | 'confidentiality_policy_version'
  | 'moderation_owner'
  | 'takedown_process'
  | 'official_source_verification';

export const READINESS_DECISIONS: readonly ReadinessDecisionKey[] = [
  'target_project',
  'identity_strategy',
  'table_placement',
  'cohort_threshold',
  'retention',
  'revoke_delete_sla',
  'explicit_share_consent_version',
  'commercial_use',
  'confidentiality_policy_version',
  'moderation_owner',
  'takedown_process',
  'official_source_verification',
];

/** decision → approved(boolean)。未設定 key は未承認（NOT READY 要因）。 */
export type ReadinessConfig = Partial<Record<ReadinessDecisionKey, boolean>>;

export type ReadinessResult =
  | { ready: true }
  | { ready: false; missing: readonly ReadinessDecisionKey[] };

/** 全 decision が approved のときのみ ready（fail-closed）。 */
export function evaluateReadiness(config: ReadinessConfig | null | undefined): ReadinessResult {
  const missing = READINESS_DECISIONS.filter((k) => config?.[k] !== true);
  return missing.length === 0 ? { ready: true } : { ready: false, missing };
}

/** Layer 別に必要な最小 decision の subset（将来 Layer 単位で通電判定する用）。 */
export const LAYER4_REQUIRED_DECISIONS: readonly ReadinessDecisionKey[] = [
  'target_project', 'identity_strategy', 'table_placement', 'cohort_threshold', 'retention', 'revoke_delete_sla',
];
export const LAYER5_REQUIRED_DECISIONS: readonly ReadinessDecisionKey[] = [
  'target_project', 'identity_strategy', 'table_placement', 'explicit_share_consent_version',
  'confidentiality_policy_version', 'moderation_owner', 'takedown_process', 'official_source_verification',
];

export function evaluateLayerReadiness(
  config: ReadinessConfig | null | undefined,
  required: readonly ReadinessDecisionKey[],
): ReadinessResult {
  const missing = required.filter((k) => config?.[k] !== true);
  return missing.length === 0 ? { ready: true } : { ready: false, missing };
}

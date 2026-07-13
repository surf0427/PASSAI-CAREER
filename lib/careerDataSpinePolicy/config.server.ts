/**
 * Data Spine — server-authoritative readiness config reader（P17-C §9）。
 *
 * server-only。client 公開可能な env（NEXT_PUBLIC_*）だけで判定しない。
 * secret 値は読まない・出力しない（readiness は boolean flag のみ）。
 * env 未設定 → false → NOT READY（fail-closed）。
 */

import 'server-only';

import { READINESS_DECISIONS, evaluateReadiness, type ReadinessConfig, type ReadinessResult } from './readiness';

/** decision key → server env 変数名（boolean flag。secret ではない）。 */
export function readinessEnvName(key: string): string {
  return `CAREER_DATA_SPINE_READY_${key.toUpperCase()}`;
}

/** server env から readiness config を組む（値は boolean のみ・secret を読まない）。 */
export function getServerReadinessConfig(): ReadinessConfig {
  const cfg: ReadinessConfig = {};
  for (const key of READINESS_DECISIONS) {
    cfg[key] = process.env[readinessEnvName(key)] === 'true';
  }
  return cfg;
}

/** server readiness を評価する（default NOT READY）。 */
export function getServerReadiness(): ReadinessResult {
  return evaluateReadiness(getServerReadinessConfig());
}

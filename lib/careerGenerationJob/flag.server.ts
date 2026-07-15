/**
 * career generation job — members pilot flag（server-only / STEP-CAREER-GENJOB-01）。
 *
 * code default OFF。allowlist default empty。secret / 実 user ID を書かない。
 * lib/careerDataSpineGate/flags.server.ts と同形。
 *
 * 使い分け（route が step2 で判定する）:
 *   - pilot OFF: 従来の同期 route を維持（legacy path）。
 *   - pilot ON かつ member かつ storage 未 provision: GENERATION_JOB_STORAGE_UNAVAILABLE で停止
 *     （silent legacy fallback しない・Claude を呼ばない）。
 *   - undefined-table の silent legacy fallback は pilot OFF もしくは local/test に限定する。
 */

import 'server-only';

/** members pilot 有効か（明示 'true' のときだけ ON）。 */
export function isSelfAnalysisJobPilotEnabled(): boolean {
  return process.env.CAREER_SELF_ANALYSIS_JOB_PILOT_ENABLED === 'true';
}

/** canary allowlist（カンマ区切り user ID）。値は返さず、判定は allowlist 経由。 */
export function selfAnalysisJobCanaryAllowlist(): readonly string[] {
  const raw = process.env.CAREER_SELF_ANALYSIS_JOB_CANARY_USER_IDS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * 指定 user に対し pilot が有効か。
 * allowlist が空なら pilot ON で全 member 対象。allowlist があれば掲載 user のみ。
 */
export function isSelfAnalysisJobPilotEnabledForUser(userId: string): boolean {
  if (!isSelfAnalysisJobPilotEnabled()) return false;
  const allow = selfAnalysisJobCanaryAllowlist();
  if (allow.length === 0) return true;
  return allow.includes(userId);
}

/** local/test 環境か（undefined-table の legacy fallback を許す唯一の緩和条件）。 */
export function isLocalOrTestEnv(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/** flag 変数名（.env.example / operator packet 用・値は含めない）。 */
export const GENERATION_JOB_FLAG_NAMES: readonly string[] = [
  'CAREER_SELF_ANALYSIS_JOB_PILOT_ENABLED',
  'CAREER_SELF_ANALYSIS_JOB_CANARY_USER_IDS',
];

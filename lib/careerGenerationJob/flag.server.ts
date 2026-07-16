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

import { isPilotEnabledForUser } from './pilotTargeting';

/** members pilot 有効か（明示 'true' のときだけ ON）。 */
export function isSelfAnalysisJobPilotEnabled(): boolean {
  return process.env.CAREER_SELF_ANALYSIS_JOB_PILOT_ENABLED === 'true';
}

/**
 * 指定 user に対し pilot が有効か（**fail-closed**）。
 *   - flag OFF → false。
 *   - flag ON かつ allowlist 未設定 / 空 / malformed / wildcard → false（誰も job 経路に入れない）。
 *   - flag ON かつ valid allowlist → 掲載 UUID に exact 一致した member のみ true。
 * 判定は pure evaluator（pilotTargeting.ts）へ委譲する（env 値は log/戻り値へ露出しない）。
 */
export function isSelfAnalysisJobPilotEnabledForUser(userId: string): boolean {
  return isPilotEnabledForUser({
    flagEnabled: isSelfAnalysisJobPilotEnabled(),
    rawAllowlist: process.env.CAREER_SELF_ANALYSIS_JOB_CANARY_USER_IDS,
    userId,
  });
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

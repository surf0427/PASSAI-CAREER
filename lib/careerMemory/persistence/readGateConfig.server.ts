// PASSAI CAREER — Personal Memory READ gate config（P17-M1 / server-only env 読取）。
//
// 責務: server-only env（NEXT_PUBLIC_ を付けない）から read master flag + canary user allowlist を読み、
//   pure builder（readGate.ts）で config を組む。**client bundle へ入れない**（server-only）。値を log / 戻り値へ
//   生で露出しない。
//
// env（いずれも server-only。NEXT_PUBLIC_ 禁止＝client bundle 非混入・canary ID を browser へ出さない）:
//   - CAREER_PERSONAL_MEMORY_READ_ENABLED: "true"/"1"/"yes" で read 有効。未設定/その他は OFF（default OFF）。
//   - CAREER_PERSONAL_MEMORY_READ_CANARY_USER_IDS: comma-separated authenticated user UUID。
//     未設定 / 空 / 不正は readGate の parser が default deny 側へ倒す（誰も許可しない）。
//   - CAREER_PERSONAL_MEMORY_READ_ROLLOUT: "all" で authenticated member 全員へ開放。
//     未設定 / 空 / 未知値は "canary"（＝allowlist のみ）へ fail-closed。
//     ★ master flag と **独立**にしている理由: master だけ ON にしても allowlist が空なら
//       誰にも届かない（no-op）ため、「全開放する意思」を別 env で明示させる。
//   - CAREER_PERSONAL_MEMORY_READ_DENY_USER_IDS: 緊急 deny list（comma-separated UUID）。
//     scope を問わず最優先で拒否する。全開放後に master flag を落とさず個別縮退するための経路。
//     不正値は allowlist と同じく **設定全体 deny**（＝安全側）。

import 'server-only';

import {
  buildPersonalMemoryReadGateConfig,
  evalPersonalMemoryReadEnabled,
  type PersonalMemoryReadGateConfig,
} from './readGate';

export const CAREER_PM_READ_ENABLED_ENV = 'CAREER_PERSONAL_MEMORY_READ_ENABLED';
export const CAREER_PM_READ_CANARY_USER_IDS_ENV = 'CAREER_PERSONAL_MEMORY_READ_CANARY_USER_IDS';
export const CAREER_PM_READ_ROLLOUT_ENV = 'CAREER_PERSONAL_MEMORY_READ_ROLLOUT';
export const CAREER_PM_READ_DENY_USER_IDS_ENV = 'CAREER_PERSONAL_MEMORY_READ_DENY_USER_IDS';

/** master flag だけを安価に判定（DB read / client 生成前の early-out に使う。env のみ・I/O なし）。 */
export function isPersonalMemoryReadEnabled(): boolean {
  return evalPersonalMemoryReadEnabled(process.env[CAREER_PM_READ_ENABLED_ENV]);
}

/** server-only env から read gate config を組む（生値は返さない・log しない）。 */
export function loadPersonalMemoryReadGateConfigFromEnv(): PersonalMemoryReadGateConfig {
  return buildPersonalMemoryReadGateConfig(
    process.env[CAREER_PM_READ_ENABLED_ENV],
    process.env[CAREER_PM_READ_CANARY_USER_IDS_ENV],
    process.env[CAREER_PM_READ_ROLLOUT_ENV],
    process.env[CAREER_PM_READ_DENY_USER_IDS_ENV],
  );
}

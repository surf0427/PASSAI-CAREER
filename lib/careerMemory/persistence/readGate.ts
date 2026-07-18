// PASSAI CAREER — Personal Memory READ gate（P17-M1 / pure evaluator + parser）。
//
// 責務: Personal Memory の **server read** を「master flag ON かつ canary 許可 user」に限定する純粋判定。
//   write 側の shadowWriteFlag / canaryGate と **別系統**（read だけ ON / write だけ ON でも安全に成立させる）。
//   env / I/O を持たない（server env の読取は readGateConfig.server.ts の責務）。決定的・testable。
//
// ★ 方針:
//   - **default OFF / fail-closed**。master 未設定・空・不正は無効。canary allowlist が空・invalid・cap 超過は
//     「誰も許可しない」（default deny。既存 write canary と同じ・default allow に倒さない）。
//   - user allowlist の parse は canaryGate の parseCanaryUserIds を再利用（UUID 検証・cap・default deny を共有）。
//   - 値（UUID）を外部へ露出しない（本 module は log しない・戻り値に生 env を含めない）。

import { parseCanaryUserIds } from './canaryGate';

const ENABLED_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes']);

/** master flag 生値 → 有効/無効の純粋判定（未設定/invalid は fail-closed = false）。 */
export function evalPersonalMemoryReadEnabled(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  return ENABLED_VALUES.has(raw.trim().toLowerCase());
}

// parse 済み read gate config（master + user allowlist）。invalid allowlist は valid=false（全体 deny）。
export type PersonalMemoryReadGateConfig = {
  enabled: boolean;
  valid: boolean;
  userIds: readonly string[];
};

/** master 生値 + user allowlist 生値 → config（純粋・env 非依存）。 */
export function buildPersonalMemoryReadGateConfig(
  enabledRaw: unknown,
  userIdsRaw: unknown,
): PersonalMemoryReadGateConfig {
  const enabled = evalPersonalMemoryReadEnabled(enabledRaw);
  const parsed = parseCanaryUserIds(userIdsRaw);
  if (!parsed.valid) return { enabled, valid: false, userIds: [] };
  return { enabled, valid: true, userIds: parsed.userIds };
}

/**
 * read を許可してよいか（server 検証済みの authenticated userId のみ渡す・client 申告値は渡さない）。
 * allow iff master ON かつ config valid かつ userId が allowlist に exact 一致。
 * master OFF・config invalid・allowlist 空・userId 空/未一致はすべて deny（default OFF）。
 */
export function evaluatePersonalMemoryReadGate(
  userId: string | null | undefined,
  config: PersonalMemoryReadGateConfig,
): boolean {
  if (!config.enabled || !config.valid) return false;
  if (typeof userId !== 'string' || userId === '') return false;
  return config.userIds.includes(userId); // exact match（substring しない）
}

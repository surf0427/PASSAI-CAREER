// PASSAI CAREER — Server Context canary gate（Canary activation / 純粋判定）。
//
// 責務: 「server-driven context を、どの purpose の、どの user に対して有効にしてよいか」の
//   **純粋判定**。env 読取は canaryGate.server.ts の責務。
//
// ★ なぜ purpose flag だけでは不足か:
//   `CAREER_SERVER_CONTEXT_PURPOSES=interview_practice` だけだと、その purpose を使う
//   **全ユーザー** が新経路に乗ってしまう。これは canary ではない。
//   本 gate は purpose に加えて **user allowlist** を要求し、1 ユーザー限定運用を可能にする。
//
// ★ 方針（既存 Personal Memory canary と同一の安全既定）:
//   - **default deny / fail-closed**。allowlist 未設定・空・invalid は「誰も許可しない」。
//   - UUID の parse は既存 `parseCanaryUserIds` を再利用（不正 1 件で設定全体 deny・cap・exact match）。
//     同じ意味論を 2 箇所で実装しない。
//   - userId は **server auth 由来のみ**を渡す（client 申告値を渡す経路を作らない）。
//   - 値（UUID）を log しない・戻り値へ生 env を含めない。

import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import { parseCanaryUserIds } from '@/lib/careerMemory/persistence/canaryGate';
import { isServerContextEnabledForPurpose } from './baseContextPolicy';

/** parse 済み canary config（purpose 集合 + user allowlist）。invalid は全体 deny。 */
export type ServerContextCanaryConfig = {
  purposes: readonly CareerContextPurpose[];
  /** allowlist が invalid（不正 UUID 混入 / cap 超過）なら false ＝ 全体 deny。 */
  valid: boolean;
  userIds: readonly string[];
};

/** purpose 集合と user allowlist から config を組む（純粋・env 非依存）。 */
export function buildServerContextCanaryConfig(
  purposes: readonly CareerContextPurpose[],
  userIdsRaw: unknown,
): ServerContextCanaryConfig {
  const parsed = parseCanaryUserIds(userIdsRaw);
  if (!parsed.valid) return { purposes, valid: false, userIds: [] };
  return { purposes, valid: true, userIds: parsed.userIds };
}

/** purpose が canary 対象として有効か（user 判定の前段。I/O を避けるための早期 out）。 */
export function isServerContextPurposeEnabled(
  purpose: CareerContextPurpose,
  config: ServerContextCanaryConfig,
): boolean {
  return isServerContextEnabledForPurpose(purpose, config.purposes);
}

/**
 * server-derived context を使ってよい user か（default deny）。
 *
 * allow iff: config valid かつ allowlist が非空かつ userId が exact 一致。
 * ★ allowlist が空 = 「全員許可」ではなく「誰も許可しない」。
 */
export function isServerContextCanaryUser(
  userId: string | null | undefined,
  config: ServerContextCanaryConfig,
): boolean {
  if (!config.valid) return false;
  if (typeof userId !== 'string' || userId === '') return false;
  return config.userIds.includes(userId); // exact match（substring しない）
}

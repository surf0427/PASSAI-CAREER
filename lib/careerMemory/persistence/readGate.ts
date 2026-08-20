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

// ── rollout scope（Production 全面開放のための最小機構） ────────────────────
//
// 背景: 従来の gate は「master ON **かつ** allowlist に exact 一致」だけを許可していたため、
//   全ユーザーへ開放する手段が **allowlist に全 UUID を列挙する** ことしかなかった
//   （運用不能・cap 50 で不可能・列挙は明示的に禁止）。
//   master flag を ON にしても allowlist が空なら **誰にも届かない**（＝成功したように見えて no-op）。
//   そのため rollout の意思を表す独立した scope を持たせる。
//
// scope:
//   'canary'（既定）… 従来どおり allowlist exact 一致のみ許可。**現行挙動と完全に同じ**。
//   'all'            … authenticated member 全員を許可（後述の deny list を除く）。
//
// ★ fail-closed: 未設定 / 空 / 未知の値はすべて 'canary' に落とす（勝手に全開放しない）。
// ★ canary 機構は削除しない（rollout 後も縮退先として保持する。`D-S2` の rollback contract）。
export type PersonalMemoryReadRolloutScope = 'canary' | 'all';

/** rollout scope 生値 → scope（純粋・未知値は 'canary' へ fail-closed）。 */
export function evalPersonalMemoryReadRollout(raw: unknown): PersonalMemoryReadRolloutScope {
  if (typeof raw !== 'string') return 'canary';
  return raw.trim().toLowerCase() === 'all' ? 'all' : 'canary';
}

// parse 済み read gate config（master + scope + allowlist + emergency deny list）。
//   invalid な allowlist / deny list は valid=false（設定全体 deny）。
export type PersonalMemoryReadGateConfig = {
  enabled: boolean;
  valid: boolean;
  scope: PersonalMemoryReadRolloutScope;
  /** canary scope で許可する user（scope='all' では未使用だが保持する）。 */
  userIds: readonly string[];
  /**
   * 緊急 deny list（scope を問わず **最優先で拒否**）。
   * 全開放後に個別ユーザーだけ止めたいときに、master flag を落とさずに縮退させるための経路。
   */
  deniedUserIds: readonly string[];
};

/**
 * master / allowlist / rollout scope / deny list の生値 → config（純粋・env 非依存）。
 *
 * ★ 後方互換: rolloutRaw / denyRaw を省略すると scope='canary'・deny 空 ＝ 従来と同一挙動。
 */
export function buildPersonalMemoryReadGateConfig(
  enabledRaw: unknown,
  userIdsRaw: unknown,
  rolloutRaw?: unknown,
  denyRaw?: unknown,
): PersonalMemoryReadGateConfig {
  const enabled = evalPersonalMemoryReadEnabled(enabledRaw);
  const scope = evalPersonalMemoryReadRollout(rolloutRaw);
  const parsed = parseCanaryUserIds(userIdsRaw);
  const denied = parseCanaryUserIds(denyRaw);
  // deny list が壊れているときに「誰も拒否できないまま全開放」になるのは危険なので、
  // allowlist と同様に **設定全体 deny** へ倒す。
  if (!parsed.valid || !denied.valid) {
    return { enabled, valid: false, scope, userIds: [], deniedUserIds: [] };
  }
  return { enabled, valid: true, scope, userIds: parsed.userIds, deniedUserIds: denied.userIds };
}

/**
 * read を許可してよいか（server 検証済みの authenticated userId のみ渡す・client 申告値は渡さない）。
 *
 * 判定順（安全側から）:
 *   1. master OFF / config invalid → deny
 *   2. userId 不在（guest / anonymous）→ deny
 *   3. emergency deny list に一致 → deny（scope を問わない）
 *   4. scope='all' → allow
 *   5. scope='canary' → allowlist に exact 一致したときのみ allow
 */
export function evaluatePersonalMemoryReadGate(
  userId: string | null | undefined,
  config: PersonalMemoryReadGateConfig,
): boolean {
  if (!config.enabled || !config.valid) return false;
  if (typeof userId !== 'string' || userId === '') return false;
  if (config.deniedUserIds.includes(userId)) return false; // 緊急 deny が最優先
  if (config.scope === 'all') return true;
  return config.userIds.includes(userId); // exact match（substring しない）
}

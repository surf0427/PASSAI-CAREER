// PASSAI CAREER — Personal Memory server-side rebuild flag の評価（NEXT-4 / hardening 2026-08-14）。
//
// 責務: 「stale/missing section を request-local で rebuild するか」を決める **純粋判定**。
//   env 読取は serverSourceFlagConfig.server.ts の責務。
//
// ★★ D-R1 rollback path は削除済み（2026-08-14 hardening / `D-S2`）★★
//   以前は `CAREER_PERSONAL_MEMORY_LEGACY_D_R1=true` で「永続 status='fresh' を無検証で信じる」
//   旧挙動へ戻せたが、これは **既知の stale-injection risk を持つ architecture を production で
//   復活させる** rollback であり、安全な退避経路ではない。
//
//   安全な rollback は「context を減らす」方向のみ:
//     1. `CAREER_PERSONAL_MEMORY_READ_ENABLED` を外す → Personal Memory 読取そのものを停止
//     2. `CAREER_SERVER_CONTEXT_PURPOSES` を空にする → server base context を停止
//     3. → 既存の request-body bridge / Memory 無し挙動へ縮退
//   詳細は DATA_SPINE_DECISIONS.md `D-S2`（Rollback contract）。
//
// ★ Source 読取と sync 検証（`D-S1` veto）は **flag を持たない**。
//   「検証できないものを使わない」を opt-in にすると既定が危険側になるため、常時有効。

const TRUE_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes']);

function isTrue(raw: unknown): boolean {
  return typeof raw === 'string' && TRUE_VALUES.has(raw.trim().toLowerCase());
}

export type PersonalMemoryServerSourceConfig = {
  // stale / missing / invalid section を request-local に rebuild して prompt へ使うか。
  //   OFF にしても「古い Memory を使う」側へは倒れない（単に Memory 無しになる）。
  rebuildOnStaleEnabled: boolean;
};

/**
 * 生 env 値から config を組む（純粋・env 非依存）。
 * - rebuildDisabledRaw が true → rebuild しない（stale/missing は単に Memory 不使用）。
 *
 * ★ どの値を渡しても「検証なしで永続 Memory を使う」経路は生成されない（D-R1 は復活しない）。
 */
export function buildPersonalMemoryServerSourceConfig(
  rebuildDisabledRaw: unknown,
): PersonalMemoryServerSourceConfig {
  return { rebuildOnStaleEnabled: !isTrue(rebuildDisabledRaw) };
}

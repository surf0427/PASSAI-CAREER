// PASSAI CAREER — server-side freshness / rebuild flag の env 読取（NEXT-3 / NEXT-4）。
//
// env（server-only。NEXT_PUBLIC_ 禁止）:
//   - CAREER_PERSONAL_MEMORY_SERVER_REBUILD_DISABLED: "true"/"1"/"yes" で rebuild-on-stale を止める
//     （stale/missing は単に Memory 無しへ fail-open）。未設定は rebuild 有効（既定）。
//
// ★ `CAREER_PERSONAL_MEMORY_LEGACY_D_R1` は **削除済み**（2026-08-14 hardening / `D-S2`）。
//   既知の stale-injection risk を持つ D-R1 挙動を production で復活させる env は提供しない。
//   安全な rollback は `CAREER_PERSONAL_MEMORY_READ_ENABLED` /
//   `CAREER_SERVER_CONTEXT_PURPOSES` を外して **context を減らす** 方向のみ。
//
// 値は log しない・戻り値へ生 env を含めない。

import 'server-only';

import {
  buildPersonalMemoryServerSourceConfig,
  type PersonalMemoryServerSourceConfig,
} from './serverSourceFlag';

export const CAREER_PM_SERVER_REBUILD_DISABLED_ENV =
  'CAREER_PERSONAL_MEMORY_SERVER_REBUILD_DISABLED';

export function loadPersonalMemoryServerSourceConfigFromEnv(): PersonalMemoryServerSourceConfig {
  return buildPersonalMemoryServerSourceConfig(
    process.env[CAREER_PM_SERVER_REBUILD_DISABLED_ENV],
  );
}

// PASSAI CAREER — Personal Memory Shadow-Write feature flag（P16-D）。
//
// 種別: Deployment guard（build-time env・再デプロイで停止/再開）。lib/careerMemory/eventSignalPilotGuard.ts と同形。
//   env を 1 回読んでキャッシュ・throw しない・default-safe（未設定/invalid は無効）。
//
// Env var:
//   `NEXT_PUBLIC_CAREER_PERSONAL_MEMORY_SHADOW_WRITE_ENABLED`
//     - "true" / "1" / "yes"（trim + 小文字化）→ shadow-write 有効。
//     - それ以外（未設定 / 空 / 不明値 / 非文字列）→ **fail-closed = 無効（default OFF）**。
//   NEXT_PUBLIC_ prefix のため client bundle に build 時 inline される。切替後は再 build / 再 deploy が必要。
//
// 方針:
//   - secret ではない。env 生値を表示しない。boolean 判定を本モジュール 1 箇所へ集約する
//     （callsite は直接 process.env を読まない）。
//   - 無効時は shadow write を一切行わない（repository 生成・DB query もしない）＝既存 Source 保存挙動は完全不変。
//   - production 配線後も、ユーザーが明示的に有効化するまで shadow write は実行されない。

const ENABLED_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes']);

/** env 生値 → 有効/無効の純粋判定（QA 可能。未設定/invalid は fail-closed = false）。 */
export function evalCareerPersonalMemoryShadowWriteEnabled(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  return ENABLED_VALUES.has(raw.trim().toLowerCase());
}

let cachedEnabled: boolean | undefined;

/** Personal Memory shadow-write が有効か（build-time env・1 回読んでキャッシュ）。default OFF。 */
export function isCareerPersonalMemoryShadowWriteEnabled(): boolean {
  if (cachedEnabled === undefined) {
    cachedEnabled = evalCareerPersonalMemoryShadowWriteEnabled(
      process.env.NEXT_PUBLIC_CAREER_PERSONAL_MEMORY_SHADOW_WRITE_ENABLED,
    );
  }
  return cachedEnabled;
}

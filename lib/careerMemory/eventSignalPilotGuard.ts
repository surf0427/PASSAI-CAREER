/**
 * Consultation Event Signal Pilot の Operational Guard（P10-F）。
 *
 * 種別: **Deployment guard**（build-time env・再デプロイで停止/再開）。Remote kill switch ではない。
 *   設計は lib/examDiagnosis/flag.ts と同形（env を 1 回読んでキャッシュ・throw しない・default-safe）。
 *
 * Env var:
 *   `NEXT_PUBLIC_CAREER_EVENT_SIGNAL_PILOT_ENABLED`
 *     - "true" / "1" / "yes"（trim + 小文字化）→ pilot 有効。
 *     - それ以外（未設定 / 空 / 不明値 / 非文字列）→ **fail-closed = 無効**。
 *   NEXT_PUBLIC_ prefix のため client / server 両 bundle に同一値が build 時 inline される
 *   （＝client と server で意味がずれない。server が authoritative に同じ値を独立判定できる）。
 *   ⚠ build 時に値が固定される。切替後は再 build / 再 deploy が必要。
 *
 * fail-closed 方針:
 *   - 未設定 / invalid はすべて **無効**（Signal を使わない＝P10-D 以前の consultation に戻る）。
 *   - guard は boolean のみを返す純粋判定。userId / request body / localStorage / query に依存しない。
 *   - secret を扱わない。matching 等 他 purpose を有効化しない（consultation 専用）。
 */

const ENABLED_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes']);

/** env 生値 → 有効/無効の純粋判定（QA 可能。invalid/未設定は fail-closed = false）。 */
export function evalConsultationEventSignalPilotEnabled(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  return ENABLED_VALUES.has(raw.trim().toLowerCase());
}

let cachedEnabled: boolean | undefined;

/**
 * Consultation Event Signal Pilot が有効か（build-time env・1 回読んでキャッシュ）。
 * client（consultation page）/ server（consultation route）双方が同じ build-inline 値を読む。
 */
export function isConsultationEventSignalPilotEnabled(): boolean {
  if (cachedEnabled === undefined) {
    cachedEnabled = evalConsultationEventSignalPilotEnabled(
      process.env.NEXT_PUBLIC_CAREER_EVENT_SIGNAL_PILOT_ENABLED,
    );
  }
  return cachedEnabled;
}

/**
 * client load 境界の gate（純粋）: member かつ pilot 有効のときだけ Signal loader を呼ぶ。
 * guest / guard OFF では false → loader 非実行（reader 0 回・1000ms 待ちなし・body 付与なし）。
 */
export function shouldLoadConsultationEventSignals(
  userId: string | null | undefined,
  enabled: boolean,
): boolean {
  return typeof userId === 'string' && userId.trim() !== '' && enabled;
}

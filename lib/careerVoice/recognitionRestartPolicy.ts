// PASSAI CAREER — 音声認識が終了したときの「再開してよいか」判定（純関数・環境非依存）。
//
// STEP-CAREER-PRESENTATION-HARDENING-P1-3（Production Readiness Audit P1-3）。
//
// 背景:
//   Web Speech API（Chrome / webkitSpeechRecognition）は continuous=true でも、無音・
//   ネットワークの揺らぎ・ブラウザ内部都合で **発表の途中に onend を発火する**。
//   従来の useVoice は onend で listening=false にするだけだったため、3 分の発表中に
//   録音が黙って止まり、ユーザーは何も気づけなかった。
//
// 本 module は「その onend は再開してよいのか」だけを決める純関数。
//   - ブラウザ API を触らない（QA が deterministic に検証できる）
//   - 無限 restart loop を作らない（rolling window で暴走を検出して止める）
//
// ★ 「無言で止まる」を絶対に作らないため、再開しない場合は必ず
//   'stop-notify'（UI に停止を知らせる）か 'stop-silent'（ユーザー自身が止めた等、
//   通知が不要と分かっている場合のみ）を返す。既定は notify 側に倒す。

/** rolling window の長さ（ms）。この窓の中での再開回数を暴走判定に使う。 */
export const RESTART_WINDOW_MS = 10_000;
/** rolling window 内で許す最大再開回数。これを超えたら暴走とみなして止める。 */
export const RESTART_MAX_IN_WINDOW = 5;
/** 再開までの待ち時間（ms）。即時 start() は Chrome が InvalidStateError を返しやすい。 */
export const RESTART_DELAY_MS = 250;

export type RecognitionEndReason =
  /** ユーザーが停止ボタンを押した。 */
  | 'manual_stop'
  /** 制限時間に到達して停止した。 */
  | 'time_limit'
  /** component が unmount された。 */
  | 'unmounted'
  /** onerror 経由の停止（権限拒否・マイク無し等）。すでにエラー文言が出ている。 */
  | 'error'
  /** 上記以外＝ブラウザ都合の予期しない停止。 */
  | 'unexpected';

export type RecognitionRestartDecision =
  /** 再開する。 */
  | 'restart'
  /** 再開しない。UI 通知も不要（意図された停止）。 */
  | 'stop-silent'
  /** 再開しない。**必ず UI に「停止した」と表示する**。 */
  | 'stop-notify';

export type RecognitionRestartInput = {
  reason: RecognitionEndReason;
  /** 自動再開が有効か（面接など従来挙動を保つ画面は false）。 */
  autoRestartEnabled: boolean;
  /** ユーザーがまだ発表中か（発表を終えていれば再開しない）。 */
  presenting: boolean;
  /** 直近の再開時刻（ms epoch）の配列。呼び出し側が保持する。 */
  recentRestarts: readonly number[];
  /** 現在時刻（ms epoch）。テストのため注入する。 */
  now: number;
};

/** rolling window 内に収まる再開時刻だけを残す。 */
export function pruneRestarts(
  recentRestarts: readonly number[],
  now: number,
): number[] {
  return recentRestarts.filter((t) => now - t < RESTART_WINDOW_MS);
}

/**
 * 認識終了時に再開すべきかを決める。
 *
 * 判定順（先勝ち）:
 *   1. 意図された停止（manual / time limit / unmount）→ 再開しない・通知不要
 *   2. 自動再開が無効 → 予期しない停止なら通知だけする（無言で止めない）
 *   3. 発表中でない → 再開しない・通知不要
 *   4. error 由来 → 再開しない。**通知する**（エラー文言と別に「止まった」事実を出す）
 *   5. rolling window 内の再開が多すぎる → 暴走とみなし再開しない・通知する
 *   6. それ以外 → 再開する
 */
export function decideRecognitionRestart(
  input: RecognitionRestartInput,
): RecognitionRestartDecision {
  const { reason, autoRestartEnabled, presenting, recentRestarts, now } = input;

  // 1) 意図された停止。
  if (reason === 'manual_stop' || reason === 'time_limit' || reason === 'unmounted') {
    return 'stop-silent';
  }

  // 2) 自動再開が無効（面接など従来挙動）。予期しない停止だけは知らせる。
  if (!autoRestartEnabled) {
    return reason === 'unexpected' ? 'stop-notify' : 'stop-silent';
  }

  // 3) 発表を終えているなら再開しない。
  if (!presenting) return 'stop-silent';

  // 4) エラー由来は再開しない（権限拒否のループを作らない）。停止の事実は伝える。
  if (reason === 'error') return 'stop-notify';

  // 5) 暴走検出（短時間に再開しすぎ）。
  if (pruneRestarts(recentRestarts, now).length >= RESTART_MAX_IN_WINDOW) {
    return 'stop-notify';
  }

  // 6) 通常の「ブラウザ都合の中断」→ 再開する。
  return 'restart';
}

/** 認識が止まったことを伝える共通文言（面接・プレゼンで同一表現にする）。 */
export const RECOGNITION_STOPPED_MESSAGE =
  '音声認識が停止しました。「録音して発表する」をもう一度押して再開してください。ここまでの文字起こしは保存されています。';

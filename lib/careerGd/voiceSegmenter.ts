/**
 * PASSAI 就活版 — GD 発話区切りの状態機械（STEP-GD-VOICE）。
 *
 * ★ なぜ純関数として切り出すか:
 *   「いつ 1 発言が終わったか」の判断は GD の**進行そのもの**である。
 *   ここが誤ると、発言が途中で切れる / 2 人ぶんが 1 発言に混ざる / 無音を課金付きで
 *   STT へ投げる、という形で商品が壊れる。UI の中に埋めると実機でしか検証できなくなるため、
 *   時刻と音量を入力に取る決定的な関数として独立させ、QA で境界を直接検証する。
 *
 * 設計:
 *   ユーザーは「押して話す」必要がない。マイクは常時開いており、本機械が
 *   音量の時系列から発話の開始と終了を判定して 1 クリップに切り出す。
 *   これにより GD 中の操作は **ミュート以外ゼロ**になる（キーボード入力は当然ゼロ）。
 *
 * 録音との対応:
 *   MediaRecorder は**止めずに回し続ける**。本機械が 'cut' を返した瞬間だけ
 *   stop() → 完全な 1 ファイルを取得 → 即 start() で次セグメントへ入る。
 *   セグメント境界を無音の中に置くので、発話の頭も末尾も欠けない
 *   （発話検出の瞬間に録音を開始する実装だと語頭が必ず削れる）。
 */

// ── しきい値 ────────────────────────────────────────────────────────

/**
 * 発話とみなす RMS 音量のしきい値（0〜1 正規化）。
 * エコーキャンセル・ノイズ抑制が効いた状態の環境音は概ね 0.01 未満に収まる。
 */
export const GD_VAD_SPEECH_RMS = 0.02;

/**
 * これだけ連続して超えたら「発話が始まった」と判定する（ms）。
 * 短くしすぎるとドアの音・咳で発話開始になる。
 */
export const GD_VAD_SPEECH_ONSET_MS = 180;

/**
 * 発話後、これだけ無音が続いたら 1 発言の終わりとみなす（ms）。
 *
 * 短いと「えー、」の後の間で切れて発言が分断され、長いと相手が話し始めるまで
 * 自分の発言が投稿されない。日本語の GD では 1.1〜1.5 秒が実用域。
 */
export const GD_VAD_SILENCE_HANGOVER_MS = 1200;

/**
 * 発話が検出されないまま録音を回し続ける最大時間（ms）。
 * 超えたらセグメントを捨てて録音を作り直す（無音の巨大 buffer を抱えない）。
 */
export const GD_VAD_IDLE_RECYCLE_MS = 20_000;

/**
 * 1 セグメントの最大長（ms）。話し続けている場合でもここで一度切る。
 * 長すぎるクリップは STT のレイテンシと失敗時の損失が大きいため。
 */
export const GD_VAD_MAX_SEGMENT_MS = 90_000;

// ── 状態 ────────────────────────────────────────────────────────────

export type GdSegmenterState = {
  /** 現セグメントの録音開始時刻（ms epoch）。 */
  segmentStartedAt: number;
  /** 現セグメント内で一度でも発話を検出したか。false のセグメントは STT へ送らない。 */
  hadSpeech: boolean;
  /** 現在発話中と判定しているか（UI の「あなたが話しています」表示に使う）。 */
  speaking: boolean;
  /** しきい値を連続で超え始めた時刻（未超過なら null）。onset 判定に使う。 */
  aboveSince: number | null;
  /** 発話後にしきい値を下回り始めた時刻（発話中でないか超過中なら null）。 */
  belowSince: number | null;
};

export function createGdSegmenterState(now: number): GdSegmenterState {
  return {
    segmentStartedAt: now,
    hadSpeech: false,
    speaking: false,
    aboveSince: null,
    belowSince: null,
  };
}

/**
 * 1 tick の判定結果。
 *   'none'    … 何もしない
 *   'cut'     … 発話が終わった。録音を stop→start し、得たクリップを STT へ送る
 *   'recycle' … 発話が無いまま長く回った。録音を stop→start し、クリップは**捨てる**
 */
export type GdSegmenterAction = 'none' | 'cut' | 'recycle';

export type GdSegmenterTick = {
  state: GdSegmenterState;
  action: GdSegmenterAction;
  /** 発話中フラグが今回の tick で変化したか（UI 更新を最小化するため）。 */
  speakingChanged: boolean;
};

export type GdSegmenterInput = {
  /** 直近フレームの RMS 音量（0〜1）。 */
  rms: number;
  /** 現在時刻（ms epoch）。 */
  now: number;
  /**
   * ミュート中か。true の間は一切発話とみなさない。
   * ★ ミュート解除の瞬間に「ミュート中に溜まった音」で誤発火しないよう、
   *   ミュート中は onset 判定用の時刻も常にリセットする。
   */
  muted?: boolean;
};

/**
 * 音量 1 サンプルを与えて状態を進める。副作用なし・同じ入力なら同じ出力。
 */
export function tickGdSegmenter(
  prev: GdSegmenterState,
  input: GdSegmenterInput,
): GdSegmenterTick {
  const { rms, now } = input;
  const muted = input.muted === true;

  // ミュート中: 発話判定を完全に止める。既に発話中だったなら、その発話は
  // ここで確定させる（話している途中でミュートされた内容は捨てない）。
  if (muted) {
    if (prev.speaking && prev.hadSpeech) {
      return {
        state: createGdSegmenterState(now),
        action: 'cut',
        speakingChanged: true,
      };
    }
    const state: GdSegmenterState = {
      ...prev,
      speaking: false,
      aboveSince: null,
      belowSince: null,
    };
    return { state, action: 'none', speakingChanged: prev.speaking };
  }

  const above = rms >= GD_VAD_SPEECH_RMS;
  let { speaking, aboveSince, belowSince, hadSpeech } = prev;
  const wasSpeaking = speaking;

  if (above) {
    belowSince = null;
    if (aboveSince === null) aboveSince = now;
    // 一定時間続いて初めて「発話」に昇格する（単発のノイズを弾く）。
    if (!speaking && now - aboveSince >= GD_VAD_SPEECH_ONSET_MS) {
      speaking = true;
      hadSpeech = true;
    }
  } else {
    aboveSince = null;
    if (speaking) {
      if (belowSince === null) belowSince = now;
      if (now - belowSince >= GD_VAD_SILENCE_HANGOVER_MS) {
        // 発話の終わり。ここがセグメント境界（無音の中で切るので語尾が欠けない）。
        return {
          state: createGdSegmenterState(now),
          action: 'cut',
          speakingChanged: true,
        };
      }
    }
  }

  const elapsed = now - prev.segmentStartedAt;

  // 話し続けている場合の強制分割。切った直後も発話は続いているとみなす
  // （次セグメントの先頭から拾えるよう hadSpeech / speaking を引き継ぐ）。
  if (hadSpeech && elapsed >= GD_VAD_MAX_SEGMENT_MS) {
    const next = createGdSegmenterState(now);
    next.speaking = speaking;
    next.hadSpeech = speaking;
    return { state: next, action: 'cut', speakingChanged: false };
  }

  // 無音のまま回り続けたら録音を作り直す（クリップは捨てるので課金も発生しない）。
  if (!hadSpeech && elapsed >= GD_VAD_IDLE_RECYCLE_MS) {
    return {
      state: createGdSegmenterState(now),
      action: 'recycle',
      speakingChanged: wasSpeaking,
    };
  }

  const state: GdSegmenterState = {
    segmentStartedAt: prev.segmentStartedAt,
    hadSpeech,
    speaking,
    aboveSince,
    belowSince,
  };
  return { state, action: 'none', speakingChanged: wasSpeaking !== speaking };
}

/**
 * 時間領域の PCM フレームから RMS（0〜1）を出す。
 * AnalyserNode.getFloatTimeDomainData の出力をそのまま渡す。
 */
export function rmsOfFrame(frame: Float32Array | ArrayLike<number>): number {
  const len = frame.length;
  if (len === 0) return 0;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const v = frame[i];
    sum += v * v;
  }
  return Math.sqrt(sum / len);
}

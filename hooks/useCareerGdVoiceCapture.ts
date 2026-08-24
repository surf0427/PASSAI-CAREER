'use client';

/**
 * PASSAI 就活版 — GD 発言の音声取得 Hook（STEP-GD-VOICE）。
 *
 * ユーザーの発言を **マイク音声からのみ** 取得する。GD 中の操作はミュート以外に無く、
 * 「押して話す」ボタンすら不要（話し始めと話し終わりは lib/careerGd/voiceSegmenter が判定する）。
 *
 * 流れ:
 *   マイク stream → AnalyserNode で音量監視 → segmenter が発話の切れ目を判定
 *     → その瞬間だけ MediaRecorder を stop/start して 1 発言ぶんのクリップを取り出す
 *     → POST /api/career/gd/voice/stt → transcript を onTranscript へ渡す
 *
 * ★ MediaRecorder は**止めずに回し続ける**（発話検出時に start する実装にしない）。
 *   セグメント境界を無音の中に置くので、語頭・語尾が欠けない。
 *
 * ★ 本 Hook は発言を保存しない。保存経路（ソロ = localStorage transcript /
 *   マルチ = POST /room/[roomId]/messages）は音声化前と同一のまま呼び出し側が持つ。
 *   音声はテキストの取得手段にすぎない、という境界をここで固定する。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  GD_VOICE_MAX_CLIP_BYTES,
  pickGdRecorderMimeType,
} from '@/lib/careerGd/voice';
import {
  createGdSegmenterState,
  rmsOfFrame,
  tickGdSegmenter,
  type GdSegmenterState,
} from '@/lib/careerGd/voiceSegmenter';

// 音量サンプリング間隔。背景タブでは 1 秒へ丸められるが、無音判定（1.2 秒）は成立する。
const ANALYSIS_INTERVAL_MS = 50;

// 1 クリップが極端に小さい（＝ほぼ無音）ときは STT へ送らない。課金と誤検出の両方を防ぐ。
const MIN_CLIP_BYTES = 2_000;

export type GdCaptureStatus = 'idle' | 'listening' | 'transcribing';

export type UseCareerGdVoiceCaptureArgs = {
  /** useCareerGdMic が持つマイク stream。null の間は何もしない。 */
  stream: MediaStream | null;
  /** 音量解析に使う AudioContext（useCareerGdMic が iOS 解除も兼ねて生成済み）。 */
  audioContext: AudioContext | null;
  /** 取得が有効か（GD が active のときだけ true にする）。 */
  enabled: boolean;
  /** ミュート中は発話とみなさない。 */
  muted: boolean;
  /**
   * 1 発言ぶんの文字起こしが確定したときに呼ばれる。
   * 呼び出し側がここで既存の発言保存経路へ渡す。
   */
  onTranscript: (text: string) => void;
};

export type UseCareerGdVoiceCaptureResult = {
  status: GdCaptureStatus;
  /** 自分が今話していると判定されているか（円卓の発言中インジケータに使う）。 */
  speaking: boolean;
  /** 直近の失敗理由（null = 正常）。GD は止めず、次の発話で自動的に回復する。 */
  error: string | null;
  clearError: () => void;
  /** 「聞き取れませんでした」を出すためのカウンタ（増えたら UI が一時的に案内を出す）。 */
  unusableCount: number;
};

export function useCareerGdVoiceCapture({
  stream,
  audioContext,
  enabled,
  muted,
  onTranscript,
}: UseCareerGdVoiceCaptureArgs): UseCareerGdVoiceCaptureResult {
  const [speaking, setSpeaking] = useState(false);
  const [transcribingCount, setTranscribingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [unusableCount, setUnusableCount] = useState(0);

  // コールバックは ref 経由（deps に入れると録音器が作り直されて発話を取りこぼす）。
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const segmenterRef = useRef<GdSegmenterState | null>(null);
  // stop() の理由を onstop 側へ伝える（cut = 送る / recycle = 捨てる）。
  const pendingActionRef = useRef<'cut' | 'recycle' | null>(null);
  const stoppedForGoodRef = useRef(false);
  const mimeTypeRef = useRef<string>('');

  const clearError = useCallback(() => setError(null), []);

  // ── STT 送信（失敗しても GD を止めない）──────────────────────────
  const sendClip = useCallback(async (blob: Blob) => {
    if (blob.size < MIN_CLIP_BYTES) return; // ほぼ無音。送らない＝課金しない。
    if (blob.size > GD_VOICE_MAX_CLIP_BYTES) {
      setError('発言が長すぎたため、一部を送信できませんでした。区切って話してください。');
      return;
    }
    setTranscribingCount((n) => n + 1);
    try {
      const form = new FormData();
      // ファイル名はサーバの形式判定には使わない（mimeType を別途送る）。
      form.append('audio', blob, 'gd-utterance');
      form.append('mimeType', blob.type || mimeTypeRef.current || '');
      const res = await fetch('/api/career/gd/voice/stt', { method: 'POST', body: form });
      const data = (await res.json().catch(() => null)) as
        | { transcript?: string; usable?: boolean; error?: string; detail?: string }
        | null;
      if (!res.ok) {
        setError(data?.detail ?? '音声を文字にできませんでした。もう一度話してください。');
        return;
      }
      const transcript = (data?.transcript ?? '').trim();
      if (!transcript || data?.usable === false) {
        // 無音・雑音。エラーにはせず「聞き取れなかった」だけを伝える。
        setUnusableCount((n) => n + 1);
        return;
      }
      setError(null);
      onTranscriptRef.current(transcript);
    } catch {
      setError('通信に失敗しました。次の発言で自動的に再開します。');
    } finally {
      setTranscribingCount((n) => Math.max(0, n - 1));
    }
  }, []);

  // ── 録音 + 音量解析 ─────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !stream) return;
    if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
      // ブラウザ能力（外部システム）の判定結果を React 側へ同期する 1 回きりの書き込み。
      // GD が無言で機能しない状態を作らないため、非対応であることは必ず state に出す。
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 上記のとおり外部システムの同期
      setError('このブラウザは音声の録音に対応していません。Chrome / Safari の最新版をご利用ください。');
      return;
    }

    stoppedForGoodRef.current = false;
    chunksRef.current = [];
    segmenterRef.current = createGdSegmenterState(Date.now());
    pendingActionRef.current = null;

    const mimeType = pickGdRecorderMimeType((m) => MediaRecorder.isTypeSupported(m));
    mimeTypeRef.current = mimeType;

    let disposed = false;

    const startRecorder = () => {
      if (disposed || stoppedForGoodRef.current) return;
      let recorder: MediaRecorder;
      try {
        // mimeType が空文字列のときは指定せずブラウザ既定に任せる
        // （isTypeSupported が全滅する環境でも録音を諦めない）。
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      } catch {
        setError('録音を開始できませんでした。ページを再読み込みしてお試しください。');
        return;
      }

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const action = pendingActionRef.current;
        pendingActionRef.current = null;
        const parts = chunksRef.current;
        chunksRef.current = [];
        // 次のセグメントの録音を即座に始める（GD が無防備になる時間を最小化）。
        if (!disposed && !stoppedForGoodRef.current) startRecorder();
        if (action !== 'cut' || parts.length === 0) return; // recycle / 中断は捨てる
        const blob = new Blob(parts, { type: mimeType || 'audio/webm' });
        void sendClip(blob);
      };
      recorder.onerror = () => {
        // 録音器が壊れたら作り直す（無言で録音が止まる状態を残さない）。
        chunksRef.current = [];
        if (!disposed && !stoppedForGoodRef.current) {
          pendingActionRef.current = null;
          startRecorder();
        }
      };

      try {
        recorder.start();
        recorderRef.current = recorder;
      } catch {
        setError('録音を開始できませんでした。ページを再読み込みしてお試しください。');
      }
    };

    startRecorder();

    // 音量解析。AudioContext が無い環境では VAD が働かないため、
    // 「切れ目が判定できない」ことを明示して録音だけを回し続けない。
    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    // ★ 型注釈は Float32Array<ArrayBuffer>。素の `Float32Array` は ArrayBufferLike に広がり、
    //   SharedArrayBuffer を含むため getFloatTimeDomainData の引数として受け付けられない。
    let frame: Float32Array<ArrayBuffer> | null = null;
    if (audioContext) {
      try {
        source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        frame = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
      } catch {
        analyser = null;
        source = null;
      }
    }
    if (!analyser) {
      setError(
        '音量を解析できないため、発言の区切りを自動判定できません。ページを再読み込みしてお試しください。',
      );
    }

    const cutRecorder = (action: 'cut' | 'recycle') => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state !== 'recording') return;
      pendingActionRef.current = action;
      try {
        recorder.stop(); // onstop で blob 化 → 再 start
      } catch {
        pendingActionRef.current = null;
      }
    };

    const interval = setInterval(() => {
      if (disposed) return;
      const state = segmenterRef.current;
      if (!state) return;
      let rms = 0;
      if (analyser && frame) {
        analyser.getFloatTimeDomainData(frame);
        rms = rmsOfFrame(frame);
      }
      const tick = tickGdSegmenter(state, {
        rms,
        now: Date.now(),
        muted: mutedRef.current,
      });
      segmenterRef.current = tick.state;
      if (tick.speakingChanged) setSpeaking(tick.state.speaking);
      if (tick.action !== 'none') cutRecorder(tick.action);
    }, ANALYSIS_INTERVAL_MS);

    return () => {
      disposed = true;
      stoppedForGoodRef.current = true;
      clearInterval(interval);
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== 'inactive') {
        // 画面を離れる瞬間に録れていたぶんは捨てる（未確定の発言は投稿しない）。
        pendingActionRef.current = null;
        try {
          recorder.stop();
        } catch {
          // 停止済みは無視。
        }
      }
      chunksRef.current = [];
      try {
        source?.disconnect();
        analyser?.disconnect();
      } catch {
        // 破棄時の disconnect 失敗は無視。
      }
      setSpeaking(false);
    };
    // stream / audioContext / enabled が変わったときだけ作り直す。
    // muted と onTranscript は ref 経由なので deps に入れない（録音器を壊さない）。
  }, [enabled, stream, audioContext, sendClip]);

  const status: GdCaptureStatus = !enabled || !stream
    ? 'idle'
    : transcribingCount > 0
      ? 'transcribing'
      : 'listening';

  return { status, speaking, error, clearError, unusableCount };
}

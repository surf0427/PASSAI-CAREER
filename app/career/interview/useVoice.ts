'use client';

// PASSAI 就活版 — 面接AIの音声機能（STT / TTS）フック。
//
// 受験版はサーバ STT（Whisper）/ TTS（OpenAI）を使うが、それらは課金・env・受験版 route に
// 結合している。就活版は「課金・usage・DB 非接続」「受験版 route 非編集」を守るため、
// ブラウザ標準の Web Speech API（SpeechRecognition / speechSynthesis）でローカルに STT/TTS を行う。
// 非対応ブラウザでは sttSupported / ttsSupported が false になり、テキスト入力にフォールバックする。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  RECOGNITION_STOPPED_MESSAGE,
  RESTART_DELAY_MS,
  decideRecognitionRestart,
  pruneRestarts,
  type RecognitionEndReason,
} from '@/lib/careerVoice/recognitionRestartPolicy';

// 機能対応判定を SSR セーフに行うための no-op subscribe（値は固定なので購読は不要）。
const noopSubscribe = () => () => {};

// ── Web Speech API の最小型（標準 DOM lib に SpeechRecognition 型が無いため自前定義） ──
type SpeechRecognitionAlternativeLike = { transcript: string };
type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};
// onerror に渡るイベント（`error` は 'not-allowed' などの短い識別子）。
type SpeechRecognitionErrorEventLike = { error?: unknown };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// 音声認識エラーをユーザーが次に取れる行動へ翻訳する。
//
// ★ 面接は音声のみで運用するため、マイクが使えないときに「無反応」で終わらせない
//   （テキスト面接へは倒さない。案内と再試行だけを出す）。
function describeRecognitionError(raw: unknown): string {
  const code = typeof raw === 'string' ? raw : '';
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'マイクの使用が許可されていません。ブラウザのアドレスバーのマイクアイコンから使用を許可し、もう一度「録音して回答」を押してください。';
    case 'audio-capture':
      return 'マイクが見つかりませんでした。マイクが接続されているかを確認して、もう一度お試しください。';
    case 'no-speech':
      return '音声が聞き取れませんでした。マイクに近づいて、もう一度「録音して回答」を押してください。';
    case 'network':
      return '音声認識の通信に失敗しました。通信環境を確認して、もう一度お試しください。';
    case 'aborted':
      // ユーザー操作・画面遷移による中断はエラー表示しない。
      return '';
    default:
      return '音声認識を開始できませんでした。もう一度「録音して回答」を押してください。';
  }
}

type UseVoiceOptions = {
  // 確定した発話テキストを 1 区切りごとに渡す（呼び出し側で回答欄に追記する）。
  onFinalTranscript?: (text: string) => void;
  /**
   * ブラウザ都合の予期しない停止（onend）から自動再開を試みるか。
   *
   * ★ opt-in（既定 false）。有効にするかは **呼び出し側の機能が決める**
   *   （無音で認識が切れる長い発話を扱う画面で true にする）。
   *   判定そのものは lib/careerVoice/recognitionRestartPolicy の純関数へ委譲する。
   */
  autoRestart?: boolean;
  /**
   * 「ユーザーが今この瞬間、話し続けるつもりでいるか」（発表中 / 回答中）。
   * autoRestart が true のときだけ意味を持つ。false になったら再開しない
   * （送信後・評価後などに勝手にマイクが復活しないようにする）。
   */
  presenting?: boolean;
};

export function useVoice({
  onFinalTranscript,
  autoRestart = false,
  presenting = false,
}: UseVoiceOptions = {}) {
  // 機能対応判定は SSR では false、hydration 後に実際の値（外部システムの状態）を返す。
  const sttSupported = useSyncExternalStore(
    noopSubscribe,
    () => !!getRecognitionCtor(),
    () => false,
  );
  const ttsSupported = useSyncExternalStore(
    noopSubscribe,
    () => typeof window !== 'undefined' && 'speechSynthesis' in window,
    () => false,
  );
  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  // マイク／音声認識のエラー文言（null = エラーなし）。UI がそのまま表示する。
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // TTS が読み上げ中かどうか（面接官アバターの「話しています」状態表示に使う）。
  const [speaking, setSpeaking] = useState(false);

  // 予期しない停止（ブラウザ都合の onend）が起きて再開もできなかったことを UI へ伝える。
  const [recognitionStopped, setRecognitionStopped] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // onFinalTranscript を ref に逃がし、recognition 再生成を避ける（ref 更新は effect 内で行う）。
  const onFinalRef = useRef(onFinalTranscript);
  useEffect(() => {
    onFinalRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  // ── 自動再開のための ref 群（recognition を作り直さないよう全て ref で持つ）──
  //   deps に入れて recognition を再生成すると、発話中に認識器が入れ替わって取りこぼす。
  const autoRestartRef = useRef(autoRestart);
  const presentingRef = useRef(presenting);
  useEffect(() => {
    autoRestartRef.current = autoRestart;
  }, [autoRestart]);
  useEffect(() => {
    presentingRef.current = presenting;
  }, [presenting]);

  // 次の onend をどう解釈するか（stopListening / 時間切れ / エラー / unmount が印を付ける）。
  const endReasonRef = useRef<RecognitionEndReason>('unexpected');
  // rolling window の再開時刻。暴走（短時間の restart loop）検出に使う。
  const restartTimesRef = useRef<number[]>([]);
  const unmountedRef = useRef(false);

  // recognition 初期化（マウント後のみ）。
  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = 'ja-JP';
    recognition.interimResults = true;
    recognition.continuous = true;

    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0]?.transcript ?? '';
        if (res.isFinal) {
          const trimmed = text.trim();
          if (trimmed) onFinalRef.current?.(trimmed);
        } else {
          interim += text;
        }
      }
      setInterimText(interim);
    };
    recognition.onerror = (e) => {
      setListening(false);
      setInterimText('');
      const raw = (e as SpeechRecognitionErrorEventLike | null)?.error;
      const message = describeRecognitionError(raw);
      if (message) setVoiceError(message);
      // 'aborted' はユーザー操作・画面遷移由来なので通知不要。それ以外は error 停止として扱う。
      if (endReasonRef.current === 'unexpected') {
        endReasonRef.current = raw === 'aborted' ? 'manual_stop' : 'error';
      }
    };
    recognition.onend = () => {
      setListening(false);
      setInterimText('');

      // 直前に付いた印を消費する（次の onend は既定＝unexpected として解釈する）。
      const reason: RecognitionEndReason = unmountedRef.current
        ? 'unmounted'
        : endReasonRef.current;
      endReasonRef.current = 'unexpected';

      const now = Date.now();
      const decision = decideRecognitionRestart({
        reason,
        autoRestartEnabled: autoRestartRef.current,
        presenting: presentingRef.current,
        recentRestarts: restartTimesRef.current,
        now,
      });

      if (decision === 'stop-silent') return;
      if (decision === 'stop-notify') {
        // ★ 無言で止めない（P1-3 の中核）。
        setRecognitionStopped(true);
        return;
      }

      // restart: 少し待ってから再開する（即時 start は InvalidStateError になりやすい）。
      restartTimesRef.current = [...pruneRestarts(restartTimesRef.current, now), now];
      setTimeout(() => {
        if (unmountedRef.current || !presentingRef.current) return;
        try {
          recognition.start();
          setListening(true);
        } catch {
          // 再開できなければ必ずユーザーに知らせる（無言停止を作らない）。
          setRecognitionStopped(true);
        }
      }, RESTART_DELAY_MS);
    };

    recognitionRef.current = recognition;
    unmountedRef.current = false;
    return () => {
      // unmount 由来の onend で再開しないよう、abort より先に印を付ける。
      unmountedRef.current = true;
      endReasonRef.current = 'unmounted';
      try {
        recognition.abort();
      } catch {
        // 破棄時の abort 失敗は無視（既に停止済み等）。
      }
      recognitionRef.current = null;
    };
  }, []);

  const startListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setVoiceError(
        'このブラウザは音声認識に対応していません。Chrome など対応ブラウザで開き直してください。',
      );
      return;
    }
    setVoiceError(null);
    // ユーザーが自分で開始し直したので「停止した」表示と暴走カウンタをリセットする。
    setRecognitionStopped(false);
    restartTimesRef.current = [];
    endReasonRef.current = 'unexpected';
    try {
      recognition.start();
      setListening(true);
    } catch {
      // 既に開始済みなどで start が throw する場合は無視（録音状態は onend/onerror で整う）。
    }
  }, []);

  // ユーザーが再試行したときにエラー表示を消す。
  const clearVoiceError = useCallback(() => setVoiceError(null), []);

  /** 「音声認識が停止しました」表示を閉じる。 */
  const clearRecognitionStopped = useCallback(() => setRecognitionStopped(false), []);

  /**
   * 停止する。
   *
   * @param reason 'time_limit'（制限時間到達）のときだけ明示的に渡す。
   *   それ以外（未指定・ユーザー操作）は 'manual_stop' 扱い。どちらも **自動再開しない**。
   *
   * ★ 本関数は `onClick={stopListening}` のように **DOM イベントハンドラへ直接渡される**
   *   （面接・プレゼン双方の録音ボタン）。その場合 reason に MouseEvent が入るため、
   *   受け取った値は必ず正規化し、既知の literal 以外は 'manual_stop' に倒す。
   *   ここを素通しにすると、停止ボタンを押したのに「予期しない停止」と誤判定されて
   *   マイクが勝手に再開する事故になる。
   */
  const stopListening = useCallback((reason?: unknown) => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    // stop() が発火する onend を「意図された停止」として解釈させる。
    endReasonRef.current = reason === 'time_limit' ? 'time_limit' : 'manual_stop';
    restartTimesRef.current = [];
    try {
      recognition.stop();
    } catch {
      // 停止失敗は無視。
    }
    setListening(false);
    setInterimText('');
  }, []);

  // 質問テキストを読み上げる（TTS）。非対応なら何もしない。
  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(trimmed);
      utterance.lang = 'ja-JP';
      utterance.rate = 1;
      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utterance);
    } catch {
      // 読み上げ失敗は無視（面接はテキストで継続できる）。
      setSpeaking(false);
    }
  }, []);

  const cancelSpeak = useCallback(() => {
    setSpeaking(false);
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // 無視。
    }
  }, []);

  return {
    sttSupported,
    ttsSupported,
    listening,
    interimText,
    speaking,
    voiceError,
    clearVoiceError,
    /** 予期しない停止から復帰できなかったことを示す（UI で必ず表示する）。 */
    recognitionStopped,
    clearRecognitionStopped,
    /** 停止の理由（UI に出す定型文）。 */
    recognitionStoppedMessage: RECOGNITION_STOPPED_MESSAGE,
    startListening,
    stopListening,
    speak,
    cancelSpeak,
  };
}

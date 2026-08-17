'use client';

// PASSAI 就活版 — 面接AIの音声機能（STT / TTS）フック。
//
// 受験版はサーバ STT（Whisper）/ TTS（OpenAI）を使うが、それらは課金・env・受験版 route に
// 結合している。就活版は「課金・usage・DB 非接続」「受験版 route 非編集」を守るため、
// ブラウザ標準の Web Speech API（SpeechRecognition / speechSynthesis）でローカルに STT/TTS を行う。
// 非対応ブラウザでは sttSupported / ttsSupported が false になり、テキスト入力にフォールバックする。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

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
};

export function useVoice({ onFinalTranscript }: UseVoiceOptions = {}) {
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

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // onFinalTranscript を ref に逃がし、recognition 再生成を避ける（ref 更新は effect 内で行う）。
  const onFinalRef = useRef(onFinalTranscript);
  useEffect(() => {
    onFinalRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

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
      const message = describeRecognitionError(
        (e as SpeechRecognitionErrorEventLike | null)?.error,
      );
      if (message) setVoiceError(message);
    };
    recognition.onend = () => {
      setListening(false);
      setInterimText('');
    };

    recognitionRef.current = recognition;
    return () => {
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
    try {
      recognition.start();
      setListening(true);
    } catch {
      // 既に開始済みなどで start が throw する場合は無視（録音状態は onend/onerror で整う）。
    }
  }, []);

  // ユーザーが再試行したときにエラー表示を消す。
  const clearVoiceError = useCallback(() => setVoiceError(null), []);

  const stopListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
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
    startListening,
    stopListening,
    speak,
    cancelSpeak,
  };
}

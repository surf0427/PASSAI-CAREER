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
    recognition.onerror = () => {
      setListening(false);
      setInterimText('');
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
    if (!recognition) return;
    try {
      recognition.start();
      setListening(true);
    } catch {
      // 既に開始済みなどで start が throw する場合は無視。
    }
  }, []);

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
      window.speechSynthesis.speak(utterance);
    } catch {
      // 読み上げ失敗は無視（面接はテキストで継続できる）。
    }
  }, []);

  const cancelSpeak = useCallback(() => {
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
    startListening,
    stopListening,
    speak,
    cancelSpeak,
  };
}

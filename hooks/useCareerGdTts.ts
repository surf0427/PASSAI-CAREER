'use client';

/**
 * PASSAI 就活版 — GD 読み上げ Hook（STEP-GD-VOICE）。
 *
 * AI 参加者の発言と進行アナウンスを音声で再生する。GD は音声で進むので、
 * ここが止まると「AI が何を言ったのか分からない」＝ GD が成立しない。
 * したがって **二段構え**にする:
 *   ① POST /api/career/gd/voice/tts（OpenAI TTS・persona ごとに声が違う）
 *   ② 失敗したらブラウザの speechSynthesis へ降格（声は機械的だが議論は続く）
 *
 * 直列再生:
 *   同時に 2 つ鳴らさない。GD は 1 人ずつ話す場なので、重なると誰の発言か
 *   分からなくなるうえ、円卓の「発言中」表示とも矛盾する。キューで 1 件ずつ流す。
 *
 * 二重再生の防止:
 *   マルチ GD は polling / Realtime で同じ発言が何度も props に流れてくる。
 *   再生済み id を記録し、同じ発言を二度読み上げない。
 *
 * ★ iOS Safari 対策:
 *   HTMLAudioElement の再生はユーザー操作外だとブロックされることがある。
 *   useCareerGdMic が「マイクを有効にする」操作の中で解除済みの AudioContext を
 *   渡してもらい、そちらで鳴らす（WebAudio 経路は解除済み context なら後から鳴らせる）。
 *   AudioContext が無い環境だけ HTMLAudioElement へ落とす。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type GdSpeakRequest = {
  /** 発言の一意 id（同じ id は二度読み上げない）。 */
  id: string;
  text: string;
  /** 声を決める key（persona_key / 'moderator' / 'solo:<index>'）。 */
  speakerKey: string;
  /** 円卓の「発言中」表示に使う participantId（任意）。 */
  participantId?: string | null;
};

export type UseCareerGdTtsArgs = {
  /** useCareerGdMic が生成した（＝ユーザー操作で解除済みの）AudioContext。 */
  audioContext: AudioContext | null;
  /** 読み上げを行うか。false なら enqueue しても鳴らさない。 */
  enabled: boolean;
};

export type UseCareerGdTtsResult = {
  /** 今読み上げている発言の participantId（null = 無音）。 */
  speakingParticipantId: string | null;
  /** 今読み上げている発言 id。 */
  speakingId: string | null;
  /** キュー待ち件数（UI の「読み上げ待ち」表示用）。 */
  queuedCount: number;
  /** 読み上げを依頼する（重複 id は無視）。 */
  speak: (req: GdSpeakRequest) => void;
  /** 進行中の再生とキューを全部捨てる（GD 終了・画面離脱時）。 */
  cancelAll: () => void;
  /** サーバ TTS が使えずブラウザ合成へ降格しているか（UI で一度だけ知らせる）。 */
  degraded: boolean;
};

export function useCareerGdTts({
  audioContext,
  enabled,
}: UseCareerGdTtsArgs): UseCareerGdTtsResult {
  const [speakingParticipantId, setSpeakingParticipantId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [degraded, setDegraded] = useState(false);

  const queueRef = useRef<GdSpeakRequest[]>([]);
  const spokenIdsRef = useRef<Set<string>>(new Set());
  const playingRef = useRef(false);
  const disposedRef = useRef(false);
  // 現在鳴っている音源（キャンセル用）。
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const audioContextRef = useRef(audioContext);
  useEffect(() => {
    audioContextRef.current = audioContext;
  }, [audioContext]);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch {
        // 無視。
      }
      objectUrlRef.current = null;
    }
  }, []);

  // ── ブラウザ合成へ降格（サーバ TTS が使えないとき）──────────────
  const speakWithBrowser = useCallback((text: string): Promise<void> => {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        resolve();
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ja-JP';
        utterance.rate = 1;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        utterance.onend = done;
        utterance.onerror = done;
        window.speechSynthesis.speak(utterance);
        // 一部ブラウザは onend が来ないことがある。長さから概算した保険で必ず解決させる
        // （ここで詰まると GD の読み上げキューが永久に止まる）。
        setTimeout(done, Math.min(60_000, 2_000 + text.length * 120));
      } catch {
        resolve();
      }
    });
  }, []);

  // ── WebAudio / HTMLAudioElement で 1 件再生 ──────────────────────
  const playAudioBytes = useCallback(
    async (bytes: ArrayBuffer, contentType: string): Promise<boolean> => {
      const ctx = audioContextRef.current;
      if (ctx) {
        try {
          if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
          const buffer = await ctx.decodeAudioData(bytes.slice(0));
          await new Promise<void>((resolve) => {
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.onended = () => resolve();
            sourceRef.current = source;
            source.start();
          });
          sourceRef.current = null;
          return true;
        } catch {
          sourceRef.current = null;
          // decode / 再生に失敗したら HTMLAudioElement 経路を試す。
        }
      }
      try {
        const blob = new Blob([bytes], { type: contentType || 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        const el = new Audio(url);
        audioElRef.current = el;
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          el.onended = done;
          el.onerror = done;
          void el.play().catch(done);
        });
        audioElRef.current = null;
        releaseObjectUrl();
        return true;
      } catch {
        audioElRef.current = null;
        releaseObjectUrl();
        return false;
      }
    },
    [releaseObjectUrl],
  );

  // ── キューを 1 件ずつ処理 ────────────────────────────────────────
  const drain = useCallback(async () => {
    if (playingRef.current) return;
    playingRef.current = true;
    try {
      while (!disposedRef.current) {
        const next = queueRef.current.shift();
        setQueuedCount(queueRef.current.length);
        if (!next) break;
        if (!enabledRef.current) continue;

        setSpeakingId(next.id);
        setSpeakingParticipantId(next.participantId ?? null);

        let played = false;
        try {
          const res = await fetch('/api/career/gd/voice/tts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: next.text, speakerKey: next.speakerKey }),
          });
          const contentType = res.headers.get('content-type') ?? '';
          if (res.ok && contentType.startsWith('audio/')) {
            const bytes = await res.arrayBuffer();
            if (bytes.byteLength > 0) {
              played = await playAudioBytes(bytes, contentType);
            }
          }
        } catch {
          // 通信失敗。下のブラウザ合成へ降格する。
        }

        if (!played) {
          // ★ 無音にしない。声質は落ちるが、AI の発言は必ず耳に届ける。
          setDegraded(true);
          await speakWithBrowser(next.text);
        }

        setSpeakingId(null);
        setSpeakingParticipantId(null);
      }
    } finally {
      playingRef.current = false;
      setSpeakingId(null);
      setSpeakingParticipantId(null);
    }
  }, [playAudioBytes, speakWithBrowser]);

  const speak = useCallback(
    (req: GdSpeakRequest) => {
      const text = (req.text ?? '').trim();
      if (!text || !req.id) return;
      // 同じ発言を二度読み上げない（polling / Realtime で同じ message が何度も来る）。
      if (spokenIdsRef.current.has(req.id)) return;
      // ★ 「読み上げ済み」の印は **実際にキューへ載せたときだけ** 付ける。
      //   無効中（GD 開始前・終了後）に印を付けてしまうと、その発言は有効化されても
      //   二度と読み上げられない = AI の発言が 1 件まるごと聞こえないまま消える。
      if (!enabledRef.current) return;
      spokenIdsRef.current.add(req.id);
      queueRef.current.push({ ...req, text });
      setQueuedCount(queueRef.current.length);
      void drain();
    },
    [drain],
  );

  const cancelAll = useCallback(() => {
    queueRef.current = [];
    setQueuedCount(0);
    try {
      sourceRef.current?.stop();
    } catch {
      // 停止済みは無視。
    }
    sourceRef.current = null;
    const el = audioElRef.current;
    if (el) {
      try {
        el.pause();
      } catch {
        // 無視。
      }
      audioElRef.current = null;
    }
    releaseObjectUrl();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // 無視。
      }
    }
    setSpeakingId(null);
    setSpeakingParticipantId(null);
  }, [releaseObjectUrl]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      cancelAll();
    };
  }, [cancelAll]);

  return {
    speakingParticipantId,
    speakingId,
    queuedCount,
    speak,
    cancelAll,
    degraded,
  };
}

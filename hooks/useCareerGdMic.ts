'use client';

/**
 * PASSAI 就活版 — GD のマイク所有者 Hook（STEP-GD-VOICE）。
 *
 * 責務は **マイク stream を 1 本だけ持つこと**。文字起こし（useCareerGdVoiceCapture）と
 * 参加者間の音声配信（useCareerGdVoiceMesh）は、どちらもここが持つ同じ stream を使う。
 *
 * ★ stream を 2 箇所で別々に getUserMedia すると、ブラウザによってはマイクが二重に
 *   掴まれて片方が無音になる / iOS では 2 本目の取得が失敗する。所有者を 1 つに固定する。
 *
 * Safari（macOS / iOS）で特に効いている配慮:
 *   - getUserMedia は **必ずユーザー操作起点**でしか呼ばない（自動取得しない）。
 *     iOS は自動取得を拒否し、しかも一度拒否されると再プロンプトが出ない。
 *   - AudioContext も同じユーザー操作の中で生成・resume する（iOS の自動再生制限の解除）。
 *     ここで解除しておくことで、後から届く AI の読み上げ音声も再生できるようになる。
 *   - 権限拒否（NotAllowedError）は「無反応」にせず、必ず復帰手順の文言を出す。
 *   - ミュートは track を止めるのではなく `track.enabled = false` にする。
 *     stop() すると Safari では再開に再プロンプトが必要になり、ミュート解除が壊れる。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type GdMicStatus =
  | 'idle' // まだ許可を求めていない
  | 'requesting' // getUserMedia 実行中
  | 'ready' // stream 取得済み
  | 'denied' // ユーザー / OS が拒否
  | 'unsupported' // ブラウザが getUserMedia を持たない
  | 'error'; // その他の失敗（デバイス無し等）

export type UseCareerGdMicResult = {
  status: GdMicStatus;
  /** 取得済みのマイク stream（未取得は null）。 */
  stream: MediaStream | null;
  /** AudioContext（iOS の音声再生解除も兼ねる）。未取得は null。 */
  audioContext: AudioContext | null;
  muted: boolean;
  /** ユーザー操作から呼ぶこと。冪等（取得済みなら何もしない）。 */
  enable: () => Promise<boolean>;
  setMuted: (next: boolean) => void;
  toggleMuted: () => void;
  /** 表示用の失敗理由（null = 失敗していない）。 */
  errorMessage: string | null;
};

function describeMicError(err: unknown): { status: GdMicStatus; message: string } {
  const name = err && typeof err === 'object' ? String((err as { name?: unknown }).name ?? '') : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        status: 'denied',
        message:
          'マイクの使用が許可されていません。ブラウザのアドレスバーのマイクアイコン（iPhoneのSafariは「ぁあ」→「Webサイトの設定」）から「許可」に変更し、ページを再読み込みしてください。',
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        status: 'error',
        message: 'マイクが見つかりませんでした。マイクが接続されているか確認してください。',
      };
    case 'NotReadableError':
      return {
        status: 'error',
        message:
          '他のアプリがマイクを使用中の可能性があります。ビデオ会議アプリなどを終了してから、もう一度お試しください。',
      };
    default:
      return {
        status: 'error',
        message: 'マイクを開始できませんでした。ページを再読み込みして、もう一度お試しください。',
      };
  }
}

export function useCareerGdMic(): UseCareerGdMicResult {
  const [status, setStatus] = useState<GdMicStatus>('idle');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [muted, setMutedState] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // unmount 後に setState しないための番人（getUserMedia は完了まで時間がかかる）。
  const unmountedRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  // 二重取得ガード（連打・StrictMode の二重呼び出し）。
  const acquiringRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      // GD を離れたらマイクを確実に解放する（タブのマイク表示が残り続けない）。
      const s = streamRef.current;
      if (s) {
        for (const track of s.getTracks()) {
          try {
            track.stop();
          } catch {
            // 停止済み等は無視。
          }
        }
      }
      streamRef.current = null;
      const ctx = audioContextRef.current;
      if (ctx) {
        void ctx.close().catch(() => {});
      }
      audioContextRef.current = null;
    };
  }, []);

  const enable = useCallback(async (): Promise<boolean> => {
    if (streamRef.current) return true;
    if (acquiringRef.current) return acquiringRef.current;

    const run = async (): Promise<boolean> => {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        setStatus('unsupported');
        setErrorMessage(
          'このブラウザはマイクに対応していません。Chrome / Safari の最新版で開き直してください。',
        );
        return false;
      }

      setStatus('requesting');
      setErrorMessage(null);
      try {
        // echoCancellation は必須。マルチGDでは自分のスピーカーから出た他参加者の声を
        // 自分のマイクが拾い、その音声まで文字起こしされて二重投稿になるため。
        const media = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });

        if (unmountedRef.current) {
          for (const track of media.getTracks()) track.stop();
          return false;
        }

        streamRef.current = media;
        setStream(media);

        // ★ iOS: ここ（＝ユーザー操作の同期的な延長）で AudioContext を作って resume すると、
        //   以降にプログラムから再生する音声（AI の読み上げ・他参加者の声）が鳴るようになる。
        //   これを後回しにすると「マイクは動くのに何も聞こえない」状態になる。
        try {
          const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (Ctor) {
            const ctx = new Ctor();
            if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
            audioContextRef.current = ctx;
            setAudioContext(ctx);
          }
        } catch {
          // AudioContext が作れなくても録音自体は続行できる（音量解析だけ失われる）。
        }

        setStatus('ready');
        return true;
      } catch (err) {
        const described = describeMicError(err);
        if (!unmountedRef.current) {
          setStatus(described.status);
          setErrorMessage(described.message);
        }
        return false;
      }
    };

    const promise = run().finally(() => {
      acquiringRef.current = null;
    });
    acquiringRef.current = promise;
    return promise;
  }, []);

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    const s = streamRef.current;
    if (!s) return;
    // ★ stop() ではなく enabled で切る。stop すると Safari は再取得に再プロンプトを要求し、
    //   ミュート解除ができなくなる（＝GD の途中で発言不能になる）。
    for (const track of s.getAudioTracks()) {
      track.enabled = !next;
    }
  }, []);

  const toggleMuted = useCallback(() => {
    setMutedState((prev) => {
      const next = !prev;
      const s = streamRef.current;
      if (s) {
        for (const track of s.getAudioTracks()) track.enabled = !next;
      }
      return next;
    });
  }, []);

  return {
    status,
    stream,
    audioContext,
    muted,
    enable,
    setMuted,
    toggleMuted,
    errorMessage,
  };
}

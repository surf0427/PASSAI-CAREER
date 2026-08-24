'use client';

/**
 * PASSAI 就活版 — GD 音声機能の事前照会 Hook（STEP-GD-VOICE）。
 *
 * ★ 目的は **早期失敗**。GD は音声でしか進行できないため、
 *   「部屋に入って、開始して、話そうとした瞬間に文字起こしが使えないと分かる」
 *   のが最悪の失敗の仕方になる（しかも他の参加者を巻き込む）。
 *   開始前の画面でここを引き、使えないなら開始そのものを止めて案内する。
 *
 * ★ 判定の 2 軸を混ぜない:
 *   - server 側 … provider env が揃っているか（/api/career/gd/voice/capabilities）
 *   - client 側 … このブラウザが録音できるか（getUserMedia / MediaRecorder）
 *   どちらか一方でも欠けたら GD は成立しない。理由ごとに別々の文言を返す。
 */

import { useCallback, useEffect, useState } from 'react';

export type GdVoiceReadiness =
  | { state: 'checking' }
  | { state: 'ready' }
  /** サーバ側で文字起こしを提供できない（provider 未設定 / 障害）。 */
  | { state: 'server-unavailable'; message: string }
  /** このブラウザが録音に対応していない。 */
  | { state: 'browser-unsupported'; message: string }
  /** 照会自体に失敗（通信・未ログイン）。GD は止めるが原因は別。 */
  | { state: 'unknown'; message: string };

function browserCanRecord(): boolean {
  if (typeof window === 'undefined') return true; // SSR では判定しない
  return (
    typeof window.MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export function useCareerGdVoiceCapabilities(): {
  readiness: GdVoiceReadiness;
  /** 読み上げが使えるか（false でもブラウザ合成へ降格して GD は成立する）。 */
  ttsAvailable: boolean;
  recheck: () => void;
} {
  const [readiness, setReadiness] = useState<GdVoiceReadiness>({ state: 'checking' });
  const [ttsAvailable, setTtsAvailable] = useState(true);
  const [nonce, setNonce] = useState(0);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    // ① ブラウザ能力は通信不要で先に判定できる（サーバへ無駄に問い合わせない）。
    if (!browserCanRecord()) {
      // ブラウザ能力（外部システム）の判定結果を React へ同期する 1 回きりの書き込み。
      // hydration mismatch を避けるため初期値ではなく effect で行う（SSR では判定できない）。
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 上記のとおり外部システムの同期
      setReadiness({
        state: 'browser-unsupported',
        message:
          'このブラウザは音声の録音に対応していません。GDは音声で進行するため、Chrome または Safari の最新版で開き直してください。',
      });
      return;
    }

    const run = async () => {
      try {
        const res = await fetch('/api/career/gd/voice/capabilities');
        if (cancelled) return;
        if (!res.ok) {
          setReadiness({
            state: 'unknown',
            message:
              '音声機能の状態を確認できませんでした。通信環境を確認して、ページを再読み込みしてください。',
          });
          return;
        }
        const data = (await res.json()) as { stt?: boolean; tts?: boolean };
        if (cancelled) return;
        setTtsAvailable(data.tts === true);
        if (data.stt !== true) {
          setReadiness({
            state: 'server-unavailable',
            message:
              'ただいま音声の文字起こしを利用できません。GDは音声で進行するため、復旧までお待ちください。',
          });
          return;
        }
        setReadiness({ state: 'ready' });
      } catch {
        if (cancelled) return;
        setReadiness({
          state: 'unknown',
          message:
            '音声機能の状態を確認できませんでした。通信環境を確認して、ページを再読み込みしてください。',
        });
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { readiness, ttsAvailable, recheck };
}

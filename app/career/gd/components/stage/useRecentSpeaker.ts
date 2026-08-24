'use client';

// PASSAI 就活版 — 「直近に発言した人」を一定時間だけ覚えておく表示専用フック。
//
// ★ GD の進行ロジックには一切関与しない。
//   テキストGD では発言は一瞬でログに現れて終わるため、そのままだと
//   「今この人が話している」が視覚化できない。そこで **既存の発言データ（最新 message /
//   utterance）** を入力に取り、その発言者を holdMs のあいだだけ speaking として返す。
//   進行・順番・AI 選出・保存は既存実装のまま（新しい state 管理を GD 側に足さない）。

import { useEffect, useRef, useState } from 'react';

/** 直近発言者を holdMs だけ保持する（マウント時に既にあるログでは発火しない）。 */
export function useRecentSpeaker(
  latestSpeakerId: string | null,
  /** 発言の同一性キー（message.id / seq / utterance.id）。これが変わったときだけ更新する。 */
  latestKey: string | null,
  holdMs = 6000,
): string | null {
  const [speakerId, setSpeakerId] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    // 初回レンダー（＝再読込直後に既存ログがある場合）は「発言中」にしない。
    if (!initializedRef.current) {
      initializedRef.current = true;
      lastKeyRef.current = latestKey;
      return;
    }
    if (!latestKey || latestKey === lastKeyRef.current) return;
    lastKeyRef.current = latestKey;
    if (!latestSpeakerId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部（発言ログ）の変化に同期する表示専用 state
    setSpeakerId(latestSpeakerId);
    const timer = setTimeout(() => setSpeakerId(null), holdMs);
    return () => clearTimeout(timer);
  }, [latestKey, latestSpeakerId, holdMs]);

  return speakerId;
}

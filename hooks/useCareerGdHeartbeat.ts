'use client';

// PASSAI 就活版 — GD マルチ 参加者 heartbeat Hook（STEP-GD-31）。
//
// 一定間隔で POST /api/career/gd/room/[roomId]/heartbeat を叩き、
// 自分の last_seen_at を更新する。これが「参加者が生きている」唯一の権威的な信号になる。
//
// ★ Presence（Realtime channel）との役割分担:
//   - Presence … 即時性が高いが、Realtime が無効/遮断された環境では機能せず、server から見えない。
//   - heartbeat … 数十秒の粒度だが、**server / DB / cron / 他参加者の API 応答**から参照できる。
//   本 hook は後者。両方が揃って初めて「切断検知」が production で成立する。
//
// ★ タブが背面のとき:
//   ブラウザは背面タブの setInterval を大きく間引く（数分に 1 回まで落ちうる）。
//   そのため visibilitychange で前面復帰時に即座に 1 発打ち、
//   「復帰したのに数十秒 disconnected 表示のまま」を防ぐ。
//
// ★ 失敗時:
//   heartbeat の失敗は GD の進行を妨げない（次周期で回復する）。エラーを画面に出さない。
//   ただし連続失敗は接続品質シグナルとして上位へ渡す（degraded 表示の材料）。

import { useEffect, useRef, useState } from 'react';

import { GD_HEARTBEAT_INTERVAL_MS } from '@/lib/careerGd/presence';

export type UseCareerGdHeartbeatArgs = {
  roomId: string;
  /** waiting / active のときだけ true。終端 room では止める。 */
  enabled: boolean;
  /** serverNow を上位の clock offset 推定へ流すためのコールバック。 */
  onServerNow?: (serverNowIso: string) => void;
  /** server 側が期限切れで room を finished 化したときに通知（即座に結果画面へ遷移できる）。 */
  onRoomFinished?: () => void;
  intervalMs?: number;
};

export type UseCareerGdHeartbeatResult = {
  /** 直近の heartbeat が成功したか（初回応答前は true 扱い＝不必要に警告を出さない）。 */
  healthy: boolean;
  /** 連続失敗回数（degraded 判定の材料）。 */
  consecutiveFailures: number;
};

export function useCareerGdHeartbeat({
  roomId,
  enabled,
  onServerNow,
  onRoomFinished,
  intervalMs = GD_HEARTBEAT_INTERVAL_MS,
}: UseCareerGdHeartbeatArgs): UseCareerGdHeartbeatResult {
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);

  // コールバックを ref 経由で参照し、effect の再購読（＝タイマー再作成）を防ぐ。
  const onServerNowRef = useRef(onServerNow);
  const onRoomFinishedRef = useRef(onRoomFinished);
  useEffect(() => {
    onServerNowRef.current = onServerNow;
    onRoomFinishedRef.current = onRoomFinished;
  }, [onServerNow, onRoomFinished]);

  useEffect(() => {
    if (!enabled || !roomId) return;
    let cancelled = false;

    const beat = async () => {
      try {
        const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}/heartbeat`, {
          method: 'POST',
        });
        if (cancelled) return;
        if (!res.ok) {
          // 403（退室済み / 非参加者）は再試行しても無駄だが、
          // 上位が room 状態を再取得して適切に遷移するので、ここでは失敗計上に留める。
          setConsecutiveFailures((n) => n + 1);
          return;
        }
        const data = (await res.json().catch(() => null)) as
          | { serverNow?: string; roomFinished?: boolean }
          | null;
        if (cancelled) return;
        setConsecutiveFailures(0);
        if (data?.serverNow) onServerNowRef.current?.(data.serverNow);
        if (data?.roomFinished) onRoomFinishedRef.current?.();
      } catch {
        if (!cancelled) setConsecutiveFailures((n) => n + 1);
      }
    };

    // 入室直後に 1 発（joined_at 基準の判定を待たずに online を確定させる）。
    void beat();
    const id = setInterval(() => void beat(), intervalMs);

    // 背面タブ → 前面復帰で即座に生存申告（間引かれた分を取り戻す）。
    const onVisible = () => {
      if (document.visibilityState === 'visible') void beat();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [roomId, enabled, intervalMs]);

  return { healthy: consecutiveFailures === 0, consecutiveFailures };
}

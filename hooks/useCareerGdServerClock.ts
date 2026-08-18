'use client';

// PASSAI 就活版 — GD マルチ server clock offset（STEP-GD-31）。
//
// API レスポンスに含まれる `serverNow`（ISO）と、それを受け取った瞬間のローカル時刻から
// 「このクライアントの時計は server から何 ms ずれているか」を推定して保持する。
//
//   offset = serverNowMs - localNowMsAtReceive
//   correctedNow = Date.now() + offset
//
// ★ なぜ必要か:
//   タイマーの起点（started_at）は DB 値なので全員共通だが、残り時間の計算に各端末の
//   Date.now() を使うと、端末時計がずれている人だけ違う残り時間を見る。
//   GD は「残り時間」を全員が共有していることが前提の演習なので、ここがずれると体験が壊れる。
//
// ★ 精度について:
//   offset には往復遅延の片道ぶん（通常 10〜200ms）が誤差として乗る。GD の表示粒度は
//   1 秒なので実用上問題にならない。**終了判定の正本は server**（DB now()）なので、
//   ここでの誤差が「終了できる/できない」に影響することもない。
//
// ★ ノイズ対策:
//   毎回の応答で offset を上書きすると、単発の遅延スパイクで表示が揺れる。
//   直近の観測を軽く平滑化し、かつ「明らかに小さい変化」は無視する。

import { useCallback, useEffect, useRef, useState } from 'react';

/** これ未満の変化は無視する（再レンダリングと表示のちらつきを避ける）。 */
const OFFSET_UPDATE_THRESHOLD_MS = 750;

/** 新しい観測をどれだけ信用するか（指数移動平均の係数）。 */
const OFFSET_SMOOTHING = 0.5;

/**
 * 補正済み現在時刻を state として刻む間隔（ms）。
 *
 * presence の閾値は 45 秒 / 180 秒なので、5 秒粒度で十分。
 * ★ render 中に Date.now() を呼ばないためにこの tick が必要
 *   （React の purity ルール: render は冪等でなければならない）。
 */
const PRESENCE_CLOCK_TICK_MS = 5_000;

export type UseCareerGdServerClockResult = {
  /** 現在の推定 offset（ms）。未観測なら 0（＝ローカル時計をそのまま使う）。 */
  clockOffsetMs: number;
  /** API 応答の serverNow を渡す。null / 不正値は無視する。 */
  observeServerNow: (serverNowIso: string | null | undefined) => void;
  /**
   * server 補正済みの現在時刻（ms）を **state として**保持した値。
   *
   * ★ render 中に読んでよいのはこちら。`getCorrectedNow()` は副作用のある関数呼び出しなので
   *   render 内では使わない（React purity ルール違反になる）。
   */
  correctedNowMs: number;
  /** イベントハンドラ / effect の中から即時に補正時刻が欲しいとき用（render 中に呼ばない）。 */
  getCorrectedNow: () => number;
};

export function useCareerGdServerClock(): UseCareerGdServerClockResult {
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  // getCorrectedNow を安定参照にするため ref にも持つ（effect 依存を増やさない）。
  const offsetRef = useRef(0);

  const observeServerNow = useCallback((serverNowIso: string | null | undefined) => {
    if (!serverNowIso) return;
    const serverMs = Date.parse(serverNowIso);
    if (!Number.isFinite(serverMs)) return;

    const sample = serverMs - Date.now();
    const prev = offsetRef.current;
    // 初回はそのまま採用。以降は指数移動平均でならす。
    const next = prev === 0 ? sample : Math.round(prev + (sample - prev) * OFFSET_SMOOTHING);

    offsetRef.current = next;
    setClockOffsetMs((cur) => (Math.abs(next - cur) >= OFFSET_UPDATE_THRESHOLD_MS ? next : cur));
  }, []);

  const getCorrectedNow = useCallback(() => Date.now() + offsetRef.current, []);

  // presence 判定用の補正時刻を state として刻む（render を純粋に保つ）。
  const [tickMs, setTickMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTickMs(Date.now()), PRESENCE_CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return {
    clockOffsetMs,
    observeServerNow,
    correctedNowMs: tickMs + clockOffsetMs,
    getCorrectedNow,
  };
}

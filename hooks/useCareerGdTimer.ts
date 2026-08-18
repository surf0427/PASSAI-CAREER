'use client';

// PASSAI 就活版 — GD マルチ タイマー同期 Hook（STEP-GD-26 / STEP-GD-31 で server 補正を追加）。
//
// 全参加者に同じ残り時間を見せるため、正本を「server 保存済みの started_at + 制限時間」に固定する。
//   remaining = (started_at + timeLimitSec) - correctedNow
//
// ★ STEP-GD-31: clock drift 補正
//   従来は correctedNow = クライアントの Date.now() だった。端末時計が数分ずれていると、
//   その端末だけ残り時間がずれて表示される（同じ GD なのに人によって残り時間が違う）。
//   本 STEP からは API が返す `serverNow` と受信時刻の差から **offset** を求め、
//     correctedNow = Date.now() + offset
//   で補正する。offset は round-trip の影響を受けるが、GD の粒度（秒）では十分な精度。
//
// ★ 権限の分担（変更なし）:
//   - 表示は毎秒更新するが DB へは一切書き込まない（毎秒 DB 更新の禁止）。
//   - 0 到達は shouldAutoFinish で上位へ通知するだけ。
//   - **終了の最終決定権は server** にある（roomLifecycle.finishRoomIfExpired / DB now()）。
//     クライアントの時計を偽装しても期限を越えて投稿はできないし、host が居なくても終了する。
//     本 hook は「表示」と「host クライアントが生きているときの即時終了トリガ」に過ぎない。
//
// 既存 DB 契約: 制限時間カラムは career_gd_rooms.time_limit_sec（秒）。current_phase /
// duration_minutes / ended_at 等は存在しないため使わない（started_at / finished_at / time_limit_sec）。

import { useEffect, useState } from 'react';

export type UseCareerGdTimerArgs = {
  startedAt: string | null; // career_gd_rooms.started_at（ISO・未開始は null）
  timeLimitSec: number; // career_gd_rooms.time_limit_sec
  enabled?: boolean; // active のときだけ tick / 自動終了判定（既定 true）
  /**
   * STEP-GD-31: server とクライアントの時計差（ms）。`serverNow - localNowAtReceive`。
   * 省略時は 0（＝従来どおりローカル時計をそのまま使う後方互換動作）。
   * 値は useCareerGdServerClock が算出する。
   */
  clockOffsetMs?: number;
};

export type UseCareerGdTimerResult = {
  remainingMs: number;
  remainingSeconds: number;
  formattedTime: string; // mm:ss
  isExpired: boolean; // 開始済みで残り 0
  progressRatio: number; // 経過割合 0..1
  shouldAutoFinish: boolean; // enabled かつ時間切れ（上位が host のとき finish を1回呼ぶ想定）
  hasStarted: boolean;
};

function formatMmSs(totalSec: number): string {
  const s = Math.max(0, totalSec);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * 残り時間の純計算（QA 可能・React 非依存）。
 *
 * clock drift の QA はこの関数に対して行う（hook を回さずに、
 * 「端末時計が ±N 分ずれていても offset 補正で同じ残り時間になる」ことを検証できる）。
 */
export function computeGdRemainingSeconds(params: {
  startedAt: string | null;
  timeLimitSec: number;
  localNowMs: number;
  clockOffsetMs?: number;
}): { remainingSeconds: number; hasStarted: boolean; elapsedSec: number; limitSec: number } {
  const startedMs = params.startedAt ? Date.parse(params.startedAt) : NaN;
  const hasStarted = Number.isFinite(startedMs);
  const limitSec =
    Number.isFinite(params.timeLimitSec) && params.timeLimitSec > 0
      ? Math.floor(params.timeLimitSec)
      : 0;
  // ★ ここが clock drift 補正の本体。ローカル時計に server との差を足してから比較する。
  const correctedNow = params.localNowMs + (params.clockOffsetMs ?? 0);
  const elapsedSec = hasStarted ? Math.floor((correctedNow - startedMs) / 1000) : 0;
  const remainingSeconds = hasStarted ? Math.max(0, limitSec - elapsedSec) : limitSec;
  return { remainingSeconds, hasStarted, elapsedSec, limitSec };
}

export function useCareerGdTimer({
  startedAt,
  timeLimitSec,
  enabled = true,
  clockOffsetMs = 0,
}: UseCareerGdTimerArgs): UseCareerGdTimerResult {
  const [now, setNow] = useState<number>(() => Date.now());

  const { remainingSeconds, hasStarted, elapsedSec, limitSec } = computeGdRemainingSeconds({
    startedAt,
    timeLimitSec,
    localNowMs: now,
    clockOffsetMs,
  });

  const remainingMs = remainingSeconds * 1000;
  const isExpired = hasStarted && remainingSeconds === 0;
  const progressRatio = limitSec > 0 ? Math.min(1, Math.max(0, elapsedSec / limitSec)) : 0;
  const shouldAutoFinish = enabled && isExpired;

  // 表示のみ 1 秒更新。開始前 / 期限切れ後は tick 不要（無駄な再描画を避け、now を止める）。
  useEffect(() => {
    if (!enabled || !hasStarted || isExpired) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled, hasStarted, isExpired]);

  return {
    remainingMs,
    remainingSeconds,
    formattedTime: formatMmSs(remainingSeconds),
    isExpired,
    progressRatio,
    shouldAutoFinish,
    hasStarted,
  };
}

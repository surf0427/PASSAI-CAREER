'use client';

// PASSAI 就活版 — GD マルチ タイマー同期 Hook（STEP-GD-26）。
//
// 全参加者に同じ残り時間を見せるため、正本を「server 保存済みの started_at + 制限時間」に固定する。
//   remaining = (started_at + timeLimitSec) - now
// started_at は DB 値（server now）を使い、クライアント時刻を正本にしない。表示のみ 1 秒ごとに更新し、
// DB へは一切書き込まない（毎秒 DB 更新の禁止）。0 到達は shouldAutoFinish で上位に通知するだけで、
// 終了 API 呼び出し自体は上位 component（host のみ）が制御する。
//
// 既存 DB 契約: 制限時間カラムは career_gd_rooms.time_limit_sec（秒）。current_phase /
// duration_minutes / ended_at 等は存在しないため使わない（started_at / finished_at / time_limit_sec）。

import { useEffect, useState } from 'react';

export type UseCareerGdTimerArgs = {
  startedAt: string | null; // career_gd_rooms.started_at（ISO・未開始は null）
  timeLimitSec: number; // career_gd_rooms.time_limit_sec
  enabled?: boolean; // active のときだけ tick / 自動終了判定（既定 true）
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

export function useCareerGdTimer({
  startedAt,
  timeLimitSec,
  enabled = true,
}: UseCareerGdTimerArgs): UseCareerGdTimerResult {
  const [now, setNow] = useState<number>(() => Date.now());

  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  const hasStarted = Number.isFinite(startedMs);
  const limitSec = Number.isFinite(timeLimitSec) && timeLimitSec > 0 ? Math.floor(timeLimitSec) : 0;

  const elapsedSec = hasStarted ? Math.floor((now - startedMs) / 1000) : 0;
  const remainingSeconds = hasStarted ? Math.max(0, limitSec - elapsedSec) : limitSec;
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

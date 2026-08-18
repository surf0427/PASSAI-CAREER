// PASSAI 就活版 — GD マルチ room のライフサイクル強制（server-only・STEP-GD-31）。
//
// 本モジュールが担うのは 2 つだけ:
//   ① server-side timer enforcement … 期限切れ room を **誰のリクエストでも** 1 回だけ finished 化する
//   ② presence sweep                … 期限切れ heartbeat を disconnected / stale へ落とす
//
// 設計方針:
//   - 時刻の正本は **DB の now()**。クライアント時計にも Node の Date.now() にも依存しない
//     （RPC 内で `started_at + time_limit_sec <= now()` を評価する）。
//   - race 安全: RPC は `status='active'` 条件付き UPDATE 1 文。同時に複数クライアントが
//     期限切れを検知しても finished 化できるのは 1 リクエストだけ（既存 finish route と同一意味論）。
//   - **never-throw**: ライフサイクル維持は本来の要求（発言取得など）の付随処理であり、
//     ここで失敗しても本処理を落とさない。DDL 未適用環境（RPC 不在）でも安全に degrade する。
//   - fallback: RPC が無い環境では app 層の条件付き UPDATE で同じ結果を作る
//     （career_gd_realtime_apply.sql 未適用でも「時間切れで永遠に active」を防ぐ）。

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  GD_DISCONNECT_AFTER_SEC,
  GD_STALE_AFTER_SEC,
} from '@/lib/careerGd/presence';

type Row = Record<string, unknown>;

/** Postgres の「関数未定義」（career_gd_realtime_apply.sql 未適用）を検出。 */
function isUndefinedFunction(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === '42883' ||
    e.code === 'PGRST202' || // PostgREST: schema cache に関数が無い
    (typeof e.message === 'string' && /function .* does not exist|could not find the function/i.test(e.message))
  );
}

/**
 * room 行が期限切れかを判定する純関数（表示・分岐用）。
 *
 * ★ これは「早期リターンのための当たり判定」であり、**終了の決定権は持たない**。
 *   実際の finished 化は必ず DB 側の now() で再評価される（下の finishRoomIfExpired）。
 *   よってサーバの Node プロセス時計が多少ずれていても、DB が最終判定を行う。
 */
export function isRoomExpiredByRow(row: Row, nowMs: number): boolean {
  if (row.status !== 'active') return false;
  const startedAt = typeof row.started_at === 'string' ? Date.parse(row.started_at) : NaN;
  if (!Number.isFinite(startedAt)) return false;
  const limitSec =
    typeof row.time_limit_sec === 'number' ? row.time_limit_sec : Number(row.time_limit_sec);
  if (!Number.isFinite(limitSec) || limitSec <= 0) return false;
  return startedAt + limitSec * 1000 <= nowMs;
}

export type FinishIfExpiredResult =
  /** この呼び出しが finished 化した（canonical な 1 回）。 */
  | { kind: 'finished'; room: Row }
  /** 期限内、または既に他が finish 済み。 */
  | { kind: 'noop' }
  /** 判定できなかった（DB 障害等）。呼び出し側は本処理を続行してよい。 */
  | { kind: 'unavailable' };

/**
 * 期限切れなら room を finished 化する（atomic・冪等・never-throw）。
 *
 * host のクライアントが落ちていても、**他の参加者の通常リクエスト**（発言取得・room 取得）が
 * 通るたびに評価されるため、「時間切れ後に永遠 active」が発生しない。
 * 誰も見ていない部屋は cron（/api/cron/gd-cleanup）が全体 sweep で回収する。
 */
export async function finishRoomIfExpired(
  admin: SupabaseClient,
  roomId: string,
): Promise<FinishIfExpiredResult> {
  try {
    const { data, error } = await admin.rpc('career_gd_finish_if_expired', { p_room_id: roomId });
    if (!error) {
      // RPC は「更新できたら行、できなければ NULL」を返す。
      const row = (Array.isArray(data) ? data[0] : data) as Row | null | undefined;
      return row && row.id ? { kind: 'finished', room: row } : { kind: 'noop' };
    }
    if (!isUndefinedFunction(error)) {
      console.error('Career GD lifecycle: finish_if_expired rpc error', error.message ?? error);
      return { kind: 'unavailable' };
    }
    // ── fallback（career_gd_realtime_apply.sql 未適用環境）──
    // DB now() は使えないので、対象行を読んでから条件付き UPDATE で race 安全に finish する。
    const { data: roomRow, error: readErr } = await admin
      .from('career_gd_rooms')
      .select('id, status, started_at, time_limit_sec')
      .eq('id', roomId)
      .maybeSingle();
    if (readErr || !roomRow) return { kind: 'unavailable' };
    if (!isRoomExpiredByRow(roomRow as Row, Date.now())) return { kind: 'noop' };

    const { data: updated, error: updErr } = await admin
      .from('career_gd_rooms')
      .update({ status: 'finished', finished_at: new Date().toISOString() })
      .eq('id', roomId)
      .eq('status', 'active')
      .select('*');
    if (updErr) return { kind: 'unavailable' };
    const row = (updated ?? [])[0] as Row | undefined;
    return row ? { kind: 'finished', room: row } : { kind: 'noop' };
  } catch (e) {
    console.error('Career GD lifecycle: finish_if_expired failed', e instanceof Error ? e.message : e);
    return { kind: 'unavailable' };
  }
}

export type SweepPresenceResult = {
  disconnected: number;
  stale: number;
  /** RPC 未適用などで sweep できなかった（呼び出し側は degrade して続行）。 */
  unavailable: boolean;
};

/**
 * room の presence を sweep する（never-throw）。
 *
 * 呼び出しは room GET / messages GET など「誰かが部屋を見ている」経路から行う。
 * 見ている人が居る限り、他人の切断は最大 3 秒（ポーリング周期）で反映される。
 * 誰も見ていない部屋は cron の全体 sweep が拾う。
 *
 * ★ 閾値は lib/careerGd/presence.ts の定数を渡す（client 表示と同じ値を共有）。
 */
export async function sweepRoomPresence(
  admin: SupabaseClient,
  roomId: string,
): Promise<SweepPresenceResult> {
  try {
    const { data, error } = await admin.rpc('career_gd_sweep_presence', {
      p_room_id: roomId,
      p_disconnect_sec: GD_DISCONNECT_AFTER_SEC,
      p_stale_sec: GD_STALE_AFTER_SEC,
    });
    if (error) {
      if (!isUndefinedFunction(error)) {
        console.error('Career GD lifecycle: sweep_presence rpc error', error.message ?? error);
      }
      return { disconnected: 0, stale: 0, unavailable: true };
    }
    const row = (Array.isArray(data) ? data[0] : data) as Row | null | undefined;
    return {
      disconnected: Number(row?.disconnected_count ?? 0) || 0,
      stale: Number(row?.stale_count ?? 0) || 0,
      unavailable: false,
    };
  } catch {
    return { disconnected: 0, stale: 0, unavailable: true };
  }
}

/**
 * room を「見る」ときの共通メンテナンス。
 *
 * ① 期限切れなら finished 化 → ② presence sweep、の順に行う
 * （終端 room は sweep 対象外なので、先に finish させた方が無駄な UPDATE を打たない）。
 *
 * 戻り値は「room 行を読み直すべきか」。true なら呼び出し側は room を再取得する。
 */
export async function maintainRoom(
  admin: SupabaseClient,
  roomId: string,
): Promise<{ roomChanged: boolean; finishedRoom: Row | null }> {
  const expiry = await finishRoomIfExpired(admin, roomId);
  await sweepRoomPresence(admin, roomId);
  return {
    roomChanged: expiry.kind === 'finished',
    finishedRoom: expiry.kind === 'finished' ? expiry.room : null,
  };
}

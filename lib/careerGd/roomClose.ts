// PASSAI 就活版 — GD マルチ ルームの終了（論理削除）共通ヘルパー（server-only）。
//
// 修正2（部屋の削除・終了）/ 修正3（リーダー退出）で共用する。
//   - status が waiting / active の room を cancelled にする（論理削除）。
//   - 既に finished / cancelled は冪等成功（現在行を返す）。
//   - status='waiting' or 'active' 条件付き UPDATE でレース耐性を持たせ、
//     「部屋を終了」と「リーダー退出」が同時に走っても二重処理にならない。
//   - 参加者を退出扱い（left_at）にし、残存参加者情報を整理する（best-effort）。
//
// DB 操作は service-role クライアント（API ゲートウェイ方式）。呼び出し側で host 権限を検証する。

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

export type CancelRoomResult =
  | { kind: 'ok'; row: Row; alreadyClosed: boolean }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

// room を cancelled にする（論理削除）。既に終端状態なら冪等に現在行を返す。
export async function cancelRoom(admin: SupabaseClient, roomId: string): Promise<CancelRoomResult> {
  // ── 現在の room を取得 ──
  const { data: roomRow, error: roomErr } = await admin
    .from('career_gd_rooms')
    .select('*')
    .eq('id', roomId)
    .maybeSingle();
  if (roomErr) return { kind: 'error', message: roomErr.message };
  if (!roomRow) return { kind: 'not_found' };

  const status = (roomRow as Row).status;

  // 既に終端（finished / cancelled）→ 冪等成功。二重終了で不整合を起こさない。
  if (status === 'cancelled' || status === 'finished') {
    return { kind: 'ok', row: roomRow as Row, alreadyClosed: true };
  }

  // ── waiting / active → cancelled（条件付き UPDATE でレース耐性） ──
  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await admin
    .from('career_gd_rooms')
    .update({ status: 'cancelled', finished_at: nowIso })
    .eq('id', roomId)
    .in('status', ['waiting', 'active'])
    .select('*');
  if (updErr) return { kind: 'error', message: updErr.message };

  const updatedRow = (updated ?? [])[0] as Row | undefined;
  if (!updatedRow) {
    // 別リクエストが先に終端化した。最新を取り直して冪等に返す。
    const { data: latest } = await admin
      .from('career_gd_rooms')
      .select('*')
      .eq('id', roomId)
      .maybeSingle();
    if (latest) return { kind: 'ok', row: latest as Row, alreadyClosed: true };
    return { kind: 'not_found' };
  }

  // ── 参加者を退出扱いにする（残存参加者情報の整理・best-effort） ──
  // 失敗しても room は既に cancelled。次周期の poll / cleanup で回収されるため throw しない。
  const { error: leaveErr } = await admin
    .from('career_gd_room_members')
    .update({ left_at: nowIso })
    .eq('room_id', roomId)
    .is('left_at', null);
  if (leaveErr) {
    console.error('Career GD cancelRoom: mark members left error', leaveErr.message);
  }

  return { kind: 'ok', row: updatedRow, alreadyClosed: false };
}

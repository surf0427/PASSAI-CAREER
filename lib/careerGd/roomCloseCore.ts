// PASSAI 就活版 — GD マルチ ルーム終了（論理削除）の中核ロジック。
//
// roomClose.ts（server-only ラッパ）から呼ばれる純粋な非同期関数。
// DI seam として Supabase client を引数で受け取り、`server-only` を持たないため
// fake adapter を注入した決定的 QA が可能（scripts/gd-qa/roomClose.qa.ts）。
//
// 再実行整合性の要点は roomClose.ts の冒頭コメントを参照。

import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

export type CancelRoomResult =
  | { kind: 'ok'; row: Row; alreadyClosed: boolean }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

export async function cancelRoomCore(admin: SupabaseClient, roomId: string): Promise<CancelRoomResult> {
  // ── 現在の room を取得 ──
  const { data: roomRow, error: roomErr } = await admin
    .from('career_gd_rooms')
    .select('*')
    .eq('id', roomId)
    .maybeSingle();
  if (roomErr) return { kind: 'error', message: roomErr.message };
  if (!roomRow) return { kind: 'not_found' };

  const status = (roomRow as Row).status;

  // finished は cancelled で上書きしない。結果整合性のため member cleanup もしない
  // （finished room の member は結果採点の対象＝left_at を立てない）。
  if (status === 'finished') {
    return { kind: 'ok', row: roomRow as Row, alreadyClosed: true };
  }

  let finalRow = roomRow as Row;
  let alreadyClosed = status === 'cancelled';

  if (status !== 'cancelled') {
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
    if (updatedRow) {
      finalRow = updatedRow;
    } else {
      // 競合: 別リクエストが先に終端化した。最新を取り直す。
      const { data: latest, error: latestErr } = await admin
        .from('career_gd_rooms')
        .select('*')
        .eq('id', roomId)
        .maybeSingle();
      if (latestErr) return { kind: 'error', message: latestErr.message };
      if (!latest) return { kind: 'not_found' };
      finalRow = latest as Row;
      alreadyClosed = true;
      // finished を上書きしない。finished なら member cleanup せずに返す。
      if ((latest as Row).status === 'finished') {
        return { kind: 'ok', row: latest as Row, alreadyClosed: true };
      }
      // それ以外（= cancelled）は下の cleanup へ進む（部分障害の補正のため再実行する）。
    }
  }

  // ── member cleanup（room が cancelled 確定時は毎回・冪等）──
  // `left_at IS NULL` の member だけ更新するため、既に cancelled の room で再実行しても安全。
  // 部分障害（room=cancelled だが member 未整理）は次回 cancelRoom 呼び出しでここが再走し補正される。
  const cleanupIso = new Date().toISOString();
  const { error: leaveErr } = await admin
    .from('career_gd_room_members')
    .update({ left_at: cleanupIso })
    .eq('room_id', roomId)
    .is('left_at', null);
  if (leaveErr) {
    // room は既に cancelled（正本）。best-effort・次回 cancelRoom 呼び出しで再試行され補正される。
    console.error('Career GD cancelRoom: mark members left error', leaveErr.message);
  }

  return { kind: 'ok', row: finalRow, alreadyClosed };
}

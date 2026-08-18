// PASSAI 就活版 — GD Phase2 マルチGD 終了 API（STEP-GD-14）。
//
// POST /api/career/gd/room/[roomId]/finish
//   - member ログイン必須。host のみ終了できる。
//   - active の room のみ finished 化できる（finished_at を設定）。
//   - 二重終了は冪等（既に finished なら 200 で現在状態を返す）。
//   - waiting / cancelled は 409。
//   - messages が 0 件でも壊れない（発言の有無に依存しない）。
//   - status='active' 条件付き UPDATE を使い、同時終了レースでも二重処理しない。

import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  dbNotAppliedResponse,
} from '../../roomAuth';
import { mapRoomRow } from '../../roomMappers';

import { requireCareerGdEnabled } from '@/lib/careerGdGate/flags.server';
export const maxDuration = 30;

type Row = Record<string, unknown>;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

export async function POST(_req: Request, ctx: { params: Promise<{ roomId: string }> }) {
  // ── STEP-GD-31: GD kill switch（server flag が最終権限）──
  //    OFF なら body parse / auth / DB / AI へ到達する前に 404。UI flag は権限に影響しない。
  const gdGate = requireCareerGdEnabled();
  if (gdGate) return gdGate;

  const { roomId } = await ctx.params;
  if (!roomId) return jsonError('BAD_REQUEST', 'ルームIDが不正です。', 400);

  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  const { data: roomRow, error: roomErr } = await admin
    .from('career_gd_rooms')
    .select('*')
    .eq('id', roomId)
    .maybeSingle();
  if (roomErr) {
    if (isUndefinedTable(roomErr)) return dbNotAppliedResponse();
    console.error('Career GD finish: room lookup error', roomErr.message);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  if (!roomRow) return jsonError('ROOM_NOT_FOUND', 'ルームが見つかりません。', 404);

  // host 判定（member かつ is_host）。
  const { data: hostRow, error: hostErr } = await admin
    .from('career_gd_room_members')
    .select('is_host')
    .eq('room_id', roomId)
    .eq('user_id', auth.userId)
    .maybeSingle();
  if (hostErr) {
    if (isUndefinedTable(hostErr)) return dbNotAppliedResponse();
    console.error('Career GD finish: member lookup error', hostErr.message);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  if (!hostRow) return jsonError('NOT_A_MEMBER', 'このルームの参加者ではありません。', 403);
  if (hostRow.is_host !== true) return jsonError('NOT_HOST', 'ルームを終了できるのはホストのみです。', 403);

  const status = (roomRow as Row).status;
  // 既に finished → 冪等成功。
  if (status === 'finished') {
    return Response.json({ room: mapRoomRow(roomRow as Row), status: 'finished' });
  }
  // active 以外（waiting / cancelled）は終了不可。
  if (status !== 'active') {
    return jsonError('ROOM_NOT_ACTIVE', 'このルームは進行中ではないため終了できません。', 409);
  }

  // active → finished（条件付き UPDATE でレース耐性）。
  const finishedAt = new Date().toISOString();
  const { data: updated, error: updErr } = await admin
    .from('career_gd_rooms')
    .update({ status: 'finished', finished_at: finishedAt })
    .eq('id', roomId)
    .eq('status', 'active')
    .select('*');
  if (updErr) {
    if (isUndefinedTable(updErr)) return dbNotAppliedResponse();
    console.error('Career GD finish: update error', updErr.message);
    return jsonError('ROOM_FINISH_FAILED', 'ルームの終了に失敗しました。', 500);
  }
  const updatedRow = (updated ?? [])[0] as Row | undefined;
  if (!updatedRow) {
    // 別リクエストが先に終了/変更した。最新を取り直す。
    const { data: latest } = await admin.from('career_gd_rooms').select('*').eq('id', roomId).maybeSingle();
    if (latest && (latest as Row).status === 'finished') {
      return Response.json({ room: mapRoomRow(latest as Row), status: 'finished' });
    }
    return jsonError('ROOM_NOT_ACTIVE', 'このルームは進行中ではないため終了できません。', 409);
  }

  return Response.json({ room: mapRoomRow(updatedRow), status: 'finished' });
}

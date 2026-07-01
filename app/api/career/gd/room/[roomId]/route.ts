// PASSAI 就活版 — GD Phase2 マルチGD ルーム取得 API（STEP-GD-12）。
//
// GET /api/career/gd/room/[roomId]?afterSeq=<n>
//   - member ログイン必須。room 参加者のみ閲覧可（非参加者は 403）。
//   - room / members / messages を返す（join_code_hash は返さない）。
//   - messages は STEP-GD-14 まで空でよい。afterSeq でポーリング差分取得に対応。
//   - service-role で DB 操作（クライアントは room 系テーブルを直接叩かない）。

import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  dbNotAppliedResponse,
} from '../roomAuth';
import { mapRoomRow, mapMemberRow, mapMessageRow } from '../roomMappers';

export const maxDuration = 30;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  if (!roomId) {
    return jsonError('BAD_REQUEST', 'ルームIDが不正です。', 400);
  }

  // ── 認証（member 必須） ──
  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const userId = auth.userId;

  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // ── room 取得 ──
  const { data: roomRow, error: roomErr } = await admin
    .from('career_gd_rooms')
    .select('*')
    .eq('id', roomId)
    .maybeSingle();
  if (roomErr) {
    if (isUndefinedTable(roomErr)) return dbNotAppliedResponse();
    console.error('Career GD room get: room lookup error', roomErr.message);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  if (!roomRow) {
    return jsonError('ROOM_NOT_FOUND', 'ルームが見つかりません。', 404);
  }

  // ── members 取得 ──
  let memberRows: Record<string, unknown>[];
  {
    const { data, error } = await admin
      .from('career_gd_room_members')
      .select('*')
      .eq('room_id', roomId)
      .order('joined_at', { ascending: true });
    if (error) {
      if (isUndefinedTable(error)) return dbNotAppliedResponse();
      console.error('Career GD room get: members lookup error', error.message);
      return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
    }
    memberRows = (data ?? []) as Record<string, unknown>[];
  }

  // ── 参加者本人のみ閲覧可 ──
  const currentRow = memberRows.find((m) => m.user_id === userId) ?? null;
  if (!currentRow) {
    return jsonError('NOT_A_MEMBER', 'このルームの参加者ではありません。', 403);
  }

  // ── messages 取得（afterSeq でポーリング差分。STEP-GD-14 までは空でも可） ──
  const afterSeqRaw = new URL(req.url).searchParams.get('afterSeq');
  const afterSeq = afterSeqRaw != null && afterSeqRaw !== '' ? Number(afterSeqRaw) : null;
  let messageRows: Record<string, unknown>[] = [];
  {
    let q = admin
      .from('career_gd_room_messages')
      .select('*')
      .eq('room_id', roomId)
      .order('seq', { ascending: true });
    if (afterSeq != null && Number.isFinite(afterSeq)) {
      q = q.gt('seq', afterSeq);
    }
    const { data, error } = await q;
    if (error) {
      if (isUndefinedTable(error)) return dbNotAppliedResponse();
      console.error('Career GD room get: messages lookup error', error.message);
      return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
    }
    messageRows = (data ?? []) as Record<string, unknown>[];
  }

  const room = mapRoomRow(roomRow);
  const currentUserMember = mapMemberRow(currentRow);
  return Response.json({
    room,
    members: memberRows.map(mapMemberRow),
    messages: messageRows.map(mapMessageRow),
    isHost: currentRow.is_host === true,
    currentUserMember,
    status: room.status,
  });
}

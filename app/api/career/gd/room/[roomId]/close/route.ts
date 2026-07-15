// PASSAI 就活版 — GD マルチ ルーム終了（削除）API（修正2）。
//
// POST /api/career/gd/room/[roomId]/close
//   - member ログイン必須。host（作成者）のみ終了できる。
//   - waiting / active の room を cancelled（論理削除）にする。参加者は退出扱い。
//   - 二重終了は冪等（既に cancelled / finished なら 200）。
//   - status 条件付き UPDATE（cancelRoom）でリーダー退出（leave）と同時実行でも二重処理しない。
//   - 表示制御とは別に、サーバ側でも host 権限を検証する（一般参加者の直接リクエストは 403）。
//
// finish（active→finished）とは別物: close はロビー段階（waiting）でも実行でき、結果は残さず中止扱い。

import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  dbNotAppliedResponse,
} from '../../roomAuth';
import { cancelRoom } from '@/lib/careerGd/roomClose';
import { mapRoomRow } from '../../roomMappers';

export const maxDuration = 30;

type Row = Record<string, unknown>;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

export async function POST(_req: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params;
  if (!roomId) return jsonError('BAD_REQUEST', 'ルームIDが不正です。', 400);

  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // ── host 判定（member かつ is_host）。session の user_id で判定＝ID 差し替え不可 ──
  const { data: memberRow, error: memberErr } = await admin
    .from('career_gd_room_members')
    .select('is_host')
    .eq('room_id', roomId)
    .eq('user_id', auth.userId)
    .maybeSingle();
  if (memberErr) {
    if (isUndefinedTable(memberErr)) return dbNotAppliedResponse();
    console.error('Career GD close: member lookup error', memberErr.message);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  if (!memberRow) return jsonError('NOT_A_MEMBER', 'このルームの参加者ではありません。', 403);
  if (memberRow.is_host !== true) return jsonError('NOT_HOST', 'ルームを終了できるのはホストのみです。', 403);

  // ── cancelled 化（冪等・レース耐性） ──
  const result = await cancelRoom(admin, roomId);
  if (result.kind === 'not_found') return jsonError('ROOM_NOT_FOUND', 'ルームが見つかりません。', 404);
  if (result.kind === 'error') {
    if (isUndefinedTable({ message: result.message })) return dbNotAppliedResponse();
    console.error('Career GD close: cancel error', result.message);
    return jsonError('ROOM_CLOSE_FAILED', 'ルームの終了に失敗しました。', 500);
  }

  return Response.json({ room: mapRoomRow(result.row as Row), status: 'cancelled' });
}

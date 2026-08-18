// PASSAI 就活版 — GD マルチ ルーム退出 API（修正3）。
//
// POST /api/career/gd/room/[roomId]/leave
//   - member ログイン必須。参加者本人のみ（非参加者は 403）。
//   - host（リーダー）が退出 → ルームを cancelled 化（cancelRoom・修正2 と共通）。
//     ＝リーダーが明示的に抜けたらセッションを終了し、残存参加者・部屋を残さない。
//   - 一般参加者が退出 → 自分の member 行のみ left_at を立てる（部屋は継続）。
//   - 冪等: 既に終端 / 既に退出済みでも 200。close と同時実行でも cancelRoom の
//     条件付き UPDATE により二重終了しない。
//
// 注意: 通信断・画面更新では呼ばれない（明示的な退出操作のみ）。誤終了を避けるための安全側設計。

import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  dbNotAppliedResponse,
} from '../../roomAuth';
import { cancelRoom } from '@/lib/careerGd/roomClose';
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

  // ── 自分の member 行（非参加者は 403）。session の user_id で判定＝ID 差し替え不可 ──
  const { data: memberRow, error: memberErr } = await admin
    .from('career_gd_room_members')
    .select('id, is_host, left_at')
    .eq('room_id', roomId)
    .eq('user_id', auth.userId)
    .maybeSingle();
  if (memberErr) {
    if (isUndefinedTable(memberErr)) return dbNotAppliedResponse();
    console.error('Career GD leave: member lookup error', memberErr.message);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  if (!memberRow) return jsonError('NOT_A_MEMBER', 'このルームの参加者ではありません。', 403);

  // ── host（リーダー）退出 → ルーム終了（cancelRoom が参加者も退出扱いにする） ──
  if (memberRow.is_host === true) {
    const result = await cancelRoom(admin, roomId);
    if (result.kind === 'not_found') return jsonError('ROOM_NOT_FOUND', 'ルームが見つかりません。', 404);
    if (result.kind === 'error') {
      if (isUndefinedTable({ message: result.message })) return dbNotAppliedResponse();
      console.error('Career GD leave: host cancel error', result.message);
      return jsonError('ROOM_LEAVE_FAILED', 'ルームの退出処理に失敗しました。', 500);
    }
    // 実際の room 状態を返す（finished room に leave された場合は finished のまま）。
    const mapped = mapRoomRow(result.row as Row);
    return Response.json({ room: mapped, status: mapped.status, hostLeft: true });
  }

  // ── 一般参加者 → 自分の行のみ退出（部屋は継続）。既に退出済みは冪等成功 ──
  if (memberRow.left_at == null) {
    const { error: leaveErr } = await admin
      .from('career_gd_room_members')
      .update({ left_at: new Date().toISOString() })
      .eq('id', memberRow.id)
      .is('left_at', null);
    if (leaveErr) {
      if (isUndefinedTable(leaveErr)) return dbNotAppliedResponse();
      console.error('Career GD leave: member leave error', leaveErr.message);
      return jsonError('ROOM_LEAVE_FAILED', 'ルームの退出処理に失敗しました。', 500);
    }
  }
  return Response.json({ status: 'left', hostLeft: false });
}

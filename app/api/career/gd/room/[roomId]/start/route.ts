// PASSAI 就活版 — GD Phase2 マルチGD 開始 API（STEP-GD-13）。
//
// POST /api/career/gd/room/[roomId]/start
//   - member ログイン必須。room 参加者かつ host のみ開始可。
//   - waiting の room を active にし、planned_participant_count まで AI メンバーを補完する。
//   - AI 補完は buildAiRoomMembers()（roomId seed で deterministic・既存 persona_key は除外）。
//   - 同時開始レースに耐えるため、status='waiting' 条件付き UPDATE を「開始権の取得」に使う。
//     取得できなかった側（既に active 等）は 409 を返す。
//   - 応答は GET room と同じ形（{ room, members, messages, isHost, currentUserMember, status }）。
//   - service-role で DB 操作（クライアントは room 系テーブルを直接叩かない）。
//
// 本 STEP では「AI 補完して開始（waiting→active）」まで。テーマ確定・役割割当・発言生成・
// ターン進行・feedback は STEP-GD-14 以降（role は 'member' のまま / theme は未確定のまま）。

import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  dbNotAppliedResponse,
} from '../../roomAuth';
import { mapRoomRow, mapMemberRow } from '../../roomMappers';
import { buildAiRoomMembers } from '../../aiMembers';

export const maxDuration = 30;

type Row = Record<string, unknown>;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

export async function POST(
  _req: Request,
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

  // ── room 取得（存在しなければ 404） ──
  const { data: roomRow, error: roomErr } = await admin
    .from('career_gd_rooms')
    .select('*')
    .eq('id', roomId)
    .maybeSingle();
  if (roomErr) {
    if (isUndefinedTable(roomErr)) return dbNotAppliedResponse();
    console.error('Career GD room start: room lookup error', roomErr.message);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  if (!roomRow) {
    return jsonError('ROOM_NOT_FOUND', 'ルームが見つかりません。', 404);
  }

  // ── members 取得 ──
  const { data: memberData, error: memberErr } = await admin
    .from('career_gd_room_members')
    .select('*')
    .eq('room_id', roomId)
    .order('joined_at', { ascending: true });
  if (memberErr) {
    if (isUndefinedTable(memberErr)) return dbNotAppliedResponse();
    console.error('Career GD room start: members lookup error', memberErr.message);
    return jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500);
  }
  const memberRows = (memberData ?? []) as Row[];

  // ── 参加者本人か / host か ──
  const currentRow = memberRows.find((m) => m.user_id === userId) ?? null;
  if (!currentRow) {
    return jsonError('NOT_A_MEMBER', 'このルームの参加者ではありません。', 403);
  }
  if (currentRow.is_host !== true) {
    return jsonError('NOT_HOST', 'ルームを開始できるのはホストのみです。', 403);
  }

  // ── waiting 以外は開始不可（already active/finished/cancelled は 409） ──
  if (roomRow.status !== 'waiting') {
    return jsonError('ROOM_NOT_WAITING', 'このルームはすでに開始済み、または終了しています。', 409);
  }

  // ── AI 補完人数を算出（planned まで。退室者は数えない） ──
  const activeMembers = memberRows.filter((m) => m.left_at == null);
  const planned = typeof roomRow.planned_participant_count === 'number'
    ? roomRow.planned_participant_count
    : Number(roomRow.planned_participant_count) || activeMembers.length;
  const neededAi = Math.max(0, planned - activeMembers.length);
  const existingAiKeys = memberRows
    .filter((m) => m.is_ai === true)
    .map((m) => {
      const persona = m.persona && typeof m.persona === 'object' ? (m.persona as Row) : null;
      return persona && typeof persona.persona_key === 'string' ? persona.persona_key : '';
    })
    .filter((k): k is string => k !== '');

  // ── 開始権の取得（同時開始レース対策の要）: status='waiting' 条件付き UPDATE ──
  //    ここで 1 行更新できた呼び出しだけが「開始した本人」。0 行なら他が先に開始した＝409。
  const startedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await admin
    .from('career_gd_rooms')
    .update({ status: 'active', started_at: startedAt })
    .eq('id', roomId)
    .eq('status', 'waiting')
    .select('*');
  if (claimErr) {
    if (isUndefinedTable(claimErr)) return dbNotAppliedResponse();
    console.error('Career GD room start: claim update error', claimErr.message);
    return jsonError('ROOM_START_FAILED', 'ルームの開始に失敗しました。', 500);
  }
  const claimedRow = (claimed ?? [])[0] as Row | undefined;
  if (!claimedRow) {
    // 別リクエストが先に開始した（waiting でなくなった）。二重開始・二重AI補完を防ぐ。
    return jsonError('ROOM_ALREADY_STARTED', 'このルームはすでに開始されています。画面を更新してください。', 409);
  }

  // ── AI メンバーを補完（開始権を取れた本人のみ実行 → 二重 insert しない） ──
  if (neededAi > 0) {
    const aiRows = buildAiRoomMembers(roomId, neededAi, existingAiKeys).map((r) => ({
      ...r,
      room_id: roomId,
    }));
    const { error: aiErr } = await admin.from('career_gd_room_members').insert(aiRows);
    if (aiErr) {
      // 補完に失敗したら開始をロールバック（best-effort）して失敗を返す。
      console.error('Career GD room start: ai members insert error', aiErr.message);
      await admin
        .from('career_gd_rooms')
        .update({ status: 'waiting', started_at: null })
        .eq('id', roomId)
        .eq('status', 'active');
      return jsonError('ROOM_START_FAILED', 'AIメンバーの補完に失敗しました。時間をおいて再度お試しください。', 500);
    }
  }

  // ── 最新 members を取り直して GET room と同じ形で返す ──
  const { data: finalMembers, error: finalErr } = await admin
    .from('career_gd_room_members')
    .select('*')
    .eq('room_id', roomId)
    .order('joined_at', { ascending: true });
  if (finalErr) {
    console.error('Career GD room start: final members lookup error', finalErr.message);
    return jsonError('ROOM_FETCH_FAILED', '開始後のルーム情報取得に失敗しました。', 500);
  }
  const finalRows = (finalMembers ?? []) as Row[];
  const room = mapRoomRow(claimedRow);
  const currentFinalRow = finalRows.find((m) => m.user_id === userId) ?? currentRow;

  return Response.json({
    room,
    members: finalRows.map(mapMemberRow),
    messages: [], // 発言は STEP-GD-14 以降
    isHost: true,
    currentUserMember: mapMemberRow(currentFinalRow),
    status: room.status,
  });
}

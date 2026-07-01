// PASSAI 就活版 — GD Phase2 マルチGD 発言 API（STEP-GD-14）。
//
// GET  /api/career/gd/room/[roomId]/messages?afterSeq=<n>
//   - member ログイン必須。room 参加者のみ（非参加者 403）。
//   - afterSeq 以降の発言を seq 昇順で返す（ポーリング差分取得用）。
//
// POST /api/career/gd/room/[roomId]/messages
//   - member ログイン必須。room 参加者のみ。room.status='active' のときだけ投稿可。
//   - 人間ユーザーは「自分の member（participant_id）」としてのみ投稿できる。
//   - 入力: { content, clientMsgId }（kind は speech 固定）。content は空不可。
//   - client_msg_id が同一 (room, client_msg_id) なら冪等に同じ message を返す。
//   - seq は room 単位でサーバ採番（roomMessages.postRoomMessage）。
//   - 応答に service_role key / pepper / env 値は含めない。
//
// service-role で DB 操作（クライアントは room 系テーブルを直接叩かない）。

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  dbNotAppliedResponse,
} from '../../roomAuth';
import { mapMessageRow } from '../../roomMappers';
import { postRoomMessage, loadRoomMessages } from '../../roomMessages';

export const maxDuration = 30;

const MAX_CONTENT_CHARS = 600;

type Row = Record<string, unknown>;

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

// room + members を取り、認証ユーザーの member 行を返す共通処理。
async function loadRoomAndMember(admin: SupabaseClient, roomId: string, userId: string) {
  const { data: roomRow, error: roomErr } = await admin
    .from('career_gd_rooms')
    .select('*')
    .eq('id', roomId)
    .maybeSingle();
  if (roomErr) {
    if (isUndefinedTable(roomErr)) return { kind: 'reject' as const, response: dbNotAppliedResponse() };
    console.error('Career GD messages: room lookup error', roomErr.message);
    return { kind: 'reject' as const, response: jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500) };
  }
  if (!roomRow) return { kind: 'reject' as const, response: jsonError('ROOM_NOT_FOUND', 'ルームが見つかりません。', 404) };

  const { data: memberData, error: memberErr } = await admin
    .from('career_gd_room_members')
    .select('*')
    .eq('room_id', roomId);
  if (memberErr) {
    if (isUndefinedTable(memberErr)) return { kind: 'reject' as const, response: dbNotAppliedResponse() };
    console.error('Career GD messages: members lookup error', memberErr.message);
    return { kind: 'reject' as const, response: jsonError('ROOM_FETCH_FAILED', 'ルーム情報の取得に失敗しました。', 500) };
  }
  const memberRows = (memberData ?? []) as Row[];
  const currentRow = memberRows.find((m) => m.user_id === userId) ?? null;
  if (!currentRow) return { kind: 'reject' as const, response: jsonError('NOT_A_MEMBER', 'このルームの参加者ではありません。', 403) };

  return { kind: 'ok' as const, roomRow: roomRow as Row, memberRows, currentRow };
}

export async function GET(req: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params;
  if (!roomId) return jsonError('BAD_REQUEST', 'ルームIDが不正です。', 400);

  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  const loaded = await loadRoomAndMember(admin, roomId, auth.userId);
  if (loaded.kind === 'reject') return loaded.response;

  const afterSeqRaw = new URL(req.url).searchParams.get('afterSeq');
  const afterSeq = afterSeqRaw != null && afterSeqRaw !== '' ? Number(afterSeqRaw) : null;

  let rows: Row[];
  try {
    rows = await loadRoomMessages(admin, roomId, afterSeq);
  } catch (e) {
    if (isUndefinedTable(e)) return dbNotAppliedResponse();
    console.error('Career GD messages GET: load error', e);
    return jsonError('MESSAGES_FETCH_FAILED', '発言の取得に失敗しました。', 500);
  }

  const messages = rows.map(mapMessageRow);
  const latestSeq = messages.reduce((max, m) => (m.seq > max ? m.seq : max), 0);
  return Response.json({ messages, latestSeq });
}

export async function POST(req: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params;
  if (!roomId) return jsonError('BAD_REQUEST', 'ルームIDが不正です。', 400);

  // 入力。
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('BAD_REQUEST', 'リクエストボディが不正です。', 400);
  }
  const b = (body && typeof body === 'object' ? body : {}) as { content?: unknown; clientMsgId?: unknown };
  const content = (typeof b.content === 'string' ? b.content : '').trim().slice(0, MAX_CONTENT_CHARS);
  if (!content) return jsonError('EMPTY_CONTENT', '発言内容を入力してください。', 400);
  const clientMsgId = typeof b.clientMsgId === 'string' && b.clientMsgId.trim() !== ''
    ? b.clientMsgId.trim().slice(0, 100)
    : null;
  if (!clientMsgId) return jsonError('MISSING_CLIENT_MSG_ID', 'clientMsgId が必要です。', 400);

  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  const loaded = await loadRoomAndMember(admin, roomId, auth.userId);
  if (loaded.kind === 'reject') return loaded.response;
  const { roomRow, currentRow } = loaded;

  // active のみ投稿可。
  if (roomRow.status !== 'active') {
    return jsonError('ROOM_NOT_ACTIVE', 'このルームは進行中ではありません。', 409);
  }
  // 退室済みは投稿不可。
  if (currentRow.left_at != null) {
    return jsonError('MEMBER_LEFT', 'このルームから退室済みのため投稿できません。', 403);
  }

  // 人間は「自分の member（participant_id）」としてのみ投稿できる。
  const participantId = String(currentRow.participant_id);

  try {
    const { row, idempotent } = await postRoomMessage(admin, {
      roomId,
      participantId,
      senderUserId: auth.userId,
      content,
      kind: 'speech',
      clientMsgId,
    });
    return Response.json({ message: mapMessageRow(row), idempotent });
  } catch (e) {
    if (isUndefinedTable(e)) return dbNotAppliedResponse();
    console.error('Career GD messages POST: post error', e instanceof Error ? e.message : e);
    return jsonError('MESSAGE_POST_FAILED', '発言の投稿に失敗しました。時間をおいて再度お試しください。', 500);
  }
}

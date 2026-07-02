// PASSAI 就活版 — GD 公開ロビー 参加 API（STEP-GD-20-B）。
//
// POST /api/career/gd/lobby/join
//   - member ログイン必須。p_user_id は必ず認証済み user id を使う（body の userId は受け取らない）。
//   - 対象 room が公開待機中であることを確認し、参加は STEP-GD-20-A の RPC
//     career_gd_lobby_join(p_room_id, p_user_id, p_display_name) に委譲する。
//     RPC 内で advisory lock + FOR UPDATE により満員（定員超過）と二重参加を原子的に防ぐ。
//   - 同一 user が既に参加済みなら RPC が既存行を返す＝冪等成功。
//
// 既存 room/join（合言葉 join）には一切触れない。DB 操作は service-role のみ。

import { authenticateGdMember, getGdAdmin } from '@/app/api/career/gd/room/roomAuth';
import {
  PUBLIC_ROOM_TYPE,
  PUBLIC_JOIN_POLICY,
  sanitizeDisplayName,
  lobbyRedirectTo,
  isDbNotReady,
  dbNotReadyResponse,
  isRoomFullError,
  isRoomNotJoinableError,
  jsonError,
} from '@/lib/careerGd/publicLobby';
import type { LobbyJoinResponse } from '@/lib/careerGd/publicLobbyTypes';

export const maxDuration = 30;

export async function POST(req: Request) {
  // ── 1) 入力 ──
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('BAD_REQUEST', 'リクエストボディが不正です。', 400);
  }
  const b = (body && typeof body === 'object' ? body : {}) as {
    roomId?: unknown;
    displayName?: unknown;
  };
  const roomId = typeof b.roomId === 'string' ? b.roomId.trim() : '';
  if (!roomId) {
    return jsonError('INVALID_ROOM_ID', '参加するルームを指定してください。', 400);
  }
  // 表示名は空なら null を渡し、RPC 側の 'メンバー' デフォルトに委ねる。
  const displayNameRaw = sanitizeDisplayName(b.displayName, '');
  const displayName = displayNameRaw || null;

  // ── 2) 認証（member 必須） ──
  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const userId = auth.userId;

  // ── 3) service-role ──
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // ── 4) 事前チェック（正確な HTTP コードのため）。最終判定は RPC がロック下で行う ──
  const { data: roomRow, error: roomErr } = await admin
    .from('career_gd_rooms')
    .select('id, status, room_type, join_policy')
    .eq('id', roomId)
    .maybeSingle();

  if (roomErr) {
    if (isDbNotReady(roomErr)) return dbNotReadyResponse();
    console.error('Career GD lobby join: room lookup error', roomErr.message ?? roomErr);
    return jsonError('JOIN_FAILED', '参加に失敗しました。時間をおいて再度お試しください。', 500);
  }
  if (!roomRow) {
    return jsonError('ROOM_NOT_FOUND', 'ルームが見つかりません。', 404);
  }
  // 公開ロビー以外（invite 等）は存在を明かさず 404。
  if (roomRow.room_type !== PUBLIC_ROOM_TYPE || roomRow.join_policy !== PUBLIC_JOIN_POLICY) {
    return jsonError('ROOM_NOT_FOUND', 'ルームが見つかりません。', 404);
  }
  if (roomRow.status !== 'waiting') {
    return jsonError('ROOM_NOT_JOINABLE', 'このルームはすでに開始または終了しています。', 409);
  }

  // ── 5) 参加は RPC に委譲（満員・二重参加を原子的に制御） ──
  const { error: rpcErr } = await admin.rpc('career_gd_lobby_join', {
    p_room_id: roomId,
    p_user_id: userId,
    p_display_name: displayName,
  });

  if (rpcErr) {
    if (isDbNotReady(rpcErr)) return dbNotReadyResponse();
    if (isRoomFullError(rpcErr)) {
      return jsonError('ROOM_FULL', 'このルームは満員です。', 409);
    }
    if (isRoomNotJoinableError(rpcErr)) {
      // 事前チェック後に状態が変わった等。汎用の 409。
      return jsonError('ROOM_NOT_JOINABLE', 'このルームには参加できません。', 409);
    }
    console.error('Career GD lobby join: rpc error', rpcErr.message ?? rpcErr);
    return jsonError('JOIN_FAILED', '参加に失敗しました。時間をおいて再度お試しください。', 500);
  }

  // ── 6) 応答 ──
  const res: LobbyJoinResponse = {
    ok: true,
    roomId,
    redirectTo: lobbyRedirectTo(roomId),
  };
  return Response.json(res);
}

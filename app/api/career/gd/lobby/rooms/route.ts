// PASSAI 就活版 — GD 公開ロビー 一覧 API（STEP-GD-20-B）。
//
// GET /api/career/gd/lobby/rooms
//   - member ログイン必須。
//   - status='waiting' かつ room_type='public_lobby' かつ join_policy='public' の room を返す。
//   - 参加人数は「is_ai=false かつ left_at IS NULL の人間」だけ数える。
//   - 満員でない room を優先表示（isFull=true は末尾）。
//   - 秘密は返さない：host の user_id / email は出さず、hostDisplayName（表示名）のみ返す。
//
// 並び順の判断：
//   career_gd_rooms の updated_at 自動更新トリガは BEFORE UPDATE ON career_gd_rooms のみ。
//   member の join は career_gd_room_members への INSERT で、rooms 行を UPDATE しないため、
//   waiting 中の room では updated_at ≒ created_at になる。よって created_at desc（新しい順）を採用。

import { authenticateGdMember, getGdAdmin } from '@/app/api/career/gd/room/roomAuth';
import {
  PUBLIC_ROOM_TYPE,
  PUBLIC_JOIN_POLICY,
  LOBBY_LIST_LIMIT,
  isDbNotReady,
  dbNotReadyResponse,
  jsonError,
} from '@/lib/careerGd/publicLobby';
import type { GdFormat } from '@/types/careerGd';
import type { LobbyRoomSummary, LobbyRoomsResponse } from '@/lib/careerGd/publicLobbyTypes';

export const maxDuration = 30;

type Row = Record<string, unknown>;

function asFormat(v: unknown): GdFormat {
  return v === 'case' || v === 'abstract' ? v : 'free';
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// theme（jsonb）からタイトルだけを取り出す。旧 room / ランダムマッチ room は theme={} なので ''。
function themeTitle(v: unknown): string {
  if (!v || typeof v !== 'object') return '';
  return str((v as { title?: unknown }).title).trim().slice(0, 120);
}

export async function GET() {
  // ── 1) 認証（member 必須） ──
  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const userId = auth.userId;

  // ── 2) service-role ──
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // ── 3) 公開待機 room を取得（新しい順） ──
  const { data: roomRows, error: roomErr } = await admin
    .from('career_gd_rooms')
    .select('id, format, theme, time_limit_sec, planned_participant_count, host_user_id, created_at, updated_at')
    .eq('status', 'waiting')
    .eq('room_type', PUBLIC_ROOM_TYPE)
    .eq('join_policy', PUBLIC_JOIN_POLICY)
    .order('created_at', { ascending: false })
    .limit(LOBBY_LIST_LIMIT);

  if (roomErr) {
    if (isDbNotReady(roomErr)) return dbNotReadyResponse();
    console.error('Career GD lobby rooms: room list error', roomErr.message ?? roomErr);
    return jsonError('LOBBY_LIST_FAILED', '公開ルームの取得に失敗しました。', 500);
  }

  const rooms = (roomRows ?? []) as Row[];
  if (rooms.length === 0) {
    const empty: LobbyRoomsResponse = { ok: true, rooms: [] };
    return Response.json(empty);
  }

  // ── 4) 対象 room のメンバーを 1 クエリでまとめて取得 ──
  const roomIds = rooms.map((r) => str(r.id)).filter(Boolean);
  const { data: memberRows, error: memErr } = await admin
    .from('career_gd_room_members')
    .select('room_id, user_id, is_ai, is_host, left_at, display_name')
    .in('room_id', roomIds);

  if (memErr) {
    if (isDbNotReady(memErr)) return dbNotReadyResponse();
    console.error('Career GD lobby rooms: member list error', memErr.message ?? memErr);
    return jsonError('LOBBY_LIST_FAILED', '公開ルームの取得に失敗しました。', 500);
  }
  const members = (memberRows ?? []) as Row[];

  // room_id ごとに集計。
  const byRoom = new Map<string, Row[]>();
  for (const m of members) {
    const rid = str(m.room_id);
    if (!rid) continue;
    const arr = byRoom.get(rid) ?? [];
    arr.push(m);
    byRoom.set(rid, arr);
  }

  const summaries: LobbyRoomSummary[] = rooms.map((room) => {
    const roomId = str(room.id);
    const roomMembers = byRoom.get(roomId) ?? [];
    const humans = roomMembers.filter((m) => m.is_ai !== true && !m.left_at);
    const currentHumanCount = humans.length;
    const planned =
      typeof room.planned_participant_count === 'number' ? room.planned_participant_count : 4;
    const hostMember = roomMembers.find((m) => m.is_host === true);
    const isMine = str(room.host_user_id) === userId;
    const isJoined = roomMembers.some((m) => str(m.user_id) === userId && !m.left_at);

    return {
      roomId,
      format: asFormat(room.format),
      themeTitle: themeTitle(room.theme),
      timeLimitSec: typeof room.time_limit_sec === 'number' ? room.time_limit_sec : 900,
      plannedParticipantCount: planned,
      currentHumanCount,
      isFull: currentHumanCount >= planned,
      isMine,
      isJoined,
      hostDisplayName: str(hostMember?.display_name) || 'ホスト',
      createdAt: str(room.created_at),
      updatedAt: str(room.updated_at),
    };
  });

  // 満員でない room を優先（isFull=false を前に）。同カテゴリ内は created_at desc の元順を維持。
  summaries.sort((a, b) => Number(a.isFull) - Number(b.isFull));

  const res: LobbyRoomsResponse = { ok: true, rooms: summaries };
  return Response.json(res);
}

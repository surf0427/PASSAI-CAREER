// PASSAI 就活版 — GD 公開ロビー ルーム作成 API（STEP-GD-20-B）。
//
// POST /api/career/gd/lobby/create
//   - member ログイン必須（guest / 匿名は拒否）。
//   - career_gd_rooms を room_type='public_lobby' / join_policy='public' / status='waiting' で作成。
//   - join_code_hash は NOT NULL のため 'pub_' + roomId（非 hex）を 1 回の INSERT で入れる
//     （"pub_placeholder"→UPDATE 方式は waiting join_code_hash unique と競合しうるため採らない）。
//   - 作成者を career_gd_room_members に is_host=true で登録。
//   - 同一ホストが既に公開待機 room を持つ場合（STEP-GD-20-A の部分 unique index が発火）は、
//     新規作成せず既存 room を返して復帰させる（MVP：復帰できる方を採用）。
//
// 既存 room/create（合言葉 room）には一切触れない。DB 操作は service-role のみ。

import { randomUUID } from 'node:crypto';
import { authenticateGdMember, getGdAdmin, isUniqueViolation } from '@/app/api/career/gd/room/roomAuth';
import {
  PUBLIC_ROOM_TYPE,
  PUBLIC_JOIN_POLICY,
  buildPublicJoinCodeHash,
  lobbyRedirectTo,
  parseCreateInput,
  isDbNotReady,
  dbNotReadyResponse,
  jsonError,
} from '@/lib/careerGd/publicLobby';
import type { LobbyCreateResponse } from '@/lib/careerGd/publicLobbyTypes';
import { parseRoomThemeInput } from '@/lib/careerGd/roomThemeInput';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';

export const maxDuration = 30;

export async function POST(req: Request) {
  // ── 1) 入力 ──
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // body 省略も許容（全項目デフォルト）。
    body = {};
  }
  const parsed = parseCreateInput(body);
  if (!parsed.ok) return parsed.response;
  const { format, plannedParticipantCount, timeLimitSec, displayName } = parsed;

  // 修正1: 確定した GD テーマを作成時に保存（未確定は 400）。
  const themeInput = (body && typeof body === 'object' ? (body as { theme?: unknown }).theme : undefined);
  const themeParsed = parseRoomThemeInput(themeInput);
  if (!themeParsed.ok) {
    return jsonError('THEME_REQUIRED', themeParsed.reason, 400);
  }
  const theme = themeParsed.theme;

  // ── 2) 認証（member 必須） ──
  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const userId = auth.userId;

  // ── 2.5) rate limit（user 単位・DB/RPC 前に弾く。超過は 429） ──
  const limited = await enforceRateLimit(userId, CAREER_GD_RATE_LIMITS.lobbyCreate);
  if (limited) return limited;

  // ── 3) service-role ──
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // ── 4) room を作成（roomId を先に採番して pub_<roomId> を 1 回で入れる） ──
  const roomId = randomUUID();
  const nowIso = new Date().toISOString();

  const { error: roomErr } = await admin.from('career_gd_rooms').insert({
    id: roomId,
    host_user_id: userId,
    status: 'waiting',
    format,
    theme, // 修正1: 確定テーマを作成時に保存。
    time_limit_sec: timeLimitSec,
    planned_participant_count: plannedParticipantCount,
    join_code_hash: buildPublicJoinCodeHash(roomId),
    code_expires_at: nowIso, // 公開 room は合言葉参加させないため now 相当（掲載判定には使わない）。
    room_type: PUBLIC_ROOM_TYPE,
    join_policy: PUBLIC_JOIN_POLICY,
  });

  if (roomErr) {
    if (isDbNotReady(roomErr)) return dbNotReadyResponse();
    // 同一ホストの公開待機 room 乱立防止 index（career_gd_rooms_one_open_public_per_host）発火
    // → 新規作成せず既存 room へ復帰させる。
    if (isUniqueViolation(roomErr)) {
      const { data: existing, error: exErr } = await admin
        .from('career_gd_rooms')
        .select('id')
        .eq('host_user_id', userId)
        .eq('status', 'waiting')
        .eq('room_type', PUBLIC_ROOM_TYPE)
        .maybeSingle();
      if (!exErr && existing?.id) {
        const reusedId = existing.id as string;
        const res: LobbyCreateResponse = {
          ok: true,
          roomId: reusedId,
          redirectTo: lobbyRedirectTo(reusedId),
          reused: true,
        };
        return Response.json(res);
      }
      // 既存が引けない稀ケースは 409 で明示。
      return jsonError(
        'ALREADY_HAS_OPEN_PUBLIC_ROOM',
        '既に募集中の公開ルームがあります。そちらへ移動してください。',
        409,
      );
    }
    console.error('Career GD lobby create: insert room error', roomErr.message ?? roomErr);
    return jsonError('ROOM_CREATE_FAILED', 'ルームの作成に失敗しました。時間をおいて再度お試しください。', 500);
  }

  // ── 5) host member を insert（失敗時は room を後始末） ──
  const { error: memberErr } = await admin.from('career_gd_room_members').insert({
    room_id: roomId,
    user_id: userId,
    is_ai: false,
    is_host: true,
    participant_id: `gduser-${randomUUID()}`,
    display_name: displayName,
    role: 'member',
  });
  if (memberErr) {
    console.error('Career GD lobby create: insert host member error', memberErr.message);
    await admin.from('career_gd_rooms').delete().eq('id', roomId);
    return jsonError('ROOM_CREATE_FAILED', 'ルームの作成に失敗しました。時間をおいて再度お試しください。', 500);
  }

  // ── 6) 応答（合言葉は返さない） ──
  const res: LobbyCreateResponse = {
    ok: true,
    roomId,
    redirectTo: lobbyRedirectTo(roomId),
  };
  return Response.json(res);
}

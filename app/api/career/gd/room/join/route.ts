// PASSAI 就活版 — GD Phase2 マルチGD ルーム参加 API（STEP-GD-12）。
//
// POST /api/career/gd/room/join
//   - member ログイン必須（guest / 匿名は拒否）。
//   - joinCode を normalize（6 桁数字でなければ 400）。
//   - HMAC hash で waiting かつ未期限の room を検索（該当なしは 404・詳細は出さない）。
//   - 既参加なら冪等成功 / 満員(planned 到達)は 409 / 未参加なら member insert。
//   - service-role で DB 操作（クライアントは room 系テーブルを直接叩かない）。
//
// レート制限: 既存 checkServerRateLimit（IP ベース・in-memory・best-effort）を適用。
//   ※ 本番公開前に per-user / DB or KV ベースの join attempt 制限へ置き換えること
//     （docs/gd/gd_multi_post_apply_checklist.md 参照）。

import { randomUUID } from 'node:crypto';
import { checkServerRateLimit } from '@/lib/serverRateLimit';
import { normalizeJoinCode, isValidJoinCode, hashJoinCode } from '../roomCode';
import {
  authenticateGdMember,
  getGdAdmin,
  isUndefinedTable,
  isUniqueViolation,
  dbNotAppliedResponse,
} from '../roomAuth';
import { mapMemberRow } from '../roomMappers';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';

export const maxDuration = 30;

function jsonError(error: string, detail: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error, detail }, { status, headers });
}

function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return '参加者';
  const t = value.trim().slice(0, 40);
  return t || '参加者';
}

export async function POST(req: Request) {
  // ── 1) レート制限（総当り緩和・best-effort） ──
  const rl = checkServerRateLimit(req, {
    keyPrefix: 'career-gd-room-join',
    windowMs: 5 * 60 * 1000,
    maxRequests: 20,
  });
  if (!rl.allowed) {
    return jsonError('RATE_LIMITED', '試行が多すぎます。しばらくしてからもう一度お試しください。', 429, {
      'Retry-After': String(rl.retryAfterSec),
    });
  }

  // ── 2) 入力 ──
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('BAD_REQUEST', 'リクエストボディが不正です。', 400);
  }
  const b = (body && typeof body === 'object' ? body : {}) as {
    joinCode?: unknown;
    displayName?: unknown;
  };
  const code = normalizeJoinCode(b.joinCode);
  if (!isValidJoinCode(code)) {
    return jsonError('INVALID_CODE', '参加コードは6桁の数字で入力してください。', 400);
  }
  const displayName = sanitizeName(b.displayName);

  // ── 3) 認証（member 必須） ──
  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const userId = auth.userId;

  // ── 3.5) rate limit（user 単位・合言葉 join。既存 IP ベース制限に加えて user 単位を弾く） ──
  const limited = await enforceRateLimit(userId, CAREER_GD_RATE_LIMITS.inviteJoin);
  if (limited) return limited;

  // ── 4) hash & service-role ──
  const joinCodeHash = hashJoinCode(code);
  if (!joinCodeHash) {
    return jsonError('SERVER_DB_UNCONFIGURED', 'サーバの設定が未完了です。管理者にお問い合わせください。', 503);
  }
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // ── 5) waiting かつ未期限の room を検索 ──
  const nowIso = new Date().toISOString();
  const { data: roomRow, error: roomErr } = await admin
    .from('career_gd_rooms')
    .select('id, status, planned_participant_count, code_expires_at')
    .eq('join_code_hash', joinCodeHash)
    .eq('status', 'waiting')
    .gt('code_expires_at', nowIso)
    .maybeSingle();

  if (roomErr) {
    if (isUndefinedTable(roomErr)) return dbNotAppliedResponse();
    console.error('Career GD room join: room lookup error', roomErr.message);
    return jsonError('JOIN_FAILED', '参加に失敗しました。時間をおいて再度お試しください。', 500);
  }
  if (!roomRow) {
    // waiting でない / 期限切れ / 不一致をまとめて汎用メッセージにする（情報を出しすぎない）。
    return jsonError('ROOM_NOT_JOINABLE', '参加できるルームが見つかりません。コードと有効期限をご確認ください。', 404);
  }
  const roomId = roomRow.id as string;
  const plannedCount = (roomRow.planned_participant_count as number) ?? 4;
  const codeExpiresAt = (roomRow.code_expires_at as string) ?? '';

  // ── 6) 現在のメンバー取得 ──
  const loadMembers = async () => {
    const { data, error } = await admin
      .from('career_gd_room_members')
      .select('*')
      .eq('room_id', roomId)
      .order('joined_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as Record<string, unknown>[];
  };

  let memberRows: Record<string, unknown>[];
  try {
    memberRows = await loadMembers();
  } catch (e) {
    if (isUndefinedTable(e)) return dbNotAppliedResponse();
    console.error('Career GD room join: members lookup error', e);
    return jsonError('JOIN_FAILED', '参加に失敗しました。時間をおいて再度お試しください。', 500);
  }

  // 既参加 → 冪等成功。
  const existing = memberRows.find((m) => m.user_id === userId);
  if (existing) {
    return Response.json({
      roomId,
      status: 'waiting',
      joinedMember: mapMemberRow(existing),
      members: memberRows.map(mapMemberRow),
      codeExpiresAt,
    });
  }

  // 満員判定（人間メンバー数が planned に達していたら不可）。
  const humanCount = memberRows.filter((m) => m.is_ai !== true && !m.left_at).length;
  if (humanCount >= plannedCount) {
    return jsonError('ROOM_FULL', 'このルームは満員です。', 409);
  }

  // ── 7) member insert ──
  const participantId = `gduser-${randomUUID()}`;
  const { data: inserted, error: insErr } = await admin
    .from('career_gd_room_members')
    .insert({
      room_id: roomId,
      user_id: userId,
      is_ai: false,
      is_host: false,
      participant_id: participantId,
      display_name: displayName,
      role: 'member',
    })
    .select('*')
    .single();

  if (insErr) {
    if (isUndefinedTable(insErr)) return dbNotAppliedResponse();
    if (isUniqueViolation(insErr)) {
      // レース（同時 join）。既参加として冪等成功にする。
      const rows = await loadMembers().catch(() => memberRows);
      const mine = rows.find((m) => m.user_id === userId);
      if (mine) {
        return Response.json({
          roomId,
          status: 'waiting',
          joinedMember: mapMemberRow(mine),
          members: rows.map(mapMemberRow),
          codeExpiresAt,
        });
      }
    }
    console.error('Career GD room join: member insert error', insErr.message);
    return jsonError('JOIN_FAILED', '参加に失敗しました。時間をおいて再度お試しください。', 500);
  }

  const updated = await loadMembers().catch(() => [...memberRows, inserted as Record<string, unknown>]);
  return Response.json({
    roomId,
    status: 'waiting',
    joinedMember: mapMemberRow(inserted as Record<string, unknown>),
    members: updated.map(mapMemberRow),
    codeExpiresAt,
  });
}

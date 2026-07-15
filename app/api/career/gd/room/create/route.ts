// PASSAI 就活版 — GD Phase2 マルチGD ルーム作成 API（STEP-GD-11）。
//
// POST /api/career/gd/room/create
//   - member ログイン必須（guest / 匿名は拒否）。
//   - service-role クライアントで career_gd_rooms（waiting）＋ host member を insert。
//   - 6 桁数字コードを生成し、平文はレスポンスで 1 回だけ返す（DB には hash + salt のみ保存）。
//   - code_expires_at は作成から 30 分。
//   - DB 未適用（テーブル未作成）/ env 未設定時は分かりやすいエラーを返す。
//
// 本 STEP では create のみ（join / session / message / ai-turn / feedback は未実装）。

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabaseClient } from '@/lib/supabase/serverClient';
import { getServiceRoleSupabaseClient } from '@/lib/supabase/serviceRoleClient';
import { generateSixDigitJoinCode, hashJoinCode } from '../roomCode';
import { parseParticipantCount } from '@/lib/careerGd/participantCount';
import { parseRoomThemeInput } from '@/lib/careerGd/roomThemeInput';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';

export const maxDuration = 30;

const CODE_TTL_MS = 30 * 60 * 1000; // 30 分
const CODE_RETRY = 6; // 6 桁コード衝突時の再生成回数

const FORMATS = ['free', 'case', 'abstract'] as const;
type Fmt = (typeof FORMATS)[number];

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return 'ホスト';
  const t = value.trim().slice(0, 40);
  return t || 'ホスト';
}

// Postgres の「テーブル未作成」を検出（career_gd_multi_apply.sql 未適用）。
function isUndefinedTable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === '42P01' ||
    (typeof e.message === 'string' && /relation .* does not exist/i.test(e.message))
  );
}

// 一意制約違反（waiting 中の join_code_hash 重複）を検出。
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown };
  return e.code === '23505';
}

export async function POST(req: Request) {
  // ── 1) 入力 ──
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('BAD_REQUEST', 'リクエストボディが不正です。', 400);
  }
  const b = (body && typeof body === 'object' ? body : {}) as {
    format?: unknown;
    plannedParticipantCount?: unknown;
    timeLimitSec?: unknown;
    displayName?: unknown;
    theme?: unknown;
  };

  const format = FORMATS.includes(b.format as Fmt) ? (b.format as Fmt) : null;
  if (!format) {
    return jsonError('INVALID_FORMAT', '形式は free / case / abstract のいずれかにしてください。', 400);
  }
  // 参加人数は 4/6/8 のみ許可。未指定は既定 4、指定不正は 400（silently fallback しない）。
  const parsedCount = parseParticipantCount(b.plannedParticipantCount);
  if (!parsedCount.ok) {
    return jsonError('INVALID_COUNT', '参加人数は 4人・6人・8人 のいずれかにしてください。', 400);
  }
  const plannedParticipantCount = parsedCount.value;
  const timeLimitSec = Number(b.timeLimitSec);
  if (!Number.isFinite(timeLimitSec) || timeLimitSec < 300 || timeLimitSec > 1800) {
    return jsonError('INVALID_TIME', '制限時間は 300〜1800 秒にしてください。', 400);
  }
  const displayName = sanitizeName(b.displayName);

  // 修正1: 確定した GD テーマを作成時に保存する（part of the create wizard）。
  // 未確定は 400（テーマ未確定の部屋を作らない ＝ 待機部屋・GD開始へ進めない条件を満たす）。
  const themeParsed = parseRoomThemeInput(b.theme);
  if (!themeParsed.ok) {
    return jsonError('THEME_REQUIRED', themeParsed.reason, 400);
  }
  const theme = themeParsed.theme;

  // ── 2) 認証（member ログイン必須・guest/匿名は拒否） ──
  const authClient = await getServerSupabaseClient();
  if (!authClient) {
    // env（NEXT_PUBLIC_SUPABASE_URL / ANON_KEY）未設定。
    return jsonError('SUPABASE_UNAVAILABLE', 'サーバのデータベース設定が未完了です。時間をおいて再度お試しください。', 503);
  }
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) {
    return jsonError('LOGIN_REQUIRED', 'マルチGDルームの作成にはログインが必要です。', 401);
  }
  if (userData.user.is_anonymous) {
    return jsonError('MEMBER_REQUIRED', 'マルチGDはログイン（メール登録）済みのユーザーのみ作成できます。', 403);
  }
  const userId = userData.user.id;

  // ── 2.5) rate limit（user 単位・合言葉 create。超過は 429） ──
  const limited = await enforceRateLimit(userId, CAREER_GD_RATE_LIMITS.inviteCreate);
  if (limited) return limited;

  // ── 3) service-role クライアント（未設定なら分かりやすく失敗） ──
  let admin: SupabaseClient;
  try {
    admin = getServiceRoleSupabaseClient();
  } catch {
    // SUPABASE_SERVICE_ROLE_KEY 未設定など。実値はログにも出さない。
    return jsonError('SERVER_DB_UNCONFIGURED', 'サーバのデータベース設定が未完了です。管理者にお問い合わせください。', 503);
  }

  const now = Date.now();
  const codeExpiresAt = new Date(now + CODE_TTL_MS).toISOString();

  // ── 4) room を insert（6 桁コード衝突時は再生成してリトライ） ──
  // join_code_hash は HMAC(code, pepper) の deterministic 値。同じ 6 桁は同じ hash になるため、
  // waiting 中の UNIQUE(join_code_hash) が平文コードの重複を正しく防ぐ。
  let roomId: string | null = null;
  let joinCode = '';
  for (let attempt = 0; attempt < CODE_RETRY; attempt++) {
    const code = generateSixDigitJoinCode();
    const joinCodeHash = hashJoinCode(code);
    if (!joinCodeHash) {
      // pepper（CAREER_GD_JOIN_CODE_PEPPER / service-role key）未設定。
      return jsonError('SERVER_DB_UNCONFIGURED', 'サーバの設定が未完了です。管理者にお問い合わせください。', 503);
    }

    const { data, error } = await admin
      .from('career_gd_rooms')
      .insert({
        host_user_id: userId,
        status: 'waiting',
        format,
        theme, // 修正1: 確定テーマを作成時に保存（start 時の自動生成上書きは start route 側で抑止）。
        time_limit_sec: Math.round(timeLimitSec),
        planned_participant_count: plannedParticipantCount,
        join_code_hash: joinCodeHash,
        code_expires_at: codeExpiresAt,
      })
      .select('id')
      .single();

    if (!error && data) {
      roomId = data.id as string;
      joinCode = code;
      break;
    }
    if (isUndefinedTable(error)) {
      console.error('Career GD room create: table missing (apply career_gd_multi_apply.sql)');
      return jsonError('DB_NOT_APPLIED', 'マルチGDの準備が完了していません（DB 未適用）。しばらくお待ちください。', 503);
    }
    if (isUniqueViolation(error)) {
      // waiting 中の join_code_hash 衝突 → コード再生成でリトライ。
      continue;
    }
    console.error('Career GD room create: insert room error', error?.message ?? error);
    return jsonError('ROOM_CREATE_FAILED', 'ルームの作成に失敗しました。時間をおいて再度お試しください。', 500);
  }

  if (!roomId) {
    return jsonError('CODE_COLLISION', '参加コードの発行に失敗しました。もう一度お試しください。', 503);
  }

  // ── 5) host member を insert（失敗時は room を後始末して失敗を返す） ──
  const hostParticipantId = `gdhost-${randomUUID()}`;
  const { error: memberErr } = await admin.from('career_gd_room_members').insert({
    room_id: roomId,
    user_id: userId,
    is_ai: false,
    is_host: true,
    participant_id: hostParticipantId,
    display_name: displayName,
    role: 'member', // 開始時に assignRoles で再割当（STEP-GD-13）
  });
  if (memberErr) {
    console.error('Career GD room create: insert host member error', memberErr.message);
    // 作成した room を掃除（best-effort）。
    await admin.from('career_gd_rooms').delete().eq('id', roomId);
    return jsonError('ROOM_CREATE_FAILED', 'ルームの作成に失敗しました。時間をおいて再度お試しください。', 500);
  }

  // ── 6) 応答（平文 joinCode はここでのみ返す） ──
  return Response.json({
    roomId,
    joinCode,
    codeExpiresAt,
    status: 'waiting',
    format,
    plannedParticipantCount,
    timeLimitSec: Math.round(timeLimitSec),
  });
}

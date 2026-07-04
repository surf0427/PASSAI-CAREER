// PASSAI 就活版 — GD 完全ランダムマッチ 参加 API（STEP-GD-21）。
//
// POST /api/career/gd/match/enter
//   入力: { plannedCount: 4 | 6 | 8 }
//   - member ログイン必須。p_user_id は必ず認証済み user id を使う（body の userId は受け取らない）。
//   - 4/6/8 以外は 400 INVALID_COUNT（未指定も 400。ランダムマッチは人数選択が前提）。
//   - rate limit 対象（超過は 429）。
//   - 競合制御は RPC career_gd_match_enter に委譲（advisory lock + FOR UPDATE SKIP LOCKED）。
//       * 既に waiting なら再利用、既に matched なら roomId を返す（冪等）。
//       * 同人数が定員に達する／最小人間数＋待機時間を満たすと room を作成し matched を返す。
//   出力:
//     matched → { ok:true, status:'matched', roomId, redirectTo }
//     waiting → { ok:true, status:'waiting', queueId, plannedCount, waitingCount }
//
// 既存 room/create・lobby/create には一切触れない。DB 操作は service-role のみ。

import { authenticateGdMember, getGdAdmin } from '@/app/api/career/gd/room/roomAuth';
import {
  isCareerGdParticipantCount,
  type CareerGdParticipantCount,
} from '@/lib/careerGd/participantCount';
import {
  isDbNotReady,
  dbNotReadyResponse,
  isInvalidCountError,
  matchRedirectTo,
  matchWaitOverrideSec,
  jsonError,
} from '@/lib/careerGd/matchQueue';
import type { MatchEnterResponse } from '@/lib/careerGd/matchQueueTypes';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';

export const maxDuration = 30;

export async function POST(req: Request) {
  // ── 1) 入力（plannedCount は必須・4/6/8 のみ） ──
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const raw = (body && typeof body === 'object' ? body : {}) as { plannedCount?: unknown };
  const n = typeof raw.plannedCount === 'number' ? raw.plannedCount : Number(raw.plannedCount);
  if (!isCareerGdParticipantCount(n)) {
    return jsonError('INVALID_COUNT', '参加人数は 4人・6人・8人 のいずれかを選んでください。', 400);
  }
  const plannedCount: CareerGdParticipantCount = n;

  // ── 2) 認証（member 必須） ──
  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const userId = auth.userId;

  // ── 2.5) rate limit（user 単位・RPC 前に弾く。超過は 429） ──
  const limited = await enforceRateLimit(userId, CAREER_GD_RATE_LIMITS.matchEnter);
  if (limited) return limited;

  // ── 3) service-role ──
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // ── 4) enter RPC（キュー投入＋マッチング試行） ──
  const { data, error } = await admin.rpc('career_gd_match_enter', {
    p_user_id: userId,
    p_planned_count: plannedCount,
    p_min_wait_sec: matchWaitOverrideSec(),
    p_min_humans: 2,
  });

  if (error) {
    if (isDbNotReady(error)) return dbNotReadyResponse();
    if (isInvalidCountError(error)) {
      return jsonError('INVALID_COUNT', '参加人数は 4人・6人・8人 のいずれかを選んでください。', 400);
    }
    console.error('Career GD match enter: rpc error', error.message ?? error);
    return jsonError('MATCH_ENTER_FAILED', 'マッチングの受付に失敗しました。時間をおいて再度お試しください。', 500);
  }

  const result = (data ?? {}) as {
    status?: string;
    room_id?: string;
    queue_id?: string;
    planned_count?: number;
    waiting_count?: number;
  };

  if (result.status === 'matched' && result.room_id) {
    const res: MatchEnterResponse = {
      ok: true,
      status: 'matched',
      roomId: result.room_id,
      redirectTo: matchRedirectTo(result.room_id),
    };
    return Response.json(res);
  }

  const res: MatchEnterResponse = {
    ok: true,
    status: 'waiting',
    queueId: String(result.queue_id ?? ''),
    plannedCount,
    waitingCount: typeof result.waiting_count === 'number' ? result.waiting_count : 0,
  };
  return Response.json(res);
}

// PASSAI 就活版 — GD 完全ランダムマッチ 取消 API（STEP-GD-21）。
//
// POST /api/career/gd/match/cancel
//   - member ログイン必須。自分の waiting キュー行を cancelled にする。
//   - matched 後（room 成立済み）の cancel は対象外＝何も取り消さず ok を返す（room へ移動済み扱い）。
//   - rate limit 対象（超過は 429）。
//   出力: { ok:true, cancelled: number }
//
// DB 操作は service-role のみ。p_user_id は必ず認証済み user id（body から受け取らない）。

import { authenticateGdMember, getGdAdmin } from '@/app/api/career/gd/room/roomAuth';
import {
  isDbNotReady,
  dbNotReadyResponse,
  jsonError,
} from '@/lib/careerGd/matchQueue';
import type { MatchCancelResponse } from '@/lib/careerGd/matchQueueTypes';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';

export const maxDuration = 30;

export async function POST() {
  // ── 1) 認証（member 必須） ──
  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const userId = auth.userId;

  // ── 1.5) rate limit ──
  const limited = await enforceRateLimit(userId, CAREER_GD_RATE_LIMITS.matchCancel);
  if (limited) return limited;

  // ── 2) service-role ──
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // ── 3) cancel RPC ──
  const { data, error } = await admin.rpc('career_gd_match_cancel', { p_user_id: userId });
  if (error) {
    if (isDbNotReady(error)) return dbNotReadyResponse();
    console.error('Career GD match cancel: rpc error', error.message ?? error);
    return jsonError('MATCH_CANCEL_FAILED', 'キャンセルに失敗しました。時間をおいて再度お試しください。', 500);
  }

  const result = (data ?? {}) as { cancelled?: number };
  const res: MatchCancelResponse = {
    ok: true,
    cancelled: typeof result.cancelled === 'number' ? result.cancelled : 0,
  };
  return Response.json(res);
}

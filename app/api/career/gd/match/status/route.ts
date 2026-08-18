// PASSAI 就活版 — GD 完全ランダムマッチ 状態取得 API（STEP-GD-21）。
//
// GET /api/career/gd/match/status
//   - member ログイン必須。自分の最新キュー行の状態を返す。
//   - waiting のときは（新規 enter が無くても）マッチング試行を回すため、polling で成立に収束する。
//   - rate limit は create/join より緩め（5 秒 polling 前提）。超過は 429。
//   出力:
//     matched   → { ok:true, status:'matched', roomId, redirectTo }
//     waiting   → { ok:true, status:'waiting', queueId, plannedCount, waitingCount }
//     cancelled → { ok:true, status:'cancelled' }
//     expired   → { ok:true, status:'expired' }
//     none      → { ok:true, status:'none' }（キュー行が無い）
//
// DB 操作は service-role のみ。秘密（user_id / email / join_code_hash）は返さない。

import { authenticateGdMember, getGdAdmin } from '@/app/api/career/gd/room/roomAuth';
import {
  isDbNotReady,
  dbNotReadyResponse,
  matchRedirectTo,
  matchWaitOverrideSec,
  jsonError,
} from '@/lib/careerGd/matchQueue';
import type { MatchStatusResponse } from '@/lib/careerGd/matchQueueTypes';
import type { CareerGdParticipantCount } from '@/lib/careerGd/participantCount';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';
import { requireCareerGdEnabled } from '@/lib/careerGdGate/flags.server';

export const maxDuration = 30;

export async function GET() {
  // ── STEP-GD-31: GD kill switch（server flag が最終権限）──
  //    OFF なら body parse / auth / DB / AI へ到達する前に 404。UI flag は権限に影響しない。
  const gdGate = requireCareerGdEnabled();
  if (gdGate) return gdGate;

  // ── 1) 認証（member 必須） ──
  const auth = await authenticateGdMember();
  if (auth.kind === 'reject') return auth.response;
  const userId = auth.userId;

  // ── 1.5) rate limit（polling 用に緩め・超過は 429） ──
  const limited = await enforceRateLimit(userId, CAREER_GD_RATE_LIMITS.matchStatus);
  if (limited) return limited;

  // ── 2) service-role ──
  const adminRes = getGdAdmin();
  if (adminRes.kind === 'reject') return adminRes.response;
  const admin = adminRes.admin;

  // ── 3) poll RPC（状態取得＋waiting なら成立試行）。戻り値は camelCase。 ──
  const { data, error } = await admin.rpc('career_gd_match_poll', {
    p_user_id: userId,
    p_wait_override_sec: matchWaitOverrideSec(),
  });

  if (error) {
    if (isDbNotReady(error)) return dbNotReadyResponse();
    console.error('Career GD match status: rpc error', error.message ?? error);
    return jsonError('MATCH_STATUS_FAILED', 'マッチング状況の取得に失敗しました。', 500);
  }

  const result = (data ?? { status: 'none' }) as {
    status?: string;
    roomId?: string;
    queueId?: string;
    plannedCount?: number;
    waitingCount?: number;
  };

  if (result.status === 'matched' && result.roomId) {
    const res: MatchStatusResponse = {
      ok: true,
      status: 'matched',
      roomId: result.roomId,
      redirectTo: matchRedirectTo(result.roomId),
    };
    return Response.json(res);
  }
  if (result.status === 'waiting') {
    const res: MatchStatusResponse = {
      ok: true,
      status: 'waiting',
      queueId: String(result.queueId ?? ''),
      plannedCount: (result.plannedCount as CareerGdParticipantCount) ?? 4,
      waitingCount: typeof result.waitingCount === 'number' ? result.waitingCount : 0,
    };
    return Response.json(res);
  }
  if (result.status === 'cancelled') {
    return Response.json({ ok: true, status: 'cancelled' } satisfies MatchStatusResponse);
  }
  if (result.status === 'expired') {
    return Response.json({ ok: true, status: 'expired' } satisfies MatchStatusResponse);
  }
  return Response.json({ ok: true, status: 'none' } satisfies MatchStatusResponse);
}

/**
 * PASSAI 就活版 — GD 参加者間音声の ICE サーバ配布（STEP-GD-VOICE-TURN）。
 *
 * GET /api/career/gd/voice/ice → { iceServers, ttlSec, turnConfigured }
 *
 * ★ この route が存在する理由は **TURN credential を client bundle に置かないため**。
 *   `NEXT_PUBLIC_*` は静的配信物へ inline されるので、そこへ TURN 認証情報を入れると
 *   認証も rate limit も掛からない状態で誰でも取り出せてしまう。
 *   ここは member 認証 + rate limit の内側で、短命 credential だけを返す。
 *
 * ★ 返すのは ICE サーバ設定と可否だけ。env 名・provider 名・secret・provider 応答本文は返さない。
 * ★ TURN 未設定 / provider 障害でも 200 を返す（STUN のみ + turnConfigured=false）。
 *   ここで 5xx にすると Solo GD まで巻き添えで止まりうるが、Solo は TURN を必要としない。
 *   呼び出し側は turnConfigured=false を UI へ出して「無言の劣化」を避ける。
 *
 * 応答:
 *   200 { iceServers, ttlSec, turnConfigured }
 *   401/403 … 未ログイン / 非 member
 *   404 … GD kill switch OFF
 *   429 … rate limit
 */

import 'server-only';

import { requireCareerGdEnabled } from '@/lib/careerGdGate/flags.server';
import { resolveCareerRequestIdentity } from '@/lib/careerApi/requestGuard';
import { loginRequiredResponse } from '@/lib/careerBilling/entitlement';
import { enforceRateLimit, CAREER_GD_RATE_LIMITS } from '@/lib/rateLimit';
import { issueGdIceServers } from '@/lib/careerGd/turnCredentials.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET() {
  // ① GD kill switch（server flag が最終権限）。OFF なら auth / provider へ到達する前に 404。
  const gdGate = requireCareerGdEnabled();
  if (gdGate) return gdGate;

  // ② member 必須。未ログイン・匿名には ICE 構成も credential も渡さない。
  const identity = await resolveCareerRequestIdentity();
  if (identity.kind !== 'member') return loginRequiredResponse();

  // ③ 無制限の credential mint 口にしない（provider 側 quota の防衛も兼ねる）。
  //    ★ provider 呼び出しより前に置く。429 ならここで返るので Cloudflare コールは 0 回。
  const limited = await enforceRateLimit(identity.userId, CAREER_GD_RATE_LIMITS.ice);
  if (limited) return limited;

  const issue = await issueGdIceServers();

  // ④ credential を CDN / browser cache に残さない。
  return Response.json(
    {
      iceServers: issue.iceServers,
      ttlSec: issue.ttlSec,
      turnConfigured: issue.turnConfigured,
    },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}

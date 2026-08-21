/**
 * PASSAI CAREER — 契約状態の読み取り API。
 *
 * GET /api/career/billing/status
 *
 * 200 {
 *   paid: boolean,                        // ★ 権利の正本（server 導出）。単一プランなので tier は無い
 *   subscription: { plan, status, currentPeriodEnd, cancelAtPeriodEnd } | null
 * }
 * 401 / 403 / 503 は resolveCareerEntitlement の reject をそのまま返す。
 *
 * 用途:
 *   - マイページの契約カード（CareerBillingCard）
 *   - Checkout success ページのポーリング（AGENTS §26）
 *     「success URL に到達したこと」ではなく、**webhook が同期した DB の state** を
 *     見て初めて「契約済み」と表示するための経路。この route は client の主張を
 *     一切受け取らず、server session だけで判定する。
 *
 * 返さないもの: stripe_customer_id / stripe_subscription_id / Stripe raw payload。
 *   client が知る必要が無く、漏らす利点も無い（Portal は server 側で customer を解決する）。
 */

import 'server-only';

import { resolveCareerEntitlement } from '@/lib/careerBilling/entitlement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const result = await resolveCareerEntitlement();
  if (result.kind === 'reject') return result.response;

  const { entitlement } = result;
  const latest = entitlement.snapshot.latest;

  return Response.json(
    {
      paid: entitlement.paid,
      subscription: latest
        ? {
            plan: latest.plan,
            status: latest.status,
            currentPeriodEnd: latest.current_period_end,
            cancelAtPeriodEnd: latest.cancel_at_period_end === true,
          }
        : null,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}

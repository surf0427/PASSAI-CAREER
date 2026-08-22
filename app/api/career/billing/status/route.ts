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
 *
 * ★ e2eDiscount（一時的な検証用フィールド）:
 *   「呼び出し元自身が E2E 割引の対象か」を 'apply' | 'misconfigured' | 'none' で返すだけ。
 *   coupon ID / price / 金額など**値は一切返さない**。Checkout Session を作らずに
 *   E2E env が deployment に効いているかを確認するための診断であり、
 *   これが無いと確認のたびに不要な LIVE Checkout Session が 1 件ずつ増える。
 *   E2E 完了後に本フィールドごと削除してよい。
 */

import 'server-only';

import { resolveCareerEntitlement } from '@/lib/careerBilling/entitlement';
import { resolveCareerE2eDiscountFromEnv } from '@/lib/careerBilling/e2eDiscount';

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
      // 検証用: 自分が E2E 割引の対象か（種別のみ・値は返さない）。
      e2eDiscount: resolveCareerE2eDiscountFromEnv({
        userId: entitlement.userId,
        email: entitlement.email,
      }).kind,
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

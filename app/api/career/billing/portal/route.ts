/**
 * PASSAI CAREER — Stripe Billing Portal Session 作成 API。
 *
 * POST /api/career/billing/portal   （body 不要）
 *
 * レスポンス:
 *   200 { url }                          → client が window.location で遷移
 *   400 { error: 'NO_CUSTOMER' }         → 未契約 / webhook 未着（Customer 未確定）
 *   401 / 403                            → 未ログイン / member でない
 *   429 rate limited
 *   502 { error: 'STRIPE_ERROR' }
 *   503 { error: 'SUPABASE_UNAVAILABLE' | 'BILLING_NOT_PROVISIONED' | ... }
 *
 * ── security 契約（AGENTS §16 / §33）────────────────────────────────────
 *   - **body を一切読まない**。customerId を client から受け取る経路が存在しないため、
 *     他人の Portal を開かせる余地が構造的に無い。
 *   - customer は「server session の userId → career_billing_customers」だけで解決する。
 *
 * Portal からユーザーができること（Stripe Dashboard 側の Portal 設定に従う）:
 *   支払い方法の更新 / 請求書・領収書の取得 / 解約・再開 / 請求先情報の編集。
 */

import 'server-only';

import { CAREER_BILLING_RATE_LIMITS, enforceRateLimit } from '@/lib/rateLimit';
import {
  authenticateCareerMember,
  getCareerBillingAdmin,
} from '@/lib/careerBilling/entitlement';
import { loadCareerStripeCustomerId } from '@/lib/careerBilling/customer';
import { getStripeClient } from '@/lib/careerBilling/stripe';
import { resolveCareerAppOrigin } from '@/lib/careerBilling/origin';
import { logCareerStripeFailure } from '@/lib/careerBilling/stripeLog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

export async function POST(req: Request) {
  const auth = await authenticateCareerMember();
  if (auth.kind === 'reject') return auth.response;
  const { userId } = auth;

  const limited = await enforceRateLimit(
    `career_billing_portal:${userId}`,
    CAREER_BILLING_RATE_LIMITS.portal,
  );
  if (limited) return limited;

  const adminResult = getCareerBillingAdmin();
  if (adminResult.kind === 'reject') return adminResult.response;

  const mapping = await loadCareerStripeCustomerId(adminResult.admin, userId);
  if (mapping.kind === 'db-error') {
    // table 未適用と本当の DB 障害を分けて伝える（どちらも権利は与えない）。
    return jsonError(
      'BILLING_NOT_PROVISIONED',
      '課金機能がまだ利用できません。管理者にお問い合わせください。',
      503,
    );
  }
  if (!mapping.customerId) {
    return jsonError(
      'NO_CUSTOMER',
      'ご契約情報が見つかりませんでした。お申し込み直後の場合は少し待ってから再度お試しください。',
      400,
    );
  }

  const origin = resolveCareerAppOrigin(req);
  if (!origin) {
    return jsonError('ORIGIN_UNRESOLVED', 'サーバ設定が未完了です。', 503);
  }

  try {
    const session = await getStripeClient().billingPortal.sessions.create({
      customer: mapping.customerId,
      return_url: `${origin}/career/mypage`,
    });
    if (!session.url) {
      return jsonError('STRIPE_ERROR', '請求情報ページを開けませんでした。', 502);
    }
    return Response.json({ url: session.url }, { status: 200 });
  } catch (err) {
    logCareerStripeFailure('billingPortal.sessions.create', err);
    return jsonError(
      'STRIPE_ERROR',
      '請求情報ページを開けませんでした。時間をおいて再度お試しください。',
      502,
    );
  }
}

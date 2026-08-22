/**
 * PASSAI CAREER — Stripe Checkout Session 作成 API。
 *
 * POST /api/career/billing/checkout
 *   body: なし（読まない）
 *
 * レスポンス:
 *   200 { url }                                → client が window.location で遷移
 *   400 { error: 'EMAIL_REQUIRED' }
 *   401 { error: 'LOGIN_REQUIRED' }
 *   403 { error: 'MEMBER_REQUIRED' }
 *   409 { error: 'ALREADY_SUBSCRIBED' }        → 既契約。client は Portal へ誘導する
 *   429 rate limited
 *   503 { error: 'BILLING_UNCONFIGURED' | 'SUPABASE_UNAVAILABLE' | ... }
 *
 * ── security 契約（AGENTS §14 / §30）────────────────────────────────────
 *   - **body を一切読まない**。plan / priceId / userId / customerId / email を
 *     client から受け取る経路は存在しない（送られても構造上使いようが無い）。
 *   - CAREER は単一の有料プラン。priceId は server が env（STRIPE_CAREER_PRICE_ID）
 *     からのみ解決する。任意の Stripe Price ID も plan 選択も client に許さない。
 *   - identity は server session（Project B cookie）が唯一の正本。
 *   - **割引を server が付与する経路は存在しない**。coupon / discount を当てるコードは
 *     持たない（LIVE E2E 用の一時的な割引機構は検証完了後に撤去済み）。
 *     一般顧客が Stripe Checkout 上で入力する Promotion Code
 *     （allow_promotion_codes）は Stripe 側の通常機能であり、これとは別物。
 *   - Customer は career_billing_customers の 1:1 mapping から解決（重複契約防止）。
 *
 * ── 受験版との差分 ────────────────────────────────────────────────────
 *   - 受験版は customer 未確定時に `customer_email` を渡して Stripe に自動生成させるが、
 *     CAREER は必ず canonical Customer を先に確定させてから `customer` を渡す
 *     （lib/careerBilling/customer.ts の設計注記参照）。
 *   - 受験版に無い「既に有効な契約がある場合は 409」を追加（AGENTS §15）。
 */

import 'server-only';

import type Stripe from 'stripe';

import { devWarn } from '@/lib/devLog';
import { CAREER_BILLING_RATE_LIMITS, enforceRateLimit } from '@/lib/rateLimit';
import {
  authenticateCareerMember,
  getCareerBillingAdmin,
  getCareerSubscriptionState,
} from '@/lib/careerBilling/entitlement';
import { getOrCreateCareerStripeCustomer } from '@/lib/careerBilling/customer';
import {
  getStripeClient,
  isCareerBillingConfigured,
  retrieveCareerPrice,
} from '@/lib/careerBilling/stripe';
import { CAREER_METADATA_USER_ID_KEY } from '@/lib/careerBilling/subscription';
import { resolveCareerAppOrigin } from '@/lib/careerBilling/origin';
import { logCareerStripeFailure } from '@/lib/careerBilling/stripeLog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// server-only route のため client 用 validator は import せず簡易判定を inline する
// （受験版 checkout route と同方針）。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isEmailLike(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 254 &&
    EMAIL_RE.test(value)
  );
}

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

export async function POST(req: Request) {
  // ── 1) 認証（server session が唯一の identity）──
  //    ★ body は読まない。単一プランなので client が選ぶものは何も無い。
  const auth = await authenticateCareerMember();
  if (auth.kind === 'reject') return auth.response;
  const { userId } = auth;

  const limited = await enforceRateLimit(
    `career_billing_checkout:${userId}`,
    CAREER_BILLING_RATE_LIMITS.checkout,
  );
  if (limited) return limited;

  if (!isEmailLike(auth.email)) {
    // member なら email を持つはずの異常系。Stripe Customer が email を持てないので弾く。
    return jsonError(
      'EMAIL_REQUIRED',
      'ご契約にはメールアドレスの登録が必要です。メールでログインし直してください。',
      400,
    );
  }
  const email = auth.email;

  // ── 2) 課金設定の存在確認（fail-closed。未設定なら売らない）──
  if (!isCareerBillingConfigured()) {
    return jsonError(
      'BILLING_UNCONFIGURED',
      'ただいまお申し込みを受け付けていません。',
      503,
    );
  }

  const adminResult = getCareerBillingAdmin();
  if (adminResult.kind === 'reject') return adminResult.response;
  const { admin } = adminResult;

  // ── 3) 二重契約の防止（AGENTS §15）──
  //    既に権利が立っているユーザーには新しい Checkout を作らせず、Portal へ送る。
  const state = await getCareerSubscriptionState({ admin, userId });
  if (state.kind === 'not-provisioned') {
    return jsonError(
      'BILLING_NOT_PROVISIONED',
      '課金機能がまだ利用できません。管理者にお問い合わせください。',
      503,
    );
  }
  if (state.kind === 'db-error') {
    return jsonError(
      'ENTITLEMENT_CHECK_FAILED',
      '契約状態を確認できませんでした。時間をおいて再度お試しください。',
      503,
    );
  }
  if (state.snapshot.paid) {
    return Response.json(
      {
        error: 'ALREADY_SUBSCRIBED',
        detail: '既にご契約中です。お支払い方法の変更・解約は「契約を管理」から行えます。',
      },
      { status: 409 },
    );
  }

  // ── 4) canonical Stripe Customer（1 account : 1 customer）──
  const customer = await getOrCreateCareerStripeCustomer({ admin, userId, email });
  if (customer.kind === 'db-error') {
    return jsonError(
      'CUSTOMER_MAPPING_FAILED',
      'お客様情報を準備できませんでした。時間をおいて再度お試しください。',
      503,
    );
  }
  if (customer.kind === 'stripe-error') {
    return jsonError(
      'STRIPE_ERROR',
      'お支払い手続きを開始できませんでした。時間をおいて再度お試しください。',
      502,
    );
  }

  // ── 5) URL / Price（server が env から解決する単一 Price）──
  const origin = resolveCareerAppOrigin(req);
  if (!origin) {
    return jsonError('ORIGIN_UNRESOLVED', 'サーバ設定が未完了です。', 503);
  }

  // Price は Stripe から実物を引き、**実行環境の test/live と一致すること**まで
  // 確認してから使う。未設定・不在・モード混線はいずれも「売らない」に倒す
  // （fail-closed。取り違えた Price で課金を作らせない）。
  const priceCheck = await retrieveCareerPrice();
  if (priceCheck.kind !== 'ok') {
    // 原因は server ログにのみ残す。client には理由を出し分けない
    // （env の設定状況を外から推測させない）。
    devWarn('[career/billing/checkout] price unusable', { reason: priceCheck.kind });
    return jsonError(
      'BILLING_UNCONFIGURED',
      'ただいまお申し込みを受け付けていません。',
      503,
    );
  }
  if (!priceCheck.price.active) {
    devWarn('[career/billing/checkout] price is archived');
    return jsonError(
      'BILLING_UNCONFIGURED',
      'ただいまお申し込みを受け付けていません。',
      503,
    );
  }
  const priceId = priceCheck.price.id;

  // ── 6) Checkout Session ──
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    customer: customer.customerId,
    success_url: `${origin}/career/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/career/billing/cancel`,
    client_reference_id: userId,
    subscription_data: {
      // webhook（syncCareerSubscriptionFromStripe）が読む正規キー。
      metadata: { [CAREER_METADATA_USER_ID_KEY]: userId },
    },
    metadata: { [CAREER_METADATA_USER_ID_KEY]: userId, app: 'passai-career' },
    // 一般顧客向けの Promotion Code 入力欄（Stripe の通常機能）。
    // ★ server 側から discounts / coupon を付ける分岐は持たない。金額は常に
    //   canonical Price のみで決まり、割引は顧客が Stripe 画面で入力した場合だけ。
    allow_promotion_codes: true,
  };

  try {
    const session = await getStripeClient().checkout.sessions.create(params);
    if (!session.url) {
      return jsonError('STRIPE_ERROR', 'お支払いページを開けませんでした。', 502);
    }
    return Response.json({ url: session.url }, { status: 200 });
  } catch (err) {
    // Stripe の raw message はそのまま返さない（内部情報の露出を避ける）。
    logCareerStripeFailure('checkout.sessions.create', err);
    return jsonError(
      'STRIPE_ERROR',
      'お支払い手続きを開始できませんでした。時間をおいて再度お試しください。',
      502,
    );
  }
}

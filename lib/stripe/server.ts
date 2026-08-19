/**
 * STEP-BILLING-02: Stripe SDK 初期化境界（server-only）。
 *
 * - `STRIPE_SECRET_KEY` は server-only secret。`import 'server-only'` で
 *   client bundle に紛れ込んだら build error にする。
 * - **環境ごとの key モードガード**: 判定は `lib/stripe/environment.ts` に集約:
 *     - `VERCEL_ENV=production`  → `sk_live_*` のみ
 *     - `VERCEL_ENV=preview`     → `sk_test_*` のみ（Vercel Preview は NODE_ENV=production
 *                                   になるため、旧 NODE_ENV 判定では Test 検証ができなかった）
 *     - `VERCEL_ENV=development` → `sk_test_*` のみ
 *     - VERCEL_ENV 未設定        → NODE_ENV=production なら live、それ以外は test
 *   本番に test key、Preview / 開発に live key が紛れ込む取り違えを利用時に弾く。
 * - Singleton。re-init コストを避けるため module-scope cache。
 * - apiVersion は SDK 同梱版を明示 pin（2026-05-27.dahlia / stripe v22）。SDK
 *   upgrade 時はここを変更して挙動差分を意識的にレビューする。
 * - `getStripePriceId(plan)` は `STRIPE_PRICE_ID_*` env を解決する server-only
 *   helper。`lib/billing/plans.ts` は pure constants のみで env を読まない。
 */

import 'server-only';

import Stripe from 'stripe';

import { PLANS, PLAN_IDS, type PlanId } from '@/lib/billing/plans';
import { checkStripeSecretKeyMode } from './environment';

/**
 * Stripe SDK 同梱版に合わせて明示 pin。SDK upgrade 時はここを更新し、
 * 挙動差分を意識的にレビューする。型は SDK 内 `LatestApiVersion` で narrow
 * されるため、不一致なら build error。
 */
const STRIPE_API_VERSION = '2026-05-27.dahlia';

function readStripeSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  // モード判定は environment.ts の唯一のポリシーに委譲する（VERCEL_ENV 優先）。
  // 失敗メッセージに key の実値・部分文字列は含まれない。
  const check = checkStripeSecretKeyMode(key, {
    VERCEL_ENV: process.env.VERCEL_ENV,
    NODE_ENV: process.env.NODE_ENV,
  });
  if (!check.ok) {
    throw new Error(check.message);
  }
  return key as string;
}

let cachedClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (cachedClient) return cachedClient;
  cachedClient = new Stripe(readStripeSecretKey(), {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    appInfo: {
      name: 'paid-app',
    },
  });
  return cachedClient;
}

export function getStripePriceId(plan: PlanId): string {
  const envName = PLANS[plan].stripePriceIdEnvName;
  const value = process.env[envName];
  if (!value) {
    throw new Error(`${envName} is not set`);
  }
  if (!value.startsWith('price_')) {
    throw new Error(
      `${envName} must be a Stripe Price ID (starts with "price_")`,
    );
  }
  return value;
}

/**
 * 逆引き: Stripe Price ID → 自アプリの PlanId。
 * webhook が受け取った subscription.items[0].price.id をプラン名に正規化する用途。
 * 未知の price_id（env が壊れている / 別商品が混入）なら null を返し、呼び出し側で
 * "permanent failure" として記録する判断に使う。
 */
export function getPlanFromPriceId(priceId: string): PlanId | null {
  for (const plan of PLAN_IDS) {
    const envName = PLANS[plan].stripePriceIdEnvName;
    if (process.env[envName] === priceId) return plan;
  }
  return null;
}

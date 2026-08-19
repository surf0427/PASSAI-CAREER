/**
 * PASSAI CAREER — Stripe の CAREER 側境界（server-only）。
 *
 * 受験版 `lib/stripe/server.ts` との関係:
 *   - **Stripe SDK の初期化は再実装しない**。`getStripeClient()` をそのまま再利用する。
 *     STRIPE_SECRET_KEY は 1 アカウント 1 本の共有 secret であり、NODE_ENV による
 *     live/test key モードガードと apiVersion pin も受験版実装が既に持っているため、
 *     二重実装は取り違えの温床にしかならない（AGENTS §0-3: 既存を壊さず再利用）。
 *   - **Price ID の解決だけを CAREER 専用に分ける**。受験版 `getStripePriceId` /
 *     `getPlanFromPriceId` は STRIPE_PRICE_ID_{BASIC,PREMIUM}（受験版 Product）を見るため、
 *     CAREER が使うと別プロダクトを売ってしまう。
 *
 * 秘密の取り扱い:
 *   - `import 'server-only'` で client bundle への混入を build error にする。
 *   - Price ID / secret の実値はログにも例外 message にも出さない（env 名だけ出す）。
 */

import 'server-only';

import type Stripe from 'stripe';

import { getStripeClient } from '@/lib/stripe/server';
import {
  CAREER_PAID_PLAN_IDS,
  CAREER_PLANS,
  type CareerPaidPlanId,
} from './plans';

export { getStripeClient };

/**
 * 受験版の Price env 名。CAREER の Price env にこれらと同じ値が入っていたら
 * 「受験版 Product を CAREER で売る」誤設定なので弾く（AGENTS §10）。
 */
const EXAM_PRICE_ENV_NAMES = [
  'STRIPE_PRICE_ID_BASIC',
  'STRIPE_PRICE_ID_PREMIUM',
] as const;

function readCareerPriceEnv(plan: CareerPaidPlanId): string | null {
  const envName = CAREER_PLANS[plan].stripePriceIdEnvName;
  const value = process.env[envName];
  if (!value) return null;
  if (!value.startsWith('price_')) {
    throw new Error(
      `${envName} must be a Stripe Price ID (starts with "price_")`,
    );
  }
  // 受験版 Price との取り違え検知。実値は出さない。
  for (const examEnv of EXAM_PRICE_ENV_NAMES) {
    if (process.env[examEnv] && process.env[examEnv] === value) {
      throw new Error(
        `${envName} must not reuse the exam-app price configured in ${examEnv}. ` +
          'CAREER requires its own Stripe Product/Price.',
      );
    }
  }
  return value;
}

/**
 * CAREER plan → Stripe Price ID。未設定なら throw（fail-closed。
 * 「env が無いから free で通す / 適当な price で売る」は絶対にしない）。
 */
export function getCareerStripePriceId(plan: CareerPaidPlanId): string {
  const value = readCareerPriceEnv(plan);
  if (!value) {
    throw new Error(`${CAREER_PLANS[plan].stripePriceIdEnvName} is not set`);
  }
  return value;
}

/**
 * 逆引き: Stripe Price ID → CAREER PlanId。
 *
 * webhook が受け取った subscription.items[0].price.id を CAREER のプラン名に正規化する。
 * **CAREER の env にしかマッチしない**ため、同一 Stripe アカウントの受験版 subscription が
 * 誤って CAREER webhook に届いても null（= unknown-plan → permanent error, DB 書き込み無し）
 * になる。プロダクト間の状態混線に対する最後の砦。
 */
export function getCareerPlanFromPriceId(
  priceId: string,
): CareerPaidPlanId | null {
  for (const plan of CAREER_PAID_PLAN_IDS) {
    let configured: string | null = null;
    try {
      configured = readCareerPriceEnv(plan);
    } catch {
      // 形式不正 / 受験版との衝突は「未設定」と同じく一致なし扱い（fail-closed）。
      configured = null;
    }
    if (configured && configured === priceId) return plan;
  }
  return null;
}

/** その plan が販売可能に設定されているか（Price env が正しく入っているか）。 */
export function isCareerPlanConfigured(plan: CareerPaidPlanId): boolean {
  try {
    return readCareerPriceEnv(plan) !== null;
  } catch {
    return false;
  }
}

/** CAREER 課金が 1 つでも販売可能か。false なら課金 UI を出さない（fail-closed）。 */
export function isCareerBillingConfigured(): boolean {
  if (!process.env.STRIPE_SECRET_KEY) return false;
  return CAREER_PAID_PLAN_IDS.some((plan) => isCareerPlanConfigured(plan));
}

/**
 * 販売可能な plan を Stripe から実データ付きで取得する。
 *
 * **価格と訴求文言を repo 側に持たないための経路**。CAREER の料金仕様（金額・
 * 有料対象機能）は repo のどこにも存在しないため（LP に料金セクション無し / docs に
 * 価格記載無し）、それらを実装側で創作しない。代わりに:
 *   - 金額 / 通貨 / 請求間隔 → Stripe **Price**
 *   - 商品名 / 提供内容の説明 → Stripe **Product**（運用者が Dashboard で記述したもの）
 * を正本として読む。取得に失敗した plan は一覧から落とす
 * （壊れた価格・名前の無い商品を売らない = fail-closed）。
 */
export type CareerPlanOffer = {
  plan: CareerPaidPlanId;
  /** repo 側の plan key ラベル（'Basic' / 'Premium'）。 */
  label: string;
  /** Stripe Product.name。運用者が Dashboard で決めた商品名。 */
  productName: string | null;
  /** Stripe Product.description。提供内容の説明もこちらが正本。 */
  productDescription: string | null;
  /** 最小通貨単位（JPY なら円）。Stripe Price.unit_amount。 */
  unitAmount: number | null;
  currency: string;
  /** 'month' | 'year' など。one-time price なら null。 */
  interval: string | null;
  intervalCount: number | null;
};

export async function listCareerPlanOffers(): Promise<CareerPlanOffer[]> {
  const stripe = getStripeClient();
  const offers: CareerPlanOffer[] = [];

  for (const plan of CAREER_PAID_PLAN_IDS) {
    let priceId: string;
    try {
      priceId = getCareerStripePriceId(plan);
    } catch {
      continue; // 未設定 / 不正 → 販売しない
    }

    let price: Stripe.Price;
    try {
      // product を expand して商品名・説明も取得する（下の注記参照）。
      price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    } catch {
      continue; // Stripe 側に無い / 権限違い → 販売しない
    }
    if (!price.active) continue;

    // Stripe Product は expand 済みなら object、失敗時は id 文字列 or 削除済み。
    const product =
      typeof price.product === 'object' && !price.product.deleted
        ? price.product
        : null;

    offers.push({
      plan,
      label: CAREER_PLANS[plan].label,
      productName: product?.name ?? null,
      productDescription: product?.description ?? null,
      unitAmount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring?.interval ?? null,
      intervalCount: price.recurring?.interval_count ?? null,
    });
  }

  return offers;
}

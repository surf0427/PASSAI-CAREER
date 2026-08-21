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
 * ★ CAREER は **単一の有料プラン**。Checkout に使う Price は
 *   `CAREER_PRICE_ENV_NAME`（= STRIPE_CAREER_PRICE_ID）ただ 1 つから解決する。
 *   候補を順に探す fallback は持たない。client は Price も plan も選べない
 *   （Price authority は完全に server 側）。
 *
 * 秘密の取り扱い:
 *   - `import 'server-only'` で client bundle への混入を build error にする。
 *   - Price ID / secret の実値はログにも例外 message にも出さない（env 名だけ出す）。
 */

import 'server-only';

import type Stripe from 'stripe';

import { devWarn } from '@/lib/devLog';
import { logCareerStripeFailure } from './stripeLog';
import { getStripeClient } from '@/lib/stripe/server';
import {
  currentExpectedStripeLivemode,
  currentStripeRuntimeEnv,
} from '@/lib/stripe/environment';
import {
  CAREER_PRICE_ENV_NAME,
  CAREER_PLAN_LABEL,
  CAREER_SUBSCRIPTION_PLAN_WRITE_VALUE,
  type CareerSubscriptionPlanValue,
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

/**
 * CAREER の Price ID を env から読む（**唯一の入口**）。
 *
 * 未設定 / 形式不正 / 受験版 Price との衝突はすべて null（= 売らない）。
 * ★ 他の env へ fallback しない。ここで null になったら課金導線ごと出さない。
 */
function readCareerPriceEnv(): string | null {
  const value = process.env[CAREER_PRICE_ENV_NAME];
  if (!value) return null;
  if (!value.startsWith('price_')) {
    devWarn('[careerBilling/stripe] career price env is not a Stripe Price ID', {
      envName: CAREER_PRICE_ENV_NAME,
    });
    return null;
  }
  // 受験版 Price との取り違え検知。実値は出さない。
  for (const examEnv of EXAM_PRICE_ENV_NAMES) {
    if (process.env[examEnv] && process.env[examEnv] === value) {
      devWarn('[careerBilling/stripe] career price reuses the exam-app price', {
        envName: CAREER_PRICE_ENV_NAME,
        collidesWith: examEnv,
      });
      return null;
    }
  }
  return value;
}

export type CareerConfiguredPrice = {
  envName: typeof CAREER_PRICE_ENV_NAME;
  priceId: string;
  /** career_subscriptions.plan に書く既存許容値（DDL CHECK を変えないため）。 */
  planValue: CareerSubscriptionPlanValue;
};

/** 新規 Checkout に使う canonical price。未設定なら null（= 売らない）。 */
export function getCareerCanonicalPrice(): CareerConfiguredPrice | null {
  const priceId = readCareerPriceEnv();
  if (!priceId) return null;
  return {
    envName: CAREER_PRICE_ENV_NAME,
    priceId,
    planValue: CAREER_SUBSCRIPTION_PLAN_WRITE_VALUE,
  };
}

/**
 * 逆引き: Stripe Price ID → career_subscriptions.plan に書く値。
 *
 * webhook が受け取った subscription.items[0].price.id を CAREER の契約として
 * 認識できるかを判定する。**CAREER の env にしかマッチしない**ため、同一 Stripe
 * アカウントの受験版 subscription が誤って CAREER webhook に届いても null
 * （= unknown-plan → permanent error, DB 書き込み無し）になる。
 *
 * ★ 既に DB にある過去 row（plan='basic' / 'premium'）の **読み取り**互換は
 *   entitlementPolicy 側で担保されている（status だけで権利を判定する）。
 *   本関数は「新しく届いた Stripe event を CAREER のものと認めるか」だけを見る。
 */
export function resolveCareerPlanValueFromPriceId(
  priceId: string,
): CareerSubscriptionPlanValue | null {
  const configured = getCareerCanonicalPrice();
  return configured && configured.priceId === priceId ? configured.planValue : null;
}

/** CAREER 課金が販売可能に設定されているか。false なら課金 UI を出さない（fail-closed）。 */
export function isCareerBillingConfigured(): boolean {
  if (!process.env.STRIPE_SECRET_KEY) return false;
  return getCareerCanonicalPrice() !== null;
}

/**
 * Stripe Price を取得し、**実行環境の期待モードと一致するか**を検証して返す。
 *
 * Secret key のモードは environment.ts が env で固定しているが、Price ID 側は
 * 別 env なので取り違えが独立に起こり得る:
 *   例) Vercel Preview に test key を入れたまま、Price だけ live のものを貼ってしまう。
 * その場合 Stripe は "No such price" を返すため原因が分かりにくい。ここで
 * `price.livemode`（Stripe が返す真の所属モード）を明示的に突き合わせ、
 * test/live 混線として **はっきり失敗**させる。fail-closed（曖昧なら売らない）。
 */
export type CareerPriceCheck =
  | { kind: 'ok'; price: Stripe.Price }
  | { kind: 'unconfigured' }
  | { kind: 'not-found' }
  | { kind: 'mode-mismatch'; expectedLivemode: boolean; actualLivemode: boolean };

export async function retrieveCareerPrice(): Promise<CareerPriceCheck> {
  const configured = getCareerCanonicalPrice();
  if (!configured) {
    // env 名だけをログに出す（実値は出さない）。fallback はしない。
    devWarn('[careerBilling/stripe] career price env unusable', {
      envName: CAREER_PRICE_ENV_NAME,
    });
    return { kind: 'unconfigured' };
  }

  let price: Stripe.Price;
  try {
    // product を expand して商品名・説明も同時に取得する。
    price = await getStripeClient().prices.retrieve(configured.priceId, {
      expand: ['product'],
    });
  } catch (err) {
    // ★ 空 catch だと「Price ID 不正」と「API key の権限不足 / 通信障害」が
    //   区別できず 'not-found' に潰れる。戻り値は変えずに診断だけ残す。
    logCareerStripeFailure('prices.retrieve', err);
    return { kind: 'not-found' };
  }

  const expectedLivemode = currentExpectedStripeLivemode();
  if (price.livemode !== expectedLivemode) {
    devWarn('[careerBilling/stripe] price livemode mismatch', {
      envName: configured.envName,
      runtimeEnv: currentStripeRuntimeEnv(),
      expectedLivemode,
      actualLivemode: price.livemode,
    });
    return {
      kind: 'mode-mismatch',
      expectedLivemode,
      actualLivemode: price.livemode,
    };
  }

  return { kind: 'ok', price };
}

/**
 * 販売中の単一プランを Stripe から実データ付きで取得する。
 *
 * **価格と訴求文言を repo 側に持たないための経路**:
 *   - 金額 / 通貨 / 請求間隔 → Stripe **Price**
 *   - 商品名 / 提供内容の説明 → Stripe **Product**（運用者が Dashboard で記述したもの）
 * 取得に失敗 / archived なら null（壊れた価格・名前の無い商品を売らない = fail-closed）。
 */
export type CareerPlanOffer = {
  /** UI 表示名（Stripe Product.name が無いときの代替）。 */
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

export async function getCareerPlanOffer(): Promise<CareerPlanOffer | null> {
  const checked = await retrieveCareerPrice();
  if (checked.kind !== 'ok') return null;
  const price = checked.price;
  if (!price.active) return null;

  // Stripe Product は expand 済みなら object、失敗時は id 文字列 or 削除済み。
  const product =
    typeof price.product === 'object' && !price.product.deleted ? price.product : null;

  return {
    label: CAREER_PLAN_LABEL,
    productName: product?.name ?? null,
    productDescription: product?.description ?? null,
    unitAmount: price.unit_amount,
    currency: price.currency,
    interval: price.recurring?.interval ?? null,
    intervalCount: price.recurring?.interval_count ?? null,
  };
}

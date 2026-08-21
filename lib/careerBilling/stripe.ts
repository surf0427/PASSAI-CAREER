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
 *   `CAREER_PRICE_ENV_NAMES` を先頭から探して最初に見つかった 1 本だけであり、
 *   client は Price も plan も選べない（Price authority は完全に server 側）。
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
  CAREER_PRICE_ENV_NAMES,
  CAREER_PRICE_ENV_TO_PLAN_VALUE,
  CAREER_PLAN_LABEL,
  type CareerPriceEnvName,
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

function readCareerPriceEnv(envName: CareerPriceEnvName): string | null {
  const value = process.env[envName];
  if (!value) return null;
  if (!value.startsWith('price_')) {
    throw new Error(`${envName} must be a Stripe Price ID (starts with "price_")`);
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

export type CareerConfiguredPrice = {
  envName: CareerPriceEnvName;
  priceId: string;
  /** career_subscriptions.plan に書く既存許容値（DDL CHECK を変えないため）。 */
  planValue: CareerSubscriptionPlanValue;
};

/**
 * 設定済みの CAREER Price をすべて返す（**優先順**）。
 *
 * 先頭が Checkout に使う canonical price。2 つ目以降は
 * 「旧 Price で作られた subscription を CAREER の契約として認識する」ための
 * legacy read compatibility にだけ使う（新規販売には使わない）。
 */
export function listConfiguredCareerPrices(): CareerConfiguredPrice[] {
  const out: CareerConfiguredPrice[] = [];
  for (const envName of CAREER_PRICE_ENV_NAMES) {
    let value: string | null = null;
    try {
      value = readCareerPriceEnv(envName);
    } catch {
      // 形式不正 / 受験版との衝突は「未設定」と同じ扱い（fail-closed）。
      value = null;
    }
    if (!value) continue;
    // 同じ Price を両方の env に入れてある場合は 1 本として扱う。
    if (out.some((p) => p.priceId === value)) continue;
    out.push({
      envName,
      priceId: value,
      planValue: CAREER_PRICE_ENV_TO_PLAN_VALUE[envName],
    });
  }
  return out;
}

/** 新規 Checkout に使う canonical price。未設定なら null（= 売らない）。 */
export function getCareerCanonicalPrice(): CareerConfiguredPrice | null {
  return listConfiguredCareerPrices()[0] ?? null;
}

/**
 * 逆引き: Stripe Price ID → career_subscriptions.plan に書く値。
 *
 * webhook が受け取った subscription.items[0].price.id を CAREER の契約として
 * 認識できるかを判定する。**CAREER の env にしかマッチしない**ため、同一 Stripe
 * アカウントの受験版 subscription が誤って CAREER webhook に届いても null
 * （= unknown-plan → permanent error, DB 書き込み無し）になる。
 */
export function resolveCareerPlanValueFromPriceId(
  priceId: string,
): CareerSubscriptionPlanValue | null {
  return listConfiguredCareerPrices().find((p) => p.priceId === priceId)?.planValue ?? null;
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
    devWarn('[careerBilling/stripe] career price env unusable');
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

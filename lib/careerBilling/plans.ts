/**
 * PASSAI CAREER — 課金プランのカタログ（pure constants / client + server 双方から import 可）。
 *
 * ★ 商品モデルは **単一の有料プラン**（PASSAI CAREER）だけ。
 *   以前の basic / premium という 2 段階 tier は廃止した。runtime に tier 判定は無く、
 *   判断すべきことは「有効な契約があるか / 無いか」だけである。
 *   将来のためという理由で tier 抽象（FREE / PRO / ENTERPRISE 等）を再導入しないこと。
 *
 * ★ 金額（priceJpy）は本ファイルに持たない。
 *   金額 / 通貨 / 請求間隔は Stripe Price、商品名 / 説明は Stripe Product が正本。
 *   実 Price ID は server-only helper（lib/careerBilling/stripe.ts）だけが env から解決する。
 *
 * ★ env 名は受験版（STRIPE_PRICE_ID_BASIC / _PREMIUM）と必ず別名にする。
 *   同一 Stripe アカウント上で受験版 Price と CAREER Price が混線しないための境界。
 */

/**
 * CAREER の Stripe Price ID env 名（**正本・ただ 1 つ**）。
 *
 * ★ 候補を複数持って順に探す実装にしない。単一プランなので Price も 1 本であり、
 *   「どれかが入っていれば動く」は設定ミスを隠すだけで利点が無い。
 * ★ 受験版（STRIPE_PRICE_ID_BASIC / _PREMIUM）は別プロダクトの env。
 *   fallback も再利用も禁止（lib/careerBilling/stripe.ts が誤設定を検知する）。
 */
export const CAREER_PRICE_ENV_NAME = 'STRIPE_CAREER_PRICE_ID' as const;

export type CareerPriceEnvName = typeof CAREER_PRICE_ENV_NAME;

/** UI 表示名（Stripe Product.name が取れないときの代替）。 */
export const CAREER_PLAN_LABEL = 'PASSAI CAREER';

/**
 * `career_subscriptions.plan` として **読める**値（historical compatibility）。
 *
 * ★ DB の CHECK 制約（`plan IN ('basic','premium')`）は **変更しない**。
 *   単一プラン化のために migration を足すのは割に合わない。過去に basic / premium
 *   プランで作られた行はそのまま有効な CAREER 契約として読める。
 * ★ runtime の権利判定はこの値を一切見ない（entitlementPolicy.ts は status だけで判断）。
 */
export const CAREER_SUBSCRIPTION_PLAN_VALUES = ['basic', 'premium'] as const;
export type CareerSubscriptionPlanValue =
  (typeof CAREER_SUBSCRIPTION_PLAN_VALUES)[number];

/**
 * 新しい subscription を **書き込む**ときの plan 値。
 *
 * 単一プランなので tier の概念は無く、この値に意味は無い。DDL の CHECK が
 * 許す既存値を 1 つ固定で使い、DB migration を不要にするためだけの定数。
 */
export const CAREER_SUBSCRIPTION_PLAN_WRITE_VALUE: CareerSubscriptionPlanValue = 'basic';

/** career_subscriptions に入りうる既知の plan 値か（未知の値は権利に数えない）。 */
export function isCareerSubscriptionPlanValue(
  value: unknown,
): value is CareerSubscriptionPlanValue {
  return (
    typeof value === 'string' &&
    (CAREER_SUBSCRIPTION_PLAN_VALUES as readonly string[]).includes(value)
  );
}

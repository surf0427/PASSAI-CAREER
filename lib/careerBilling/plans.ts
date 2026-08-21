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
 * CAREER 単一プランの Price ID env 名（**優先順**）。
 *
 * ★ 新しい env 名を発明しない。ここに並ぶ 2 つはいずれも本 repo が以前から使っている
 *   CAREER 専用の env 名であり、単一プラン化にあたって「運用側がどちらの変数名に
 *   単一 Price を入れたか」を repo からは断定できないため、**先頭から順に探して
 *   最初に見つかったものを canonical price として扱う**。
 *
 * ★ 副次効果として、旧 premium Price で作られた subscription も
 *   「CAREER の契約」として認識できる（legacy read compatibility）。
 *   ただし **新規 Checkout は常に先頭で解決した 1 本の Price しか使わない**ので、
 *   商品としては単一プランである。
 */
export const CAREER_PRICE_ENV_NAMES = [
  'STRIPE_PRICE_ID_CAREER_BASIC',
  'STRIPE_PRICE_ID_CAREER_PREMIUM',
] as const;

export type CareerPriceEnvName = (typeof CAREER_PRICE_ENV_NAMES)[number];

/** UI 表示名（Stripe Product.name が取れないときの代替）。 */
export const CAREER_PLAN_LABEL = 'PASSAI CAREER';

/**
 * `career_subscriptions.plan` に書き込む値。
 *
 * ★ DB の CHECK 制約（`plan IN ('basic','premium')`）は **変更しない**。
 *   単一プラン化のために migration を足すのは割に合わないため、どの env で解決した
 *   Price かに応じて既存の許容値をそのまま書く。runtime の権利判定はこの値を
 *   一切見ない（entitlementPolicy.ts は status だけで判断する）。
 *   過去行（plan='basic' / 'premium'）もそのまま有効な CAREER 契約として読める。
 */
export const CAREER_SUBSCRIPTION_PLAN_VALUES = ['basic', 'premium'] as const;
export type CareerSubscriptionPlanValue =
  (typeof CAREER_SUBSCRIPTION_PLAN_VALUES)[number];

/** env 名 → DB へ書く plan 値。 */
export const CAREER_PRICE_ENV_TO_PLAN_VALUE: Readonly<
  Record<CareerPriceEnvName, CareerSubscriptionPlanValue>
> = {
  STRIPE_PRICE_ID_CAREER_BASIC: 'basic',
  STRIPE_PRICE_ID_CAREER_PREMIUM: 'premium',
};

/** career_subscriptions に入りうる既知の plan 値か（未知の値は権利に数えない）。 */
export function isCareerSubscriptionPlanValue(
  value: unknown,
): value is CareerSubscriptionPlanValue {
  return (
    typeof value === 'string' &&
    (CAREER_SUBSCRIPTION_PLAN_VALUES as readonly string[]).includes(value)
  );
}

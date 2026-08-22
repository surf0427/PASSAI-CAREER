/**
 * PASSAI CAREER — 公開 Pricing の **表示用コピー**（UI 専用の定数）。
 *
 * ★★ ここは「表示」であって「課金の権威」ではない ★★
 *
 *   UI 上の料金表示      … 本ファイル（新規ユーザーに商品を説明するための文言）
 *   Stripe 課金の権威    … STRIPE_CAREER_PRICE_ID → server → Stripe Price
 *
 *   Checkout Session の金額は **必ず** server が env から解決した Stripe Price で決まる
 *   （app/api/career/billing/checkout/route.ts）。本ファイルの値が checkout に流れる経路は
 *   存在せず、client がここを書き換えても課金額は 1 円も変わらない。
 *
 * なぜ表示用の定数を持つのか（受験版との整合）:
 *   受験版は `lib/billing/plans.ts` の pure constant `priceJpy: 2980` を PricingSection が
 *   そのまま描画しており、Stripe env の有無に関わらず購入前 UI が必ず出る。CAREER も
 *   同じ思想に揃える。Preview / 開発環境のように `STRIPE_CAREER_PRICE_ID` が無い環境でも
 *   「PASSAI CAREER / ¥3,000 / 月」という商品説明は表示されなければならない
 *   （料金ページごと消えると新規ユーザーには「サービスが存在しない」ように見える）。
 *   一方 Checkout の実行時は server が Stripe 設定を検査し、未設定なら fail-closed。
 *
 * ★ 置き場所について: 受験版は billing catalog（plans.ts）に金額を同居させているが、
 *   CAREER の `lib/careerBilling/plans.ts` は「金額を持たない」ことを QA で固定している
 *   （課金の正本は Stripe だけ、という不変条件）。そのため表示用コピーは billing module
 *   ではなく Pricing ページ配下に置き、server billing から import されない場所に隔離する。
 */

/** 表示用の月額（Stripe Price が読めない環境でのフォールバック表示）。 */
export const CAREER_PRICING_DISPLAY_AMOUNT = '¥3,000';

/** 表示用の請求間隔ラベル。 */
export const CAREER_PRICING_DISPLAY_INTERVAL = '/ 月';

/** Pricing ページに出す商品名（Stripe Product.name が取れればそちらを優先）。 */
export const CAREER_PRICING_PRODUCT_NAME = 'PASSAI CAREER';

/** 1 行の要約説明。 */
export const CAREER_PRICING_SUMMARY =
  '自己分析から面接・ES・GDまで、PASSAI CAREERのすべての機能をご利用いただけます。';

/** 単一の有料プランで使える機能。 */
export const CAREER_PRICING_FEATURES = [
  '自己分析',
  '企業分析',
  'ES',
  '面接',
  'プレゼン',
  'GD',
  '企業マッチング',
] as const;

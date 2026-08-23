/**
 * PASSAI CAREER — 公開商品表示（価格・プラン構成）の **単一の真実**（pure constants）。
 *
 * ★★ ここは「公開ページに何と書くか」であって「課金の権威」ではない ★★
 *
 *   公開表示（LP / FAQ / 特商法）… 本ファイル
 *   Stripe 課金の権威             … STRIPE_CAREER_PRICE_ID → server → Stripe Price
 *
 *   Checkout Session の金額は **必ず** server が env から解決した Stripe Price で決まる
 *   （app/api/career/billing/checkout/route.ts は body を読まない）。本ファイルの値が
 *   checkout に流れる経路は存在せず、ここを書き換えても課金額は 1 円も変わらない。
 *
 * ── なぜ独立した module なのか ────────────────────────────────────────
 *   特定商取引法に基づく表記（/legal/commerce）は **法定表示**であり、
 *   「いま販売している役務の価格」と一致していなければならない。
 *   以前ここは `lib/legal.ts` 経由で受験版 `lib/billing/plans.ts`（Basic ¥2,980 /
 *   Premium ¥4,980）を参照しており、CAREER を売っているのに受験版の価格を
 *   法定表示していた。同じ事故を再発させないため、CAREER の公開価格は
 *   **受験版 catalog に一切依存しない**本ファイルだけを正本とする。
 *
 * ★ 受験版（lib/billing/plans.ts / PLANS / priceJpy）を import しないこと。
 * ★ env を読まない・Stripe に触らない・server-only にしない
 *   （法務ページ・LP FAQ の双方から import するため pure である必要がある）。
 *
 * ── 表示の分担 ────────────────────────────────────────────────────────
 *   本ファイル                              … LP FAQ / 特商法（文章中の価格表記）
 *   app/career/pricing/pricingDisplay.ts    … 料金プランページのカード表示専用
 *   料金ページ側は Stripe Price が読めればその実値を優先する構造のため表示定数を
 *   自前で持つ。金額を変えるときは **両方**を同じ値に更新すること。
 */

/** 月額（税込・日本円）。CAREER は単一の有料プランのみ。 */
export const CAREER_PUBLIC_PRICE_JPY = 3000;

/** 有料プランの数。単一プランであることを文章側から参照するための定数。 */
export const CAREER_PUBLIC_PLAN_COUNT = 1;

/** 公開ページに出す商品名。 */
export const CAREER_PUBLIC_PRODUCT_NAME = 'PASSAI CAREER';

/** 3 桁区切りの金額（例: '3,000'）。以下のラベルはすべてこれから組み立てる。 */
const GROUPED_AMOUNT = CAREER_PUBLIC_PRICE_JPY.toLocaleString('ja-JP');

/** 文章中で使う税込月額表記（例: '月額3,000円（税込）'）。 */
export const CAREER_PUBLIC_MONTHLY_PRICE_LABEL = `月額${GROUPED_AMOUNT}円（税込）`;

/** 特商法「販売価格」欄の 1 行表記。単一プランなので tier の併記はしない。 */
export const CAREER_PUBLIC_SALES_PRICE_LABEL = `${CAREER_PUBLIC_PRODUCT_NAME} ${CAREER_PUBLIC_MONTHLY_PRICE_LABEL}／単一プラン`;

/**
 * 特商法「サービス内容」欄。
 *
 * ★ feature flag で停止しうる機能（GD / 企業マッチング）を **確定的に提供すると書かない**。
 *   法定表示は「必ず提供されるもの」だけを列挙し、残りは「等」で受ける。
 *   （flag の値そのものは運用判断であり、本ファイルは flag を読まない。）
 */
export const CAREER_PUBLIC_SERVICE_DESCRIPTION =
  '新卒就職活動を支援する生成AIサービス「PASSAI CAREER」（自己分析・企業分析・エントリーシート作成支援・面接練習・プレゼン対策・就活相談 等）';

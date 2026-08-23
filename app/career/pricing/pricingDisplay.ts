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

import type { CareerDailyQuotaFeature } from '@/lib/careerQuota/limits';

/** 表示用の月額（Stripe Price が読めない環境でのフォールバック表示）。 */
export const CAREER_PRICING_DISPLAY_AMOUNT = '¥3,000';

/** 表示用の請求間隔ラベル。 */
export const CAREER_PRICING_DISPLAY_INTERVAL = '/ 月';

/** Pricing ページに出す商品名（Stripe Product.name が取れればそちらを優先）。 */
export const CAREER_PRICING_PRODUCT_NAME = 'PASSAI CAREER';

/**
 * 1 行の要約説明。
 *
 * ★ feature flag で停止しうる機能（GD / 企業マッチング）を名指ししない。
 *   flag OFF の環境で「GDまで使える」と書くと、購入者に存在しない機能を約束することになる
 *   （旧文言は「自己分析から面接・ES・GDまで、…すべての機能」だった）。
 *   常時提供の機能だけを例示し、実際の提供範囲は下の feature 一覧が flag から導出する。
 */
export const CAREER_PRICING_SUMMARY =
  '自己分析・企業分析・ES・面接など、PASSAI CAREERのAI機能をご利用いただけます。';

// ── 提供機能カタログ ────────────────────────────────────────────────
//
// STEP-CAREER-PUBLIC-SPEC。
//
// ★ ここは「販売時に約束しうる機能の全集合」であって「今この環境で使える機能」ではない。
//   実際に Pricing へ出す集合は selectAvailableCareerPricingFeatures() が
//   feature flag から導出する。flag OFF の機能は **一覧ごと出さない**
//   （「準備中」等の曖昧な marketing copy で残さない ＝ 提供しない機能を匂わせない）。
//
// ★ 各 entry は quota bucket の key を持つ。Pricing の利用上限表示は必ずこの key 経由で
//   lib/careerQuota/limits.ts から引くので、UI ラベルと内部 anchor の取り違えが起きない
//   （例:「ES」→ es → 10 / 「面接」→ interview → 8）。上限値をここに複製しない。

/** flag で提供可否が変わる機能の gate 種別。null は常時提供。 */
export type CareerPricingFeatureGate = 'gd' | 'matching' | null;

export type CareerPricingFeature = {
  /** Pricing に出す表示名。 */
  label: string;
  /** 1 日の利用上限を引くための quota bucket key（lib/careerQuota/limits.ts）。 */
  quota: CareerDailyQuotaFeature;
  /** 提供可否を決める feature flag。null なら常時提供。 */
  gate: CareerPricingFeatureGate;
};

/** 単一の有料プランで使える機能（全集合）。 */
export const CAREER_PRICING_FEATURES: readonly CareerPricingFeature[] = [
  { label: '自己分析', quota: 'self_analysis', gate: null },
  { label: '企業分析', quota: 'company_research', gate: null },
  { label: 'ES', quota: 'es', gate: null },
  { label: '面接', quota: 'interview', gate: null },
  { label: 'プレゼン', quota: 'presentation', gate: null },
  { label: 'GD', quota: 'gd', gate: 'gd' },
  { label: '企業マッチング', quota: 'matching', gate: 'matching' },
];

/** 現在の環境で提供可能な機能だけを返す（純関数 / server flag の値を受け取るだけ）。 */
export function selectAvailableCareerPricingFeatures(enabled: {
  gd: boolean;
  matching: boolean;
}): readonly CareerPricingFeature[] {
  return CAREER_PRICING_FEATURES.filter((f) => {
    if (f.gate === null) return true;
    return f.gate === 'gd' ? enabled.gd : enabled.matching;
  });
}

// ── 1 日の利用上限の開示（購入前）────────────────────────────────────
//
// ★ 上限は server（DB の career_daily_quota_consume）が権威で、日付境界は
//   **日本時間 0:00**（lib/careerQuota/limits.ts）。ここは「その事実を購入前に伝える」
//   ためだけの表示であり、判定には一切関与しない。
// ★ 就活相談AI は quota bucket を持たない（CAREER_DAILY_QUOTA_FEATURES に無い）ので、
//   上限一覧に勝手な数値を付けない。

/** 利用上限セクションの見出し。 */
export const CAREER_PRICING_QUOTA_HEADING = '1日の利用上限';

/** 上限の性質を説明する注記（「毎日必ず○回保証」と読ませない）。 */
export const CAREER_PRICING_QUOTA_NOTE =
  '各AI機能には1日あたりの利用上限があります。上限は日本時間の0:00にリセットされます。';

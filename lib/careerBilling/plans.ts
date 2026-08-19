/**
 * PASSAI CAREER — 課金プランのカタログ（pure constants / client + server 双方から import 可）。
 *
 * 受験版 `lib/billing/plans.ts` の**構造だけ**を移植したもの。受験版の Product /
 * Price ID / 金額 / 訴求文言は **一切コピーしない**（別プロダクト・別 Stripe Price）。
 *
 * 設計:
 *   - plan key は CAREER 側に既存の `CareerPlan`（lib/careerAi/types.ts）と同一語彙。
 *     新語彙を発明せず、'free' | 'basic' | 'premium' の既存区分に合わせる。
 *     ズレたら build error になるよう下部で型レベルに固定する。
 *   - **金額（priceJpy）は本ファイルに持たない**。CAREER の価格仕様は repo 上のどこにも
 *     存在しない（LP に料金セクション無し・docs に価格記載無し）ため、勝手に創作しない。
 *     表示価格は Stripe Price（unit_amount / recurring）を server 側で読んで出す。
 *   - 実 Price ID は server-only helper（lib/careerBilling/stripe.ts の
 *     `getCareerStripePriceId`）だけが env から解決する。本ファイルは env を読まない。
 *   - env 名は受験版（STRIPE_PRICE_ID_BASIC / _PREMIUM）と **必ず別名**にする。
 *     同一 Stripe アカウント上で受験版 Price と CAREER Price が混線しないための境界。
 */

import type { CareerPlan } from '@/lib/careerAi/types';

/** 有料プラン（契約が存在する状態）。'free' は「契約が無い」を表すので含めない。 */
export const CAREER_PAID_PLAN_IDS = ['basic', 'premium'] as const;
export type CareerPaidPlanId = (typeof CAREER_PAID_PLAN_IDS)[number];

/** entitlement resolver が返す実効プラン。契約なし = 'free'。 */
export type CareerEffectivePlan = 'free' | CareerPaidPlanId;

/** CAREER 専用 Stripe Price ID の env 名（受験版とは別名で固定）。 */
export type CareerPriceEnvName =
  | 'STRIPE_PRICE_ID_CAREER_BASIC'
  | 'STRIPE_PRICE_ID_CAREER_PREMIUM';

export type CareerPlanConfig = {
  id: CareerPaidPlanId;
  /** UI 表示名。plan key と同語彙のみ。受験版の訴求文言は持ち込まない。 */
  label: string;
  /** server 側でのみ参照する env 変数名（client から process.env を引かない）。 */
  stripePriceIdEnvName: CareerPriceEnvName;
};

export const CAREER_PLANS: Record<CareerPaidPlanId, CareerPlanConfig> = {
  basic: {
    id: 'basic',
    label: 'Basic',
    stripePriceIdEnvName: 'STRIPE_PRICE_ID_CAREER_BASIC',
  },
  premium: {
    id: 'premium',
    label: 'Premium',
    stripePriceIdEnvName: 'STRIPE_PRICE_ID_CAREER_PREMIUM',
  },
};

export function isCareerPaidPlanId(value: unknown): value is CareerPaidPlanId {
  return (
    typeof value === 'string' &&
    (CAREER_PAID_PLAN_IDS as readonly string[]).includes(value)
  );
}

export function isCareerEffectivePlan(value: unknown): value is CareerEffectivePlan {
  return value === 'free' || isCareerPaidPlanId(value);
}

// ── 既存 CAREER 語彙との型レベル整合（drift したら build error）─────────────
//
// lib/careerAi/types.ts の CareerPlan（'free' | 'basic' | 'premium'）と
// CareerEffectivePlan は同一集合でなければならない。どちらかを片側だけ変更した
// 瞬間に、この 2 行が型エラーになる。
type _AssertPlanSubset = CareerEffectivePlan extends CareerPlan ? true : never;
type _AssertPlanSuperset = CareerPlan extends CareerEffectivePlan ? true : never;
const _planAlignment: [_AssertPlanSubset, _AssertPlanSuperset] = [true, true];
void _planAlignment;

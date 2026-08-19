/**
 * PASSAI CAREER — subscription status → entitlement の**純粋な**判定ポリシー。
 *
 * server-only な I/O（Supabase / Stripe）を一切含まない。理由:
 *   - 判定ロジックを 1 箇所に閉じ、route / cron / UI が別々の条件式を書くのを防ぐ。
 *   - `import 'server-only'` を含まないので QA script（tsx 直実行）から unit test できる。
 *
 * ポリシーは受験版 `lib/billing/syncSubscription.ts` の `deriveEffectivePlan` を
 * **そのまま踏襲**する（AGENTS 指示: 勝手に policy を決めず受験版を優先）:
 *
 *   権利あり:
 *     - status ∈ { active, trialing, past_due }
 *       ※ past_due は Stripe の dunning（再請求猶予）期間。受験版は access を維持する。
 *     - status = canceled でも current_period_end が未来なら grace period として維持
 *     - cancel_at_period_end = true（解約予約）は current_period_end まで維持
 *       → 「解約ボタンを押した瞬間に Premium が消える」ことは無い
 *   権利なし:
 *     - unpaid / incomplete / incomplete_expired / paused
 *     - canceled かつ current_period_end が過去（または未設定）
 *
 *   複数行があれば premium > basic > free の順で勝つ（プラン変更・再契約で行は増える）。
 */

import {
  isCareerPaidPlanId,
  type CareerEffectivePlan,
  type CareerPaidPlanId,
} from './plans';

/** Stripe Subscription.status の代表値。DDL の CHECK 制約と同一集合。 */
export const CAREER_SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
  'paused',
] as const;
export type CareerSubscriptionStatus =
  (typeof CAREER_SUBSCRIPTION_STATUSES)[number];

/** 契約が無くても（= status 単独で）権利が立つ status。受験版と同一。 */
const ENTITLED_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
]);

/** entitlement 判定に必要な最小の行形状（career_subscriptions の部分射影）。 */
export type CareerSubscriptionRow = {
  plan: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

/**
 * 全 subscription 行から「今この user に有効なプラン」を導出する。
 *
 * @param nowMs 判定時刻（テスト用に注入可能。既定は現在時刻）。
 */
export function deriveCareerEffectivePlan(
  rows: readonly CareerSubscriptionRow[],
  nowMs: number = Date.now(),
): CareerEffectivePlan {
  let hasPremium = false;
  let hasBasic = false;

  for (const row of rows) {
    // 未知の plan 値（env 破損 / 別商品混入）は権利に数えない（fail-closed）。
    if (!isCareerPaidPlanId(row.plan)) continue;

    const periodEndMs = row.current_period_end
      ? new Date(row.current_period_end).getTime()
      : 0;
    // 不正な日付文字列は 0 扱い（= grace 無し）に倒す。
    const safePeriodEndMs = Number.isNaN(periodEndMs) ? 0 : periodEndMs;

    const inEntitledStatus = ENTITLED_STATUSES.has(row.status);
    const inGracePeriod =
      (row.status === 'canceled' || row.cancel_at_period_end === true) &&
      safePeriodEndMs > nowMs;

    if (inEntitledStatus || inGracePeriod) {
      if (row.plan === 'premium') hasPremium = true;
      else if (row.plan === 'basic') hasBasic = true;
    }
  }

  if (hasPremium) return 'premium';
  if (hasBasic) return 'basic';
  return 'free';
}

/** 有料アクセス権があるか（free 以外）。UI / API 双方の唯一の述語。 */
export function hasCareerPaidAccess(plan: CareerEffectivePlan): boolean {
  return plan !== 'free';
}

/**
 * plan の強さ比較（premium > basic > free）。
 * 「premium 限定機能を basic が叩いた」を判定するのに使う。
 */
const PLAN_RANK: Record<CareerEffectivePlan, number> = {
  free: 0,
  basic: 1,
  premium: 2,
};

export function careerPlanSatisfies(
  actual: CareerEffectivePlan,
  required: CareerPaidPlanId,
): boolean {
  return PLAN_RANK[actual] >= PLAN_RANK[required];
}

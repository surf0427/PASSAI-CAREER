/**
 * Rare-category suppression — Layer 4（P17-A §5.3）。
 *
 * 既存 SuppressionReason の `rare_category` を列挙で終わらせず pure logic 化する。
 *
 * 意味（audience threshold とは別軸）:
 *   audience threshold は「denominator（母数）が小さい」ことを抑止する。
 *   rare_category は「cohort **値そのもの**の存在が稀」であることを抑止する
 *   （例: ある卒年の distinct user が極端に少ない → その cohort 値の存在自体が識別材料になり得る）。
 *   numerator に関係なく、cohort 値の support が閾値未満なら数値を返さない。
 *
 * policy:
 *   - 閾値は **PROVISIONAL**（法務・実データ未確認）。confidence 値として hard-code しない。
 *   - 閾値は注入可能（RareCategoryPolicy）。default も PROVISIONAL metadata を保持する。
 *   - complementary / difference attack に悪用されにくいよう「cohort 値の存在」レベルで倒す。
 *
 * pure function。DB / Date.now 非依存。
 */

import type { CohortType, PolicyStatus, SuppressionReason } from '@/types/careerAggregate';

export type RareCategoryPolicy = {
  /** cohort 値が「稀でない」と見なすのに必要な distinct-user support（PROVISIONAL）。 */
  minCategorySupport: number;
  status: PolicyStatus;
};

/** 既定 policy（全て PROVISIONAL・絶対安全値ではない）。 */
export const RARE_CATEGORY_POLICY: RareCategoryPolicy = {
  minCategorySupport: 20,
  status: 'PROVISIONAL',
};

export type RareCategoryDecision =
  | { rare: false }
  | { rare: true; reason: Extract<SuppressionReason, 'rare_category'> };

/**
 * cohort 値の support（その cohort 値に属する distinct user 数）から rare 判定する（pure）。
 *
 * - `all` cohort は母集団全体であり rare_category の対象外（常に rare=false）。
 * - graduation_year 等の分割 cohort のみ、support < minCategorySupport で rare。
 * - support が非有限 / 負は防御的に 0 として扱う（＝ rare 側へ倒す・fail-closed）。
 */
export function evaluateRareCategory(input: {
  cohortType: CohortType;
  /** cohort 値に属する distinct user 数（event 数ではない）。 */
  distinctUsersInCategory: number;
  policy?: RareCategoryPolicy;
}): RareCategoryDecision {
  if (input.cohortType === 'all') return { rare: false };
  const policy = input.policy ?? RARE_CATEGORY_POLICY;
  const support =
    Number.isFinite(input.distinctUsersInCategory) && input.distinctUsersInCategory > 0
      ? Math.floor(input.distinctUsersInCategory)
      : 0;
  if (support < policy.minCategorySupport) return { rare: true, reason: 'rare_category' };
  return { rare: false };
}

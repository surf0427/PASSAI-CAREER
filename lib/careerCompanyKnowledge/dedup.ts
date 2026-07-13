/**
 * Company Knowledge (Layer 5) — deduplication / conflict（P17-A §6.5）。
 *
 * semantic embedding / 外部 AI を使わず、offline で決定的に検証できる範囲で扱う:
 *   - normalized content fingerprint
 *   - 構造化 field 比較（company / category / observedPeriod / selection / role）
 *   - 正規化本文の token Jaccard（粗い類似度）
 *
 * 相反 evidence を一方へ統合しない（conflicting は保持）。閾値は PROVISIONAL。
 * pure・決定論。
 */

import { contributionCompanyKey, normalizeSummary } from './contribution';
import type {
  CompanyKnowledgeContribution,
  DedupRelation,
} from '@/types/careerCompanyKnowledge';

// PROVISIONAL 類似度閾値。
const PROBABLE_DUP_JACCARD = 0.6;
const CONFLICT_MAX_JACCARD = 0.3;

function tokens(summary: string): Set<string> {
  const norm = normalizeSummary(summary);
  if (norm === '') return new Set();
  return new Set(norm.split(/[\s、。,.\/・]+/).filter((t) => t.length > 0));
}

/** 正規化本文の Jaccard 類似度（0..1・決定論）。 */
export function summaryJaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : Number((inter / union).toFixed(4));
}

/**
 * 2 件の contribution の関係を分類する（pure・決定論）。
 *
 * - 別 company / 別 category → unrelated。
 * - 同 company・同 category:
 *   - 同 fingerprint → exact_duplicate。
 *   - 同一 structured slot（observedPeriod / selection / role 一致）:
 *       高類似 → probable_duplicate、低類似 → conflicting（相反として保持）。
 *   - observedPeriod が異なる かつ 別 contributor → independent_corroboration。
 *   - それ以外 → probable_duplicate（保守側）。
 */
export function classifyPair(
  a: CompanyKnowledgeContribution,
  b: CompanyKnowledgeContribution,
): DedupRelation {
  if (contributionCompanyKey(a) !== contributionCompanyKey(b)) return 'unrelated';
  if (a.contentCategory !== b.contentCategory) return 'unrelated';

  if (a.__contentFingerprint === b.__contentFingerprint) return 'exact_duplicate';

  const sameSlot =
    a.observedPeriod === b.observedPeriod &&
    a.selectionCategory === b.selectionCategory &&
    a.roleCategory === b.roleCategory;
  const jac = summaryJaccard(a.bodySummary, b.bodySummary);
  const differentContributor = a.__contributorOpaqueKey !== b.__contributorOpaqueKey;

  if (sameSlot) {
    if (jac >= PROBABLE_DUP_JACCARD) return 'probable_duplicate';
    if (jac <= CONFLICT_MAX_JACCARD) return 'conflicting';
    // 中間帯: 同一 slot だが判別困難 → 保守的に conflicting（統合しない）。
    return 'conflicting';
  }

  // 別 slot（観測時期が違う等）で別 contributor は独立裏付け。
  if (a.observedPeriod !== b.observedPeriod && differentContributor) {
    return 'independent_corroboration';
  }
  return 'probable_duplicate';
}

export type ContributionGroup = {
  /** exact/probable dup を畳んだ後の代表 contribution（決定論的に選出）。 */
  representative: CompanyKnowledgeContribution;
  /** この group に属する全 contribution（代表含む）。 */
  members: readonly CompanyKnowledgeContribution[];
  /** 独立 contributor 数（general trend 判定の corroboration base）。 */
  independentContributors: number;
  /** conflicting relation が存在するか（隠さず表示するためのフラグ）。 */
  hasConflict: boolean;
};

/**
 * contribution 群を dedup group へまとめる（pure・決定論）。
 * exact/probable duplicate を同一 group へ、independent_corroboration も同一 group へ
 * （裏付けとして数える）。conflicting は group 内に保持しフラグを立てる（統合しない）。
 */
export function groupContributions(
  list: readonly CompanyKnowledgeContribution[],
): ContributionGroup[] {
  // 決定論的に contributionId 昇順で処理。
  const sorted = [...list].sort((a, b) =>
    a.contributionId < b.contributionId ? -1 : a.contributionId > b.contributionId ? 1 : 0,
  );
  const groups: CompanyKnowledgeContribution[][] = [];

  for (const c of sorted) {
    let placed = false;
    for (const g of groups) {
      const rel = classifyPair(g[0], c);
      if (
        rel === 'exact_duplicate' ||
        rel === 'probable_duplicate' ||
        rel === 'independent_corroboration' ||
        rel === 'conflicting'
      ) {
        g.push(c);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([c]);
  }

  return groups.map((members) => {
    const contributors = new Set(members.map((m) => m.__contributorOpaqueKey));
    let hasConflict = false;
    for (let i = 0; i < members.length && !hasConflict; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (classifyPair(members[i], members[j]) === 'conflicting') {
          hasConflict = true;
          break;
        }
      }
    }
    return {
      representative: members[0],
      members,
      independentContributors: contributors.size,
      hasConflict,
    };
  });
}

/**
 * Company Knowledge (Layer 5) — version / freshness / history lineage（P17-B §8）。
 *
 * 古い選考情報を current として表示せず、過去年度を削除せず履歴化する。
 * 新しい情報が古い情報を無条件上書きしない（supersede lineage を保持）。
 *
 * pure・決定論。
 */

import { classifyFreshness } from './provenance';
import type {
  CompanyKnowledgeContribution,
  CompanyKnowledgeStaleReason,
  ContributionRevision,
} from '@/types/careerCompanyKnowledge';

/** contribution の stale 理由を判定する（null=current 有効）。 */
export function classifyStaleReason(
  c: CompanyKnowledgeContribution,
  nowIso: string,
): CompanyKnowledgeStaleReason | null {
  if (c.__excluded === true || c.lifecycleState === 'revoked') return 'revoked';
  if (typeof c.supersededBy === 'string' && c.supersededBy !== '') return 'superseded';
  if (classifyFreshness(c.observedPeriod, nowIso) === 'stale') return 'observed_period_old';
  return null;
}

/** contribution → revision record（履歴 lineage）。 */
export function buildRevision(c: CompanyKnowledgeContribution, nowIso: string): ContributionRevision {
  return {
    contributionId: c.contributionId,
    version: typeof c.version === 'number' ? c.version : 1,
    generatedAt: c.submittedAt,
    observedPeriod: c.observedPeriod,
    supersedes: null,
    supersededBy: c.supersededBy ?? null,
    staleReason: classifyStaleReason(c, nowIso),
  };
}

/**
 * older を newer で supersede する（不変更新・履歴を消さない）。
 * 古い方を削除せず supersededBy を張り、新しい方に supersedes を張る。
 */
export function supersede(
  older: CompanyKnowledgeContribution,
  newer: CompanyKnowledgeContribution,
): { older: CompanyKnowledgeContribution; newer: CompanyKnowledgeContribution } {
  return {
    older: { ...older, supersededBy: newer.contributionId },
    newer: { ...newer, version: (typeof newer.version === 'number' ? newer.version : 1) },
  };
}

/** revision を決定論順に並べる（version 降順・同値は id 昇順）。 */
export function orderRevisions(revisions: readonly ContributionRevision[]): ContributionRevision[] {
  return [...revisions].sort((a, b) => {
    if (a.version !== b.version) return b.version - a.version;
    return a.contributionId < b.contributionId ? -1 : a.contributionId > b.contributionId ? 1 : 0;
  });
}

/** current（supersede されておらず stale でない）revision のみ抽出。 */
export function currentRevisions(revisions: readonly ContributionRevision[]): ContributionRevision[] {
  return orderRevisions(revisions).filter((r) => r.supersededBy === null && r.staleReason === null);
}

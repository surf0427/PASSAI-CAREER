/**
 * Company Knowledge (Layer 5) — in-memory repository（P17-A §6.7・synthetic 専用）。
 *
 * 決定論的（Date.now / Math.random 非使用）。Supabase / localStorage / private research storage へ
 * 接続しない。read projection は buildCompanyKnowledgeProjection（fail-closed）へ委譲する。
 */

import { buildCompanyKnowledgeProjection } from './projection';
import type {
  CompanyKnowledgeReadProjectionQuery,
  CompanyKnowledgeRepository,
} from './repository';
import type {
  CompanyKnowledgeContribution,
  CompanyMasterRecord,
  ContributionModeration,
} from '@/types/careerCompanyKnowledge';
import type {
  CompanyKnowledgeProjection,
  ContextSourceResult,
} from '@/types/careerContextSource';

export function createInMemoryCompanyKnowledgeRepository(): CompanyKnowledgeRepository {
  const master = new Map<string, CompanyMasterRecord>();
  const contributions = new Map<string, CompanyKnowledgeContribution>();

  return {
    putMaster(record: CompanyMasterRecord): void {
      if (!record || typeof record.companyId !== 'string' || record.companyId === '') return;
      master.set(record.companyId, record);
    },
    listMaster(): readonly CompanyMasterRecord[] {
      return Array.from(master.values()).sort((a, b) =>
        a.companyId < b.companyId ? -1 : a.companyId > b.companyId ? 1 : 0,
      );
    },

    putContribution(c: CompanyKnowledgeContribution): void {
      if (!c || typeof c.contributionId !== 'string' || c.contributionId === '') return;
      contributions.set(c.contributionId, c);
    },
    getContribution(contributionId: string): CompanyKnowledgeContribution | null {
      return contributions.get(contributionId) ?? null;
    },
    listContributions(): readonly CompanyKnowledgeContribution[] {
      return Array.from(contributions.values()).sort((a, b) =>
        a.contributionId < b.contributionId ? -1 : a.contributionId > b.contributionId ? 1 : 0,
      );
    },

    updateModeration(contributionId: string, moderation: ContributionModeration): boolean {
      const existing = contributions.get(contributionId);
      if (!existing) return false;
      contributions.set(contributionId, { ...existing, moderation });
      return true;
    },
    revoke(contributionId: string): boolean {
      const existing = contributions.get(contributionId);
      if (!existing) return false;
      // 物理削除しない（logical exclusion）。read は __excluded を除外する。
      contributions.set(contributionId, { ...existing, __excluded: true });
      return true;
    },

    readProjection(
      query: CompanyKnowledgeReadProjectionQuery,
    ): ContextSourceResult<CompanyKnowledgeProjection> {
      const all = Array.from(contributions.values()).filter((c) => c.__excluded !== true);
      return buildCompanyKnowledgeProjection({
        purpose: query.purpose,
        companyId: query.companyId,
        displayName: query.displayName,
        contributions: all,
        nowIso: query.nowIso,
      });
    },
  };
}

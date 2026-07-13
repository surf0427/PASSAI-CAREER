/**
 * Company Knowledge (Layer 5) — in-memory repository（P17-A §6.7 + P17-B §9・synthetic 専用）。
 *
 * 決定論的（Date.now / Math.random 非使用）。Supabase / localStorage / private research storage へ
 * 接続しない。read projection は buildCompanyKnowledgeProjection（fail-closed）へ委譲する。
 */

import { buildCompanyKnowledgeProjection } from './projection';
import { transitionContributionLifecycle } from './lifecycle';
import { buildRevision } from './version';
import { buildEvidenceGroups } from './evidence';
import { contributionCompanyKey } from './contribution';
import type {
  CompanyKnowledgeReadProjectionQuery,
  CompanyKnowledgeRepository,
} from './repository';
import type {
  AggregatedEvidenceGroup,
  CompanyKnowledgeConsentSnapshot,
  CompanyKnowledgeContribution,
  CompanyMasterRecord,
  ContributionLifecycleAction,
  ContributionLifecycleState,
  ContributionModeration,
  ContributionRevision,
  ConsentActorClass,
  LifecycleAuditEntry,
  LifecycleTransitionResult,
} from '@/types/careerCompanyKnowledge';
import type {
  CompanyKnowledgeProjection,
  ContextSourceResult,
} from '@/types/careerContextSource';

function actorClassFor(action: ContributionLifecycleAction): ConsentActorClass {
  switch (action) {
    case 'grant_consent':
    case 'withdraw':
    case 'submit':
      return 'contributor';
    case 'legal_hold':
    case 'release_legal_hold':
      return 'legal';
    case 'start_privacy_review':
    case 'pass_privacy_review':
    case 'fail_privacy_review':
    case 'start_moderation':
    case 'approve':
    case 'reject':
    case 'publish':
      return 'moderator';
    default:
      return 'system';
  }
}

export function createInMemoryCompanyKnowledgeRepository(): CompanyKnowledgeRepository {
  const master = new Map<string, CompanyMasterRecord>();
  const contributions = new Map<string, CompanyKnowledgeContribution>();
  const consentSnapshots = new Map<string, CompanyKnowledgeConsentSnapshot>();
  const lifecycleAudit: LifecycleAuditEntry[] = [];

  const nonExcluded = () => Array.from(contributions.values()).filter((c) => c.__excluded !== true);

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
      contributions.set(contributionId, { ...existing, __excluded: true, lifecycleState: 'revoked' });
      return true;
    },

    transitionLifecycle(
      contributionId: string,
      action: ContributionLifecycleAction,
      at: string,
    ): LifecycleTransitionResult {
      const existing = contributions.get(contributionId);
      const from: ContributionLifecycleState = existing?.lifecycleState ?? 'draft';
      if (!existing) return { ok: false, from, reason: 'invalid_transition' };
      const result = transitionContributionLifecycle(from, action);
      if (!result.ok) return result;
      const excluded = result.to === 'revoked' || result.to === 'blocked' || result.to === 'expired';
      contributions.set(contributionId, {
        ...existing,
        lifecycleState: result.to,
        __excluded: excluded ? true : existing.__excluded,
      });
      lifecycleAudit.push({ contributionId, action, from: result.from, to: result.to, at, actorClass: actorClassFor(action) });
      return result;
    },

    putConsentSnapshot(snapshot: CompanyKnowledgeConsentSnapshot): void {
      if (!snapshot || typeof snapshot.contributionId !== 'string') return;
      consentSnapshots.set(snapshot.contributionId, snapshot);
    },
    getConsentSnapshot(contributionId: string): CompanyKnowledgeConsentSnapshot | null {
      return consentSnapshots.get(contributionId) ?? null;
    },

    setLegalHold(contributionId: string, hold: boolean): boolean {
      const existing = contributions.get(contributionId);
      if (!existing) return false;
      contributions.set(contributionId, {
        ...existing,
        legalHold: hold,
        // hold 中は read 除外（公開継続と混同しない）。解除しても自動再公開しない。
        __excluded: hold ? true : existing.__excluded,
        lifecycleState: hold ? 'legal_hold' : existing.lifecycleState,
      });
      return true;
    },

    listLifecycleAudit(): readonly LifecycleAuditEntry[] {
      // append 順を保持しつつ、決定論のため (at, contributionId, action) で安定ソート。
      return [...lifecycleAudit].sort((a, b) => {
        if (a.at !== b.at) return a.at < b.at ? -1 : 1;
        if (a.contributionId !== b.contributionId) return a.contributionId < b.contributionId ? -1 : 1;
        return a.action < b.action ? -1 : a.action > b.action ? 1 : 0;
      });
    },

    listRevisions(nowIso: string): readonly ContributionRevision[] {
      return Array.from(contributions.values())
        .map((c) => buildRevision(c, nowIso))
        .sort((a, b) => {
          if (a.version !== b.version) return b.version - a.version;
          return a.contributionId < b.contributionId ? -1 : a.contributionId > b.contributionId ? 1 : 0;
        });
    },

    readEvidenceGroups(companyId: string, nowIso: string): readonly AggregatedEvidenceGroup[] {
      const forCompany = nonExcluded().filter((c) => contributionCompanyKey(c) === companyId);
      return buildEvidenceGroups(forCompany, nowIso);
    },

    readProjection(
      query: CompanyKnowledgeReadProjectionQuery,
    ): ContextSourceResult<CompanyKnowledgeProjection> {
      const all = nonExcluded();
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

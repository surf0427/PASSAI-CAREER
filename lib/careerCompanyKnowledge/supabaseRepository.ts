/**
 * Company Knowledge (Layer 5) — Supabase write repository（P17-C §8・client injection）。
 *
 * env read なし / client 生成なし / 実 DB call なし（write port 注入）。
 * domain → row 写像。禁止 field（contributor name/email/大学/応募ID/auth user id）を row へ入れない。
 * contributor_opaque_key は内部専用として保存するが shared read へは出さない（read repo が保証）。
 */

import type {
  DataSpineWritePort,
  DbRow,
  DbWriteResult,
} from '@/lib/careerDataSpineDb/types';
import type {
  CompanyKnowledgeConsentSnapshot,
  CompanyKnowledgeContribution,
  CompanyMasterRecord,
  ContributionModeration,
} from '@/types/careerCompanyKnowledge';

const MASTER_TABLE = 'career_company_master';
const CONTRIB_TABLE = 'career_company_knowledge_contributions';
const CONSENT_TABLE = 'career_company_knowledge_consent_snapshots';
const MODERATION_TABLE = 'career_company_knowledge_moderation';

function masterToRow(m: CompanyMasterRecord): DbRow {
  return {
    company_id: m.companyId,
    display_name: m.displayName,
    legal_name: m.legalName ?? null,
    normalized_name: m.normalizedName,
    corporate_group_id: m.corporateGroupId,
    parent_id: m.parentId ?? null,
    identity_version: m.identityVersion ?? 1,
    effective_from: m.effectiveFrom ?? null,
    effective_to: m.effectiveTo ?? null,
    resolution_state: 'resolved',
  };
}

function contributionToRow(c: CompanyKnowledgeContribution): DbRow {
  const companyId = c.company.status === 'resolved' ? c.company.companyId : '';
  return {
    contribution_id: c.contributionId,
    company_id: companyId,
    content_category: c.contentCategory,
    source_category: c.sourceCategory,
    evidence_kind: c.evidenceKind,
    observed_period: c.observedPeriod,
    selection_category: c.selectionCategory,
    role_category: c.roleCategory,
    evidence_summary: c.bodySummary,
    lifecycle_state: c.lifecycleState ?? 'draft',
    provenance_note: c.provenanceNote,
    version: c.version ?? 1,
    superseded_by: c.supersededBy ?? null,
    legal_hold: c.legalHold ?? false,
    revoked: c.__excluded === true,
    expired: c.lifecycleState === 'expired',
    contributor_opaque_key: c.__contributorOpaqueKey,
    content_fingerprint: c.__contentFingerprint,
    submitted_at: c.submittedAt,
  };
}

function consentToRow(s: CompanyKnowledgeConsentSnapshot): DbRow {
  return {
    id: `${s.contributionId}:${s.snapshotVersion}`,
    contribution_id: s.contributionId,
    scope: s.scope,
    policy_version: s.policyVersion,
    granted_at: s.grantedAt,
    revoked_at: s.revokedAt,
    consent_source: s.consentSource,
    actor_class: s.actorClass,
    permitted_uses: s.permittedUses,
    prohibited_uses: s.prohibitedUses,
    snapshot_version: s.snapshotVersion,
  };
}

function moderationToRow(contributionId: string, m: ContributionModeration): DbRow {
  return {
    contribution_id: contributionId,
    state: m.state,
    pii_scan: m.piiScan,
    confidentiality: m.confidentiality,
    abuse: m.abuse,
    rejection_reason: m.rejectionReason,
  };
}

export function createSupabaseCompanyKnowledgeRepository(writePort: DataSpineWritePort) {
  return {
    async putMaster(m: CompanyMasterRecord): Promise<DbWriteResult> {
      return writePort.insert(MASTER_TABLE, [masterToRow(m)]);
    },
    async putContribution(c: CompanyKnowledgeContribution): Promise<DbWriteResult> {
      return writePort.insert(CONTRIB_TABLE, [contributionToRow(c)]);
    },
    async putConsentSnapshot(s: CompanyKnowledgeConsentSnapshot): Promise<DbWriteResult> {
      return writePort.insert(CONSENT_TABLE, [consentToRow(s)]);
    },
    async putModeration(contributionId: string, m: ContributionModeration): Promise<DbWriteResult> {
      return writePort.insert(MODERATION_TABLE, [moderationToRow(contributionId, m)]);
    },
    async setRevoked(contributionId: string): Promise<DbWriteResult> {
      return writePort.update(CONTRIB_TABLE, { revoked: true, lifecycle_state: 'revoked' }, { eq: { contribution_id: contributionId } });
    },
    async setLegalHold(contributionId: string, hold: boolean): Promise<DbWriteResult> {
      return writePort.update(CONTRIB_TABLE, { legal_hold: hold }, { eq: { contribution_id: contributionId } });
    },
  };
}

export type SupabaseCompanyKnowledgeRepository = ReturnType<typeof createSupabaseCompanyKnowledgeRepository>;

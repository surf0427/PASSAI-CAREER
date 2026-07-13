/*
 * scripts/fixtures/careerCompanyKnowledgeFixtures.ts
 *
 * PASSAI CAREER — Company Knowledge (Layer 5) synthetic fixtures（P17-A・dev-only）。
 *
 * 実データ・実投稿・private research を一切使わない synthetic 生成ヘルパ。
 * 合成企業（c_alpha 等）・合成 opaque key（k1 等）のみ。実在企業名・実在個人は使わない。
 */

import { buildContentFingerprint } from '@/lib/careerCompanyKnowledge/contribution';
import type {
  CompanyContentCategory,
  CompanyEvidenceKind,
  CompanyKnowledgeConsentState,
  CompanyKnowledgeContribution,
  CompanyMasterRecord,
  CompanySourceCategory,
  ContributionModeration,
  RoleCategory,
  SelectionCategory,
} from '@/types/careerCompanyKnowledge';

// 決定論 now（マシン時刻非依存）。observedPeriod '2026' は fresh、'2020' は stale。
export const NOW_ISO = '2026-07-13T00:00:00.000Z';

// ── Company master（alias collision を含む）─────────────────────────────
export const MASTER: CompanyMasterRecord[] = [
  {
    companyId: 'c_alpha',
    displayName: 'Alpha株式会社',
    normalizedName: 'alpha',
    aliases: ['アルファ', 'Alpha Inc.'],
    corporateGroupId: null,
  },
  {
    companyId: 'c_beta',
    displayName: 'Beta Corporation',
    normalizedName: 'beta',
    aliases: ['ベータ'],
    corporateGroupId: 'g_beta_holdings',
  },
  // collision: alias 'zeta' が c_gamma / c_delta 双方を指す（黙って解決してはいけない）。
  {
    companyId: 'c_gamma',
    displayName: 'Gamma',
    normalizedName: 'gamma',
    aliases: ['zeta'],
    corporateGroupId: null,
  },
  {
    companyId: 'c_delta',
    displayName: 'Delta',
    normalizedName: 'delta',
    aliases: ['zeta'],
    corporateGroupId: null,
  },
];

// ── moderation presets ─────────────────────────────────────────────
export function moderationApprovedClean(): ContributionModeration {
  return { state: 'approved', piiScan: 'clean', confidentiality: 'low', abuse: 'none', rejectionReason: null };
}
export function moderationPending(): ContributionModeration {
  return { state: 'pending', piiScan: 'not_scanned', confidentiality: 'unknown', abuse: 'none', rejectionReason: null };
}
export function moderationPiiUnknown(): ContributionModeration {
  return { state: 'approved', piiScan: 'not_scanned', confidentiality: 'low', abuse: 'none', rejectionReason: null };
}
export function moderationConfidentialityUnknown(): ContributionModeration {
  return { state: 'approved', piiScan: 'clean', confidentiality: 'unknown', abuse: 'none', rejectionReason: null };
}

// ── contribution builder（fingerprint を必ず正しく計算）─────────────────
export type MkContributionOverrides = {
  contributionId: string;
  companyId?: string;
  contentCategory?: CompanyContentCategory;
  sourceCategory?: CompanySourceCategory;
  evidenceKind?: CompanyEvidenceKind;
  observedPeriod?: string;
  selectionCategory?: SelectionCategory;
  roleCategory?: RoleCategory;
  bodySummary?: string;
  consentState?: CompanyKnowledgeConsentState;
  submittedAt?: string;
  moderation?: ContributionModeration;
  contributorKey?: string;
  excluded?: boolean;
};

export function mkContribution(over: MkContributionOverrides): CompanyKnowledgeContribution {
  const companyId = over.companyId ?? 'c_alpha';
  const displayName =
    MASTER.find((m) => m.companyId === companyId)?.displayName ?? companyId;
  const contentCategory = over.contentCategory ?? 'selection_flow';
  const observedPeriod = over.observedPeriod ?? '2026';
  const selectionCategory = over.selectionCategory ?? 'full_time';
  const roleCategory = over.roleCategory ?? 'engineering';
  const bodySummary = over.bodySummary ?? '一次面接は志望動機と学生時代の取り組みを中心に問われた。';

  const fingerprint = buildContentFingerprint({
    companyKey: companyId,
    contentCategory,
    bodySummary,
    observedPeriod,
    selectionCategory,
    roleCategory,
  });

  return {
    contributionId: over.contributionId,
    company: { status: 'resolved', companyId, displayName, matchedAlias: null },
    contentCategory,
    sourceCategory: over.sourceCategory ?? 'self_experience',
    evidenceKind: over.evidenceKind ?? 'user_experience',
    observedPeriod,
    selectionCategory,
    roleCategory,
    bodySummary,
    consentState: over.consentState ?? 'share_granted',
    submittedAt: over.submittedAt ?? '2026-06-01T00:00:00.000Z',
    moderation: over.moderation ?? moderationApprovedClean(),
    provenanceNote: null,
    privacyClassification: 'shared_company_knowledge',
    __contributorOpaqueKey: over.contributorKey ?? 'k_default',
    __contentFingerprint: fingerprint,
    __excluded: over.excluded,
  };
}

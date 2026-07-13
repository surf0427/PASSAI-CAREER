/**
 * Company Knowledge (Layer 5) — purpose-specific read projection（P17-A §6.6）。
 *
 * approved + privacy-safe + non-stale + share-consent 済 の contribution のみを、
 * purpose ごとに必要な最小 projection へ整える。
 *
 * 厳守:
 *   - contributor identity を projection に含めない（型に存在しない）。
 *   - raw 全文を返さない（bodySummary を上限で truncate）。
 *   - official と user evidence を区別する（evidenceKind 保持）。
 *   - conflict を隠さない（conflicting フラグ + corroboration='conflicting'）。
 *   - 単一投稿を general trend として返さない（corroboration='single_report'）。
 *   - insufficient evidence は empty（unknown と混同しない）。
 *   - deterministic ordering / 最大件数・byte 上限を境界契約として持つ。
 *
 * production 非接続: prompt / route / Supabase へ接続しない。pure・決定論。
 */

import { contributionCompanyKey, isShareConsentEligible } from './contribution';
import { evaluateModerationReadable } from './moderation';
import { classifyFreshness, computeConfidenceBasis } from './provenance';
import { groupContributions } from './dedup';
import {
  MIN_CORROBORATION_FOR_TREND,
  PURPOSE_CONTENT_ALLOWLIST,
  READ_PROJECTION_POLICY,
  FRESHNESS_POLICY,
  type ReadProjectionPolicy,
  type FreshnessPolicy,
} from './policy';
import type { CompanyKnowledgeContribution } from '@/types/careerCompanyKnowledge';
import type {
  CompanyKnowledgeCorroboration,
  CompanyKnowledgeEvidenceSummary,
  CompanyKnowledgeProjection,
  ContextSourceResult,
} from '@/types/careerContextSource';

function truncate(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max).trim()}…`;
}

export type CompanyKnowledgeProjectionInput = {
  purpose: string;
  companyId: string;
  displayName: string;
  contributions: readonly CompanyKnowledgeContribution[];
  nowIso: string;
  projectionPolicy?: ReadProjectionPolicy;
  freshnessPolicy?: FreshnessPolicy;
};

/**
 * 企業 1 社分の purpose-specific projection を作る（pure）。
 * 返り値は ContextSourceResult（available / empty / unavailable のいずれか）。
 */
export function buildCompanyKnowledgeProjection(
  input: CompanyKnowledgeProjectionInput,
): ContextSourceResult<CompanyKnowledgeProjection> {
  const projectionPolicy = input.projectionPolicy ?? READ_PROJECTION_POLICY;
  const freshnessPolicy = input.freshnessPolicy ?? FRESHNESS_POLICY;

  const allowedCategories = PURPOSE_CONTENT_ALLOWLIST[input.purpose];
  // purpose が未知（allowlist 無し）は「未確認」＝ unavailable（empty と混同しない）。
  if (!allowedCategories) return { status: 'unavailable', reason: 'not_checked' };

  // 1) 対象 company の contribution のみ。
  const forCompany = input.contributions.filter(
    (c) => contributionCompanyKey(c) === input.companyId,
  );

  // 2) gate: share consent 済 + moderation readable + non-stale + purpose category 許可。
  const readable = forCompany.filter((c) => {
    if (!isShareConsentEligible(c)) return false;
    if (!evaluateModerationReadable(c.moderation).readable) return false;
    if (!(allowedCategories as readonly string[]).includes(c.contentCategory)) return false;
    const fresh = classifyFreshness(c.observedPeriod, input.nowIso, freshnessPolicy);
    if (fresh === 'stale') return false; // stale evidence は available に出さない
    return true;
  });

  if (readable.length === 0) {
    // 確認したが有効 evidence 無し（negative evidence ではない）。
    return { status: 'empty', reason: 'no_eligible_data' };
  }

  // 3) dedup group 化（corroboration / conflict を導出）。
  const groups = groupContributions(readable);

  let anyConflict = false;
  let maxIndependent = 0;
  const evidences: CompanyKnowledgeEvidenceSummary[] = groups.map((g) => {
    const rep = g.representative;
    const freshness = classifyFreshness(rep.observedPeriod, input.nowIso, freshnessPolicy);
    const basis = computeConfidenceBasis({
      evidenceKind: rep.evidenceKind,
      corroborationCount: g.independentContributors,
      freshness,
    });
    if (g.hasConflict) anyConflict = true;
    if (g.independentContributors > maxIndependent) maxIndependent = g.independentContributors;
    return {
      contentCategory: rep.contentCategory,
      summary: truncate(rep.bodySummary, projectionPolicy.maxSummaryChars),
      evidenceKind: rep.evidenceKind,
      observedPeriod: rep.observedPeriod,
      freshness,
      confidence: basis.value,
      conflicting: g.hasConflict,
    };
  });

  // 4) deterministic ordering + 件数上限。
  evidences.sort((a, b) => {
    if (a.contentCategory !== b.contentCategory) return a.contentCategory < b.contentCategory ? -1 : 1;
    if (a.observedPeriod !== b.observedPeriod) return a.observedPeriod < b.observedPeriod ? 1 : -1; // 新しい順
    return a.summary < b.summary ? -1 : a.summary > b.summary ? 1 : 0;
  });
  const boundedEvidence = evidences.slice(0, projectionPolicy.maxEvidencePerCompany);

  // 5) corroboration 分類（単一投稿を trend として表示しない）。
  const corroboration: CompanyKnowledgeCorroboration = anyConflict
    ? 'conflicting'
    : maxIndependent >= MIN_CORROBORATION_FOR_TREND
      ? 'independent_corroboration'
      : 'single_report';

  const topConfidence = boundedEvidence.reduce((m, e) => (e.confidence > m ? e.confidence : m), 0);
  const freshestPeriod = boundedEvidence.reduce(
    (best, e) => (e.observedPeriod > best ? e.observedPeriod : best),
    boundedEvidence[0]?.observedPeriod ?? '',
  );
  const topFreshness = classifyFreshness(freshestPeriod, input.nowIso, freshnessPolicy);

  const data: CompanyKnowledgeProjection = {
    companyId: input.companyId,
    displayName: input.displayName,
    evidence: boundedEvidence,
    corroboration,
    provenance: {
      layer: 'company_knowledge',
      generatedAt: input.nowIso,
      sourceWindow: freshestPeriod || null,
      calculationVersion: 'company_knowledge@1',
      policyStatus: 'PROVISIONAL',
    },
  };

  return {
    status: 'available',
    data,
    provenance: data.provenance,
    confidence: topConfidence,
    freshness: {
      generatedAt: input.nowIso,
      expiresAt: null, // KB は observedPeriod ベースの freshness（固定 expiry を持たない）
      observedPeriod: freshestPeriod || null,
      classification: topFreshness,
    },
    privacy: 'shared_company_knowledge',
    usage: 'user_evidence_not_fact',
  };
}

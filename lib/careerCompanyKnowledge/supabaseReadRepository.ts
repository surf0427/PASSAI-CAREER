/**
 * Company Knowledge (Layer 5) — Supabase read repository（P17-C §8・client injection）。
 *
 * env read なし / client 生成なし / 実 DB call なし（read port 注入）。
 * never-throw read。row validation・unknown enum fail-closed。
 * moderation 前 / consent 無し / legal hold / revoked は read へ出さない（projection gate + row 復元で担保）。
 * contributor_opaque_key を上位（projection）へ出さない（buildCompanyKnowledgeProjection が保証）。
 */

import { buildCompanyKnowledgeProjection } from './projection';
import { computeContributionFingerprint } from './contribution';
import { clampPagination } from '@/lib/careerDataSpineDb/types';
import type { DataSpineReadPort, DbRow, PaginationSpec } from '@/lib/careerDataSpineDb/types';
import type {
  CompanyContentCategory,
  CompanyEvidenceKind,
  CompanyKnowledgeContribution,
  CompanySourceCategory,
  ContributionModeration,
  ContributionLifecycleState,
  RoleCategory,
  SelectionCategory,
} from '@/types/careerCompanyKnowledge';
import type {
  CompanyKnowledgeProjection,
  ContextSourceResult,
} from '@/types/careerContextSource';

const CONTRIB_TABLE = 'career_company_knowledge_contributions';
const MODERATION_TABLE = 'career_company_knowledge_moderation';

const EVIDENCE_KINDS: readonly string[] = ['official', 'company_provided', 'user_experience', 'inferred_summary'];
const CONTENT_CATEGORIES: readonly string[] = [
  'es_question', 'interview_question', 'selection_flow', 'briefing_note', 'desired_candidate_profile', 'general_note',
];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function bool(v: unknown): boolean {
  return v === true;
}
function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function parseModeration(row: DbRow | undefined): ContributionModeration {
  // 欠落 / 不明は fail-closed（pending / unknown）。
  if (!row) return { state: 'pending', piiScan: 'not_scanned', confidentiality: 'unknown', abuse: 'none', rejectionReason: null };
  const state = row.state;
  const stateOk = state === 'pending' || state === 'approved' || state === 'rejected' || state === 'blocked';
  const pii = row.pii_scan;
  const piiOk = pii === 'not_scanned' || pii === 'clean' || pii === 'pii_detected';
  const conf = row.confidentiality;
  const confOk = conf === 'unknown' || conf === 'low' || conf === 'elevated' || conf === 'restricted';
  const abuse = row.abuse;
  const abuseOk = abuse === 'none' || abuse === 'reported' || abuse === 'upheld';
  return {
    state: stateOk ? (state as ContributionModeration['state']) : 'pending',
    piiScan: piiOk ? (pii as ContributionModeration['piiScan']) : 'not_scanned',
    confidentiality: confOk ? (conf as ContributionModeration['confidentiality']) : 'unknown',
    abuse: abuseOk ? (abuse as ContributionModeration['abuse']) : 'none',
    rejectionReason: null,
  };
}

/** contribution row → domain（unknown enum は null で skip）。 */
function parseContribution(
  row: DbRow,
  displayName: string,
  moderation: ContributionModeration,
): CompanyKnowledgeContribution | null {
  const contributionId = str(row.contribution_id);
  const companyId = str(row.company_id);
  if (contributionId === '' || companyId === '') return null;
  const evidenceKind = str(row.evidence_kind);
  if (!EVIDENCE_KINDS.includes(evidenceKind)) return null; // unknown enum fail-closed
  const contentCategory = str(row.content_category);
  if (!CONTENT_CATEGORIES.includes(contentCategory)) return null;
  const observedPeriod = str(row.observed_period);
  const evidenceSummary = str(row.evidence_summary);
  if (observedPeriod === '' || evidenceSummary === '') return null;

  const lifecycleState = str(row.lifecycle_state) as ContributionLifecycleState;
  const c: CompanyKnowledgeContribution = {
    contributionId,
    company: { status: 'resolved', companyId, displayName, matchedAlias: null },
    contentCategory: contentCategory as CompanyContentCategory,
    sourceCategory: (str(row.source_category) || 'self_experience') as CompanySourceCategory,
    evidenceKind: evidenceKind as CompanyEvidenceKind,
    observedPeriod,
    selectionCategory: (str(row.selection_category) || 'unknown') as SelectionCategory,
    roleCategory: (str(row.role_category) || 'unknown') as RoleCategory,
    bodySummary: evidenceSummary,
    // published lifecycle は consent granted を含意（lifecycle は consent 無しで published に到達しない）。
    //   ★ Closure Batch: `revoked` 列も **同時に**満たすことを要求する（defense in depth）。
    //     lifecycle_state の更新漏れで published のまま revoked=true な行が残っても、
    //     ここで share_granted へ復帰させない（`__excluded` 側の判定と二重化する）。
    consentState:
      lifecycleState === 'published' && !bool(row.revoked) ? 'share_granted' : 'not_shared',
    submittedAt: str(row.submitted_at),
    moderation,
    provenanceNote: str(row.provenance_note) || null,
    privacyClassification: 'shared_company_knowledge',
    lifecycleState,
    legalHold: bool(row.legal_hold),
    version: num(row.version, 1),
    supersededBy: str(row.superseded_by) || null,
    __contributorOpaqueKey: str(row.contributor_opaque_key), // 内部専用（projection へは出ない）
    __contentFingerprint: str(row.content_fingerprint),
    __excluded: bool(row.revoked),
  };
  // fingerprint 欠落時は再計算（dedup 整合）。
  if (c.__contentFingerprint === '') c.__contentFingerprint = computeContributionFingerprint(c);
  return c;
}

export function createSupabaseCompanyKnowledgeReadRepository(readPort: DataSpineReadPort) {
  return {
    async readProjection(query: {
      purpose: string;
      companyId: string;
      displayName: string;
      nowIso: string;
      pagination?: Partial<PaginationSpec>;
    }): Promise<ContextSourceResult<CompanyKnowledgeProjection>> {
      try {
        const page = clampPagination(query.pagination);
        const res = await readPort.select({
          table: CONTRIB_TABLE,
          eq: { company_id: query.companyId },
          order: { column: 'contribution_id', ascending: true },
          limit: page.limit,
          offset: page.offset,
        });
        if (!res.ok) return { status: 'unavailable', reason: 'lookup_error' };
        if (res.rows.length === 0) return { status: 'empty', reason: 'no_evidence' };

        const ids = res.rows.map((r) => str(r.contribution_id)).filter((s) => s !== '');
        const modRes = await readPort.select({
          table: MODERATION_TABLE,
          in: { column: 'contribution_id', values: ids },
          limit: page.limit,
        });
        const modByContribution = new Map<string, DbRow>();
        if (modRes.ok) {
          for (const m of modRes.rows) modByContribution.set(str(m.contribution_id), m);
        }
        // moderation 取得失敗は fail-closed（全て pending 扱い → readable にならない）。

        const contributions: CompanyKnowledgeContribution[] = [];
        for (const row of res.rows) {
          const moderation = parseModeration(modByContribution.get(str(row.contribution_id)));
          const c = parseContribution(row, query.displayName, moderation);
          if (c && c.__excluded !== true) contributions.push(c);
        }

        // fail-closed の projection gate（lifecycle/consent/moderation/freshness/purpose）は projection に委譲。
        return buildCompanyKnowledgeProjection({
          purpose: query.purpose,
          companyId: query.companyId,
          displayName: query.displayName,
          contributions,
          nowIso: query.nowIso,
        });
      } catch {
        return { status: 'unavailable', reason: 'unknown' };
      }
    },
  };
}

export type SupabaseCompanyKnowledgeReadRepository = ReturnType<typeof createSupabaseCompanyKnowledgeReadRepository>;

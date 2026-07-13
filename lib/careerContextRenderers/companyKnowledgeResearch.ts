/**
 * Offline vertical renderer — Company Knowledge → company-research 補足 block（P17-B §13.2）。
 *
 * **offline 専用**。production prompt / route / Context Orchestrator から import しない
 * （static guard QA が import 0 を保証）。production company-research prompt は変更しない。
 *
 * 契約:
 *   - available（approved/published/safe/non-stale）projection のみ render。
 *   - official / user evidence を区別。conflict を明示。単一投稿を trend として表示しない。
 *   - user_evidence_not_fact（企業の確定事実として書かない）。
 *   - 最大件数 / byte budget 遵守。stale / blocked / ambiguous company は空。
 *   - 例外時は空。
 *
 * pure・決定論・never-throw。
 */

import { isContextSourceAvailable } from '@/types/careerContextSource';
import type {
  CompanyKnowledgeEvidenceKind,
  CompanyKnowledgeProjection,
  ContextSourceResult,
} from '@/types/careerContextSource';

export type CompanyResearchKnowledgeBlock = {
  text: string;
  used: boolean;
};

export const COMPANY_RESEARCH_MAX_BYTES = 1200;
export const COMPANY_RESEARCH_MAX_EVIDENCE = 5;

const EMPTY: CompanyResearchKnowledgeBlock = { text: '', used: false };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function kindLabel(kind: CompanyKnowledgeEvidenceKind): string {
  switch (kind) {
    case 'official':
      return '公式情報';
    case 'company_provided':
      return '企業提供';
    case 'user_experience':
      return '体験談';
    case 'inferred_summary':
      return '要約';
    default:
      return '参考';
  }
}

export function renderCompanyKnowledgeResearchBlock(
  result: ContextSourceResult<CompanyKnowledgeProjection>,
  opts: { maxBytes?: number; maxEvidence?: number } = {},
): CompanyResearchKnowledgeBlock {
  try {
    if (!isContextSourceAvailable(result)) return EMPTY;
    if (result.usage !== 'user_evidence_not_fact' || result.privacy !== 'shared_company_knowledge') return EMPTY;
    const data = result.data;
    if (!data || !Array.isArray(data.evidence) || data.evidence.length === 0) return EMPTY;

    const maxEvidence = opts.maxEvidence ?? COMPANY_RESEARCH_MAX_EVIDENCE;
    const header =
      data.corroboration === 'single_report'
        ? `【参考: 他ユーザー共有の企業知見（${data.displayName}・単一報告・確定情報ではありません）】`
        : data.corroboration === 'conflicting'
          ? `【参考: 他ユーザー共有の企業知見（${data.displayName}・相反する報告あり・確定情報ではありません）】`
          : `【参考: 他ユーザー共有の企業知見（${data.displayName}・複数報告・確定情報ではありません）】`;

    const lines = [header];
    for (const e of data.evidence.slice(0, maxEvidence)) {
      const conflictMark = e.conflicting ? '（他報告と相反）' : '';
      lines.push(`- [${kindLabel(e.evidenceKind)}/${e.observedPeriod}] ${e.summary}${conflictMark}`);
    }
    lines.push('※ 他ユーザーの体験に基づく参考情報であり、企業の公式・確定事実ではありません。必ず一次情報で確認してください。');

    const text = lines.join('\n');
    const maxBytes = opts.maxBytes ?? COMPANY_RESEARCH_MAX_BYTES;
    if (byteLength(text) > maxBytes) {
      // budget 超過時は evidence を 1 件へ縮約して再試行。なお超過なら空。
      const reduced = [header, lines[1], lines[lines.length - 1]].filter(Boolean).join('\n');
      return byteLength(reduced) <= maxBytes ? { text: reduced, used: true } : EMPTY;
    }
    return { text, used: true };
  } catch {
    return EMPTY;
  }
}

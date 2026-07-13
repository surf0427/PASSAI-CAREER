/**
 * Data Spine — server-only feature flags / canary allowlist readers（P17-C §10）。
 *
 * server-only。code default OFF。allowlist default empty。secret / 実 user ID を書かない。
 * 今回いずれの flag も ON にしない（env は空 / 未設定のまま）。
 */

import 'server-only';

// ── Layer 4 ─────────────────────────────────────────────────────────
export function isAggregatedInsightReadEnabled(): boolean {
  return process.env.CAREER_AGGREGATED_INSIGHT_READ_ENABLED === 'true';
}
export function isAggregatedInsightConsultationEnabled(): boolean {
  return process.env.CAREER_AGGREGATED_INSIGHT_CONSULTATION_ENABLED === 'true';
}
export function aggregatedInsightCanaryAllowlist(): string {
  return process.env.CAREER_AGGREGATED_INSIGHT_CANARY_USER_IDS ?? '';
}

// ── Layer 5 ─────────────────────────────────────────────────────────
export function isCompanyKnowledgeReadEnabled(): boolean {
  return process.env.CAREER_COMPANY_KNOWLEDGE_READ_ENABLED === 'true';
}
export function isCompanyKnowledgeResearchEnabled(): boolean {
  return process.env.CAREER_COMPANY_KNOWLEDGE_RESEARCH_ENABLED === 'true';
}
export function companyKnowledgeCanaryAllowlist(): string {
  return process.env.CAREER_COMPANY_KNOWLEDGE_CANARY_USER_IDS ?? '';
}

/** flag 変数名の一覧（.env.example / operator packet 用・値は含めない）。 */
export const DATA_SPINE_FLAG_NAMES: readonly string[] = [
  'CAREER_AGGREGATED_INSIGHT_READ_ENABLED',
  'CAREER_AGGREGATED_INSIGHT_CONSULTATION_ENABLED',
  'CAREER_AGGREGATED_INSIGHT_CANARY_USER_IDS',
  'CAREER_COMPANY_KNOWLEDGE_READ_ENABLED',
  'CAREER_COMPANY_KNOWLEDGE_RESEARCH_ENABLED',
  'CAREER_COMPANY_KNOWLEDGE_CANARY_USER_IDS',
];

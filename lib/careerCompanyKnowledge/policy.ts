/**
 * Company Knowledge (Layer 5) — policy 定数（P17-A §6・全て offline / PROVISIONAL）。
 *
 * 法務・consent・retention・commercial 範囲を **コードで確定しない**。閾値は PROVISIONAL。
 * production 非接続: DB / API / AI / prompt / private research へ接続しない。
 */

import type {
  CompanyContentCategory,
  ModerationRejectionReason,
} from '@/types/careerCompanyKnowledge';

/** policy 値の確定状態。 */
export type CompanyKnowledgePolicyStatus = 'PROVISIONAL' | 'FIXED';

/** freshness 分類の境界（observedPeriod → 経過月）。全て PROVISIONAL。 */
export type FreshnessPolicy = {
  freshWithinMonths: number;
  agingWithinMonths: number;
  status: CompanyKnowledgePolicyStatus;
};

export const FRESHNESS_POLICY: FreshnessPolicy = {
  freshWithinMonths: 12, // 1 選考年以内
  agingWithinMonths: 30, // それ以降は aging→stale
  status: 'PROVISIONAL',
};

/** read projection の境界制約（過剰情報を返さない）。PROVISIONAL。 */
export type ReadProjectionPolicy = {
  maxEvidencePerCompany: number;
  maxSummaryChars: number;
  status: CompanyKnowledgePolicyStatus;
};

export const READ_PROJECTION_POLICY: ReadProjectionPolicy = {
  maxEvidencePerCompany: 8,
  maxSummaryChars: 240,
  status: 'PROVISIONAL',
};

/**
 * general trend として扱うのに必要な独立裏付け件数（PROVISIONAL）。
 * これ未満は single_report 扱いで「一般傾向」表示にしない。
 */
export const MIN_CORROBORATION_FOR_TREND = 2;

/** projection へ **決して**出してはいけない contributor 実体 field（default-deny の明示）。 */
export const PROHIBITED_CONTRIBUTOR_FIELDS: readonly string[] = [
  'contributorName',
  'name',
  'email',
  'university',
  'faculty',
  'applicationId',
  'authUserId',
  'userId',
  'user_id',
  '__contributorOpaqueKey',
  '__contentFingerprint',
];

/** purpose ごとに許可する content category（過剰情報の抑止）。 */
export const PURPOSE_CONTENT_ALLOWLIST: Record<string, readonly CompanyContentCategory[]> = {
  consultation: ['selection_flow', 'briefing_note', 'desired_candidate_profile', 'general_note'],
  company_research: [
    'selection_flow',
    'briefing_note',
    'desired_candidate_profile',
    'es_question',
    'interview_question',
    'general_note',
  ],
  es_generation: ['es_question', 'desired_candidate_profile'],
  interview_practice: ['interview_question', 'selection_flow', 'desired_candidate_profile'],
};

/** legal / consent で確定が必要な論点（コードで結論を出さない）。 */
export const LEGAL_REVIEW_TOPICS: readonly string[] = [
  'explicit_share_consent_text',
  'confidential_information_definition',
  'defamation_and_third_party_rights',
  'retention_period',
  'contribution_revoke_obligation',
  'commercial_utilization_scope',
  'minor_contributor_handling',
];

/** moderation rejection 理由の単一 source。 */
export const MODERATION_REJECTION_REASONS: readonly ModerationRejectionReason[] = [
  'contains_pii',
  'confidential_information',
  'defamatory',
  'off_topic',
  'unverifiable',
  'spam',
  'legal_hold',
];

// ── P17-B 追加: corroboration / trend policy（PROVISIONAL）──────────────
/** independent contributor 数 → bucket 境界（PROVISIONAL・法務/実データ未確認）。 */
export type CorroborationPolicy = {
  few: number; // >= few で 'few'
  several: number; // >= several で 'several'
  many: number; // >= many で 'many'
  status: CompanyKnowledgePolicyStatus;
};

export const CORROBORATION_BUCKETS: CorroborationPolicy = {
  few: 2,
  several: 3,
  many: 5,
  status: 'PROVISIONAL',
};

/** publish を許可する confidentiality（low のみ。medium/high/prohibited/unknown は不可）。 */
export const PUBLISHABLE_CONFIDENTIALITY: readonly string[] = ['low'];

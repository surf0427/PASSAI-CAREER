/**
 * Consent Ledger — policy manifest / 定数（P14-C）。
 *
 * scope 単位の現在必要 policy version を宣言する manifest。version は **development policy** であり
 * 法的 version 確定ではない（status=PROVISIONAL / legalReview=REQUIRED）。
 *
 * production 非接続: 定数のみ。DB / API / UI / Supabase / matching 非接続。
 */

import { CONSENT_SCOPES } from '@/lib/careerAggregate/policy';
import type {
  ConsentAction,
  ConsentPolicyManifest,
  ConsentPolicyManifestEntry,
  ConsentScope,
} from '@/types/careerConsent';

/** 既知 action（unknown は ledger build で拒否）。 */
export const KNOWN_CONSENT_ACTIONS: readonly ConsentAction[] = [
  'consent_granted',
  'consent_withdrawn',
  'consent_reconfirmed',
  'consent_policy_superseded',
  'account_deletion_requested',
  'account_deleted',
];

/** grant / reconfirm 時に version / notice / digest が必須の action。 */
export const VERSION_REQUIRING_ACTIONS: readonly ConsentAction[] = [
  'consent_granted',
  'consent_reconfirmed',
];

/** ledger event に混入してはいけない evidence field（allowlist の裏返し・二重防御）。 */
export const PROHIBITED_EVIDENCE_FIELDS: readonly string[] = [
  'ip',
  'ipAddress',
  'userAgent',
  'ua',
  'deviceFingerprint',
  'fingerprint',
  'location',
  'geo',
  'preciseLocation',
  'reason',
  'freeText',
  'note',
  'comment',
  'rawPolicy',
  'policyText',
  'noticeText',
  'termsText',
  'headers',
  'userInput',
  'email',
  'displayName',
];

export const LEGAL_REVIEW_REQUIRED = 'LEGAL_REVIEW_REQUIRED' as const;

/** 法務確認事項（コードで法的結論を確定しない）。 */
export const CONSENT_LEGAL_REVIEW_TOPICS: readonly string[] = [
  'explicit_opt_in_required_scope',
  'anonymized_or_pseudonymized_classification',
  'required_consent_evidence_fields',
  'ip_or_user_agent_retention_necessity',
  'contribution_removal_before_withdrawal',
  'aggregate_recompute_after_account_deletion',
  'consent_ledger_retention',
  'consent_evidence_retention_after_deletion',
  'backup_deletion',
  'minor_consent',
  'reconsent_requirement_on_policy_change',
  'internal_vs_user_facing_legal_difference',
  'closed_aggregate_handling',
  'external_sharing_scope',
];

// development policy 値（法的 version 確定ではない）。
const DEV_VERSION = 'p14c-dev-1';
const DIGEST_PREFIX = 'sha256:dev-';

function entry(
  scope: ConsentScope,
  over: Partial<ConsentPolicyManifestEntry>,
): ConsentPolicyManifestEntry {
  return {
    scope,
    requiredVersion: 1,
    developmentVersion: DEV_VERSION,
    noticeVersion: 'notice-dev-1',
    purposeSummaryVersion: 'purpose-dev-1',
    policyDigest: `${DIGEST_PREFIX}${scope}`,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    status: 'PROVISIONAL',
    legalReview: 'REQUIRED',
    optionality: 'optional',
    normalFeatureAccessDependency: false,
    historicalBackfill: 'prohibited',
    aggregateAudience: null,
    supersededVersions: [],
    usableInLayer4: true,
    ...over,
  };
}

/**
 * 既定 manifest（development policy・PROVISIONAL）。
 * user_facing と ai_context は **別 version 管理**（混同しない）。
 * company_knowledge_contribution は Layer 5 のため Layer 4 で usableInLayer4=false。
 */
export const DEFAULT_CONSENT_MANIFEST: ConsentPolicyManifest = {
  personal_service_processing: entry('personal_service_processing', {
    optionality: 'required',
    normalFeatureAccessDependency: true,
    aggregateAudience: null,
    usableInLayer4: false, // aggregate ではない（通常処理）
  }),
  internal_aggregated_analytics: entry('internal_aggregated_analytics', {
    aggregateAudience: 'internal',
  }),
  user_facing_aggregated_insight: entry('user_facing_aggregated_insight', {
    aggregateAudience: 'user_facing',
  }),
  ai_context_aggregated_insight: entry('ai_context_aggregated_insight', {
    aggregateAudience: 'ai_context',
    // AI scope は user-facing とは別 version 系列（例として dev 版を分ける余地を明示）。
    developmentVersion: 'p14c-dev-ai-1',
    purposeSummaryVersion: 'purpose-ai-dev-1',
  }),
  externally_shared_insight: entry('externally_shared_insight', {
    aggregateAudience: null,
    legalReview: 'REQUIRED',
  }),
  company_knowledge_contribution: entry('company_knowledge_contribution', {
    aggregateAudience: null,
    usableInLayer4: false, // Layer 5 境界
  }),
};

/** manifest から scope の entry を取得（未知 scope は undefined）。 */
export function manifestEntry(
  scope: ConsentScope,
  manifest: ConsentPolicyManifest = DEFAULT_CONSENT_MANIFEST,
): ConsentPolicyManifestEntry | undefined {
  return manifest[scope];
}

/** 全 scope（careerAggregate の CONSENT_SCOPES と同一 source）。 */
export const CONSENT_LEDGER_SCOPES: readonly ConsentScope[] = CONSENT_SCOPES;

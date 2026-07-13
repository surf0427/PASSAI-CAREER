/**
 * Company Knowledge (Layer 5) — contribution 契約 helper（P17-A §6.2）。
 *
 * contribution の content fingerprint 生成（dedup 用）・share eligibility 判定・
 * 最小 validation を提供する。contributor 実体情報は保持しない（型に存在しない）。
 * pure・決定論（Date.now / Math.random 非使用）。
 */

import type {
  CompanyKnowledgeContribution,
} from '@/types/careerCompanyKnowledge';

// ── fnv1a（決定論・依存なし。revision.ts と同方式の軽量 hash）──────────────
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // 32bit unsigned hex。
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 構造化 field を安定文字列へ（区切りの曖昧さを避けるため配列 JSON）。 */
function stableKey(parts: readonly (string | null)[]): string {
  return JSON.stringify(parts.map((p) => (p ?? '')));
}

/** bodySummary の正規化（fingerprint 安定化用・空白畳み込み + lower）。 */
export function normalizeSummary(text: string): string {
  if (typeof text !== 'string') return '';
  return text.trim().toLowerCase().replace(/　/g, ' ').replace(/\s+/g, ' ');
}

/**
 * dedup 用 content fingerprint を生成する（pure・決定論）。
 * company（resolved のみ id、そうでなければ status 文字列）+ カテゴリ + 正規化本文 + 時期 + 区分。
 */
export function buildContentFingerprint(input: {
  companyKey: string; // resolved companyId or 'ambiguous'/'unresolved'
  contentCategory: string;
  bodySummary: string;
  observedPeriod: string;
  selectionCategory: string;
  roleCategory: string;
}): string {
  return fnv1a(
    stableKey([
      input.companyKey,
      input.contentCategory,
      normalizeSummary(input.bodySummary),
      input.observedPeriod,
      input.selectionCategory,
      input.roleCategory,
    ]),
  );
}

/** contribution から company key（resolved は id、それ以外は status）を得る。 */
export function contributionCompanyKey(c: CompanyKnowledgeContribution): string {
  return c.company.status === 'resolved' ? c.company.companyId : c.company.status;
}

/** contribution の fingerprint を再計算する（保存済み __contentFingerprint の検証にも使う）。 */
export function computeContributionFingerprint(c: CompanyKnowledgeContribution): string {
  return buildContentFingerprint({
    companyKey: contributionCompanyKey(c),
    contentCategory: c.contentCategory,
    bodySummary: c.bodySummary,
    observedPeriod: c.observedPeriod,
    selectionCategory: c.selectionCategory,
    roleCategory: c.roleCategory,
  });
}

export type ContributionValidationReason =
  | 'missing_observed_period'
  | 'empty_body_summary'
  | 'missing_privacy_classification'
  | 'fingerprint_mismatch';

export type ContributionValidationResult =
  | { ok: true }
  | { ok: false; reason: ContributionValidationReason };

/**
 * 最小 validation（pure）。observedPeriod 必須 / bodySummary 非空 /
 * privacy classification 固定 / fingerprint 整合。
 */
export function validateContribution(
  c: CompanyKnowledgeContribution,
): ContributionValidationResult {
  if (typeof c.observedPeriod !== 'string' || c.observedPeriod.trim() === '') {
    return { ok: false, reason: 'missing_observed_period' };
  }
  if (typeof c.bodySummary !== 'string' || c.bodySummary.trim() === '') {
    return { ok: false, reason: 'empty_body_summary' };
  }
  if (c.privacyClassification !== 'shared_company_knowledge') {
    return { ok: false, reason: 'missing_privacy_classification' };
  }
  if (computeContributionFingerprint(c) !== c.__contentFingerprint) {
    return { ok: false, reason: 'fingerprint_mismatch' };
  }
  return { ok: true };
}

/**
 * 明示共有の eligibility（consent 面のみ・moderation は別 module）。
 * share_granted かつ未撤回・未 exclude のみ true。private / not_shared / revoked は false。
 */
export function isShareConsentEligible(c: CompanyKnowledgeContribution): boolean {
  if (c.__excluded === true) return false;
  return c.consentState === 'share_granted';
}

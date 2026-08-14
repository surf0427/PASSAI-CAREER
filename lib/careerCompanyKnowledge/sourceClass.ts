// PASSAI CAREER — Layer 5 の **source class** と明示共有の admission gate
// （Collective Intelligence Closure / `D-C4`）。
//
// Human 指示 §14〜§16 に対応する:
//   - source class を型で区別する（private research を共有候補と同じ型で扱わない）
//   - private research → shared KB の昇格には **全条件の連言**を要求する
//   - 「暗黙同意」を同意として扱わない
//
// ★ 既存 module との関係（再実装しない）:
//   - consent 状態     : `contribution.isShareConsentEligible`
//   - PII scan         : `pii.isPiiResultPublishable` / `ContributionModeration.piiScan`
//   - moderation 可読性 : `moderation.evaluateModerationReadable`
//   - lifecycle        : `lifecycle.ts` の遷移表
//   本 module はそれらを **1 つの連言 gate** にまとめ、抜け道を作らないことを保証する。
//
// pure / deterministic / never-throw。I/O・env 非依存。

import type {
  CompanyKnowledgeContribution,
  ContributionLifecycleState,
} from '@/types/careerCompanyKnowledge';
import { isShareConsentEligible } from './contribution';
import { evaluateModerationReadable } from './moderation';

// ── Source class（Human 指示 §14）──────────────────────────────────
export type CompanyKnowledgeSourceClass =
  /** 本人が自分のために保存した企業研究。**共有禁止が default**。 */
  | 'PRIVATE_PERSONAL_RESEARCH'
  /** 本人が明示的に共有を許可した寄与（まだ moderation 前でありうる）。 */
  | 'USER_SHARED_CONTRIBUTION'
  /** 将来: official / public source からの取り込み（現在 **実装なし**）。 */
  | 'VERIFIED_PUBLIC_SOURCE'
  /** moderation を通過し published になった shared knowledge。 */
  | 'MODERATED_SHARED_KNOWLEDGE';

export const COMPANY_KNOWLEDGE_SOURCE_CLASSES: readonly CompanyKnowledgeSourceClass[] = [
  'PRIVATE_PERSONAL_RESEARCH',
  'USER_SHARED_CONTRIBUTION',
  'VERIFIED_PUBLIC_SOURCE',
  'MODERATED_SHARED_KNOWLEDGE',
];

/** 現時点で **実装が存在する** source class（`VERIFIED_PUBLIC_SOURCE` は型のみ）。 */
export const IMPLEMENTED_SOURCE_CLASSES: readonly CompanyKnowledgeSourceClass[] = [
  'PRIVATE_PERSONAL_RESEARCH',
  'USER_SHARED_CONTRIBUTION',
  'MODERATED_SHARED_KNOWLEDGE',
];

/** shared KB の read consumer へ出してよい class（**published のみ**）。 */
export function isPubliclyReadableSourceClass(cls: CompanyKnowledgeSourceClass): boolean {
  return cls === 'MODERATED_SHARED_KNOWLEDGE';
}

/**
 * contribution の現在の source class を導出する（pure）。
 *
 * ★ 判定は保守的。consent / moderation / lifecycle のどれかでも公開水準に達していなければ
 *   `MODERATED_SHARED_KNOWLEDGE` にはならない。
 */
export function classifyContributionSourceClass(
  c: CompanyKnowledgeContribution,
): CompanyKnowledgeSourceClass {
  if (!c || typeof c !== 'object') return 'PRIVATE_PERSONAL_RESEARCH';
  if (c.__excluded === true || c.legalHold === true) return 'PRIVATE_PERSONAL_RESEARCH';
  if (!isShareConsentEligible(c)) return 'PRIVATE_PERSONAL_RESEARCH';
  const published = c.lifecycleState === 'published';
  const readable = evaluateModerationReadable(c.moderation).readable;
  if (published && readable) return 'MODERATED_SHARED_KNOWLEDGE';
  return 'USER_SHARED_CONTRIBUTION';
}

// ── 暗黙同意の禁止（Human 指示 §16）────────────────────────────────
/**
 * **共有同意として扱ってはいけない** signal の明示リスト。
 * ここに載る signal は `evaluateSharingAdmission` が consent として一切参照しない。
 */
export const NON_CONSENT_SIGNALS: readonly string[] = [
  'app_usage',
  'company_research_saved',
  'ai_generation_used',
  'general_terms_accepted',
  'privacy_policy_accepted',
  'event_log_present',
  'personal_memory_consent',
  'personal_service_processing_consent',
  'ambiguous_ui_action',
  'implied_by_continued_use',
];

/**
 * 与えられた signal が共有同意になりうるか。
 * ★ 常に false を返す（暗黙同意は存在しない）。呼び出し側の誤用を型と QA で検出するための API。
 */
export function isImpliedConsentAcceptable(signal: string): false {
  // signal の値に依存しない（どんな signal でも同意にならない）。引数は呼び出し意図の明示のみ。
  void signal;
  return false;
}

// ── 明示共有の admission gate（Human 指示 §15）──────────────────────
export type SharingDenialReason =
  | 'not_authenticated'
  | 'no_explicit_sharing_consent'
  | 'consent_policy_version_unsupported'
  | 'ineligible_content'
  | 'pii_not_scrubbed'
  | 'missing_provenance'
  | 'moderation_not_passed'
  | 'legal_hold'
  | 'excluded';

export type SharingAdmission =
  | { admitted: true; sourceClass: 'USER_SHARED_CONTRIBUTION' | 'MODERATED_SHARED_KNOWLEDGE' }
  | { admitted: false; reasons: readonly SharingDenialReason[] };

export type SharingAdmissionInput = {
  contribution: CompanyKnowledgeContribution;
  /** server auth 由来の認証済みか（client 申告ではない）。 */
  authenticated: boolean;
  /** 本人の明示同意 record が現在有効か（consent ledger の導出結果）。 */
  explicitSharingConsentActive: boolean;
  /** その同意の policy version がサポート対象か（未知/古いは deny）。 */
  consentPolicyVersionSupported: boolean;
  /** publish 水準まで要求するか（read 経路は true、寄与受付は false）。 */
  requirePublished?: boolean;
};

/**
 * private research → shared KB への昇格可否（**全条件の連言**）。
 *
 * ```text
 * authenticated user
 *   AND explicit sharing consent（有効かつサポート version）
 *   AND eligible content（validation 済みの構造化 summary）
 *   AND PII scrub（clean のみ。not_scanned は不可）
 *   AND provenance（provenanceNote または evidenceKind 由来の追跡情報）
 *   AND moderation state（approved 以上）
 * ```
 *
 * 1 つでも欠ければ `NO CONTRIBUTION`。**理由をすべて返す**（最初の 1 件で打ち切らない）
 * ので、運用側が「あと何が足りないか」を一度に把握できる。
 */
export function evaluateSharingAdmission(input: SharingAdmissionInput): SharingAdmission {
  const reasons: SharingDenialReason[] = [];
  const c = input?.contribution;

  if (!c || typeof c !== 'object') {
    return { admitted: false, reasons: ['ineligible_content'] };
  }
  if (c.__excluded === true) reasons.push('excluded');
  if (c.legalHold === true) reasons.push('legal_hold');

  // 1. authenticated（server auth 由来のみ。client 申告 userId は入力に存在しない）。
  if (input.authenticated !== true) reasons.push('not_authenticated');

  // 2. explicit sharing consent（暗黙同意は一切参照しない）。
  if (input.explicitSharingConsentActive !== true || !isShareConsentEligible(c)) {
    reasons.push('no_explicit_sharing_consent');
  }
  if (input.consentPolicyVersionSupported !== true) {
    reasons.push('consent_policy_version_unsupported');
  }

  // 3. eligible content（構造化 summary が存在し、privacy classification が固定値）。
  const hasSummary = typeof c.bodySummary === 'string' && c.bodySummary.trim() !== '';
  const hasPeriod = typeof c.observedPeriod === 'string' && c.observedPeriod.trim() !== '';
  if (!hasSummary || !hasPeriod || c.privacyClassification !== 'shared_company_knowledge') {
    reasons.push('ineligible_content');
  }

  // 4. PII scrub（★ `not_scanned` は安全ではない。`clean` のみ通す）。
  if (c.moderation?.piiScan !== 'clean') reasons.push('pii_not_scrubbed');

  // 5. provenance（由来が追えないものは公開しない）。
  const hasProvenance =
    (typeof c.provenanceNote === 'string' && c.provenanceNote.trim() !== '') ||
    (typeof c.evidenceKind === 'string' && (c.evidenceKind as string).trim() !== '');
  if (!hasProvenance) reasons.push('missing_provenance');

  // 6. moderation（approved 以上。pending / rejected / blocked は不可）。
  if (!evaluateModerationReadable(c.moderation).readable) reasons.push('moderation_not_passed');

  if (reasons.length > 0) {
    // 決定論順（QA が順序に依存できるように）。
    return { admitted: false, reasons: [...new Set(reasons)].sort() };
  }

  const published: ContributionLifecycleState | undefined = c.lifecycleState;
  if (input.requirePublished === true && published !== 'published') {
    return { admitted: false, reasons: ['moderation_not_passed'] };
  }
  return {
    admitted: true,
    sourceClass: published === 'published' ? 'MODERATED_SHARED_KNOWLEDGE' : 'USER_SHARED_CONTRIBUTION',
  };
}

/**
 * ★ private personal research を「そのまま」共有候補へ変換する経路が存在しないことを
 *   型レベルで示すための marker。
 *
 * private research（`CareerCompanyResearchLog`）から contribution を作るには、
 * ユーザーが UI 上で明示的に共有内容を作成する必要がある。
 * 本 repo には `CareerCompanyResearchLog -> CompanyKnowledgeContribution` の
 * 自動変換関数は **存在しない**（QA `CI-8` が静的に固定する）。
 */
export const NO_AUTO_SHARE_FROM_PRIVATE_RESEARCH = true as const;

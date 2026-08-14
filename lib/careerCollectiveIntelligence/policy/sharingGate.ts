// PASSAI CAREER — 共有の **二段 gate** と撤回挙動（Policy Freeze / `D-P4`）。
//
// Human 指示 §8 / §9:
//   sharing master opt-in AND per-contribution confirmation の **両方**を要求する。
//   どちらか一つ欠ければ `NO CONTRIBUTION`。
//   consent family は Personal Optimization と共有しない。
//
// ★ 既存 `evaluateSharingAdmission`（`careerCompanyKnowledge/sourceClass.ts`）との関係:
//   あちらは「その contribution が公開水準に達しているか」（PII / provenance / moderation を含む）。
//   本 module は **その手前**の「そもそも共有してよい人・してよい 1 件か」を、
//   承認済み policy に照らして判定する。両方を通らなければ寄与にならない。
//
// pure / deterministic / never-throw。

import {
  SHARING_POLICY,
  WITHDRAWAL_POLICY,
  withdrawalDispositionFor,
  isPolicyVersionSupported,
  CURRENT_POLICY_VERSION,
  type WithdrawalDisposition,
  type WithdrawalSubjectState,
} from './registry';
import { consentPurposeFamily } from '@/lib/careerConsent/purposeRegistry';

// ── 二段 gate ───────────────────────────────────────────────────────
export type SharingStageDenial =
  | 'master_opt_in_missing'
  | 'per_contribution_confirmation_missing'
  | 'unsupported_policy_version'
  | 'wrong_consent_family'
  | 'implied_consent_rejected';

export type SharingStageDecision =
  | { allowed: true; policyVersion: number }
  | { allowed: false; reasons: readonly SharingStageDenial[] };

export type SharingStageInput = {
  /** master opt-in: `company_knowledge_contribution` scope への明示同意が有効か。 */
  masterOptInActive: boolean;
  /** その同意の scope（family 検証に使う）。 */
  consentScope: string;
  /** per-item: この contribution 個別の共有確認が取れているか。 */
  perContributionConfirmed: boolean;
  /** 同意時の policy version。 */
  policyVersion?: number;
  /**
   * 「暗黙同意」を根拠にしていないか。
   * ここに値が入っていたら **拒否**（H-L4 の禁止事項）。
   */
  impliedConsentSource?: string | null;
};

/**
 * 共有の二段 gate（**両方必須**）。
 *
 * ★ 片方だけでは決して通らない。QA `PF-4` / `PF-5` が両方向を固定する。
 */
export function evaluateSharingStages(input: SharingStageInput): SharingStageDecision {
  const reasons: SharingStageDenial[] = [];
  const version = input?.policyVersion ?? CURRENT_POLICY_VERSION;

  if (!isPolicyVersionSupported(version)) reasons.push('unsupported_policy_version');

  // 1 段目: master opt-in。
  if (SHARING_POLICY.requireMasterOptIn && input?.masterOptInActive !== true) {
    reasons.push('master_opt_in_missing');
  }
  // ★ consent family が Personal Optimization と共有されていないこと。
  const family = consentPurposeFamily(input?.consentScope ?? '');
  if (family !== SHARING_POLICY.sharingConsentFamily) {
    reasons.push('wrong_consent_family');
  }
  // 2 段目: per-contribution confirmation。
  if (
    SHARING_POLICY.requirePerContributionConfirmation &&
    input?.perContributionConfirmed !== true
  ) {
    reasons.push('per_contribution_confirmation_missing');
  }
  // 暗黙同意は根拠にできない。
  const implied = input?.impliedConsentSource;
  if (typeof implied === 'string' && implied.trim() !== '') {
    reasons.push('implied_consent_rejected');
  }

  return reasons.length === 0
    ? { allowed: true, policyVersion: version }
    : { allowed: false, reasons: [...new Set(reasons)].sort() };
}

/** 承認済み policy が拒否する「暗黙同意の出所」か。 */
export function isRejectedImpliedConsentSource(source: string): boolean {
  return (SHARING_POLICY.rejectedImpliedConsentSources as readonly string[]).includes(source);
}

// ── 撤回 ────────────────────────────────────────────────────────────
export type WithdrawalPlan = {
  state: WithdrawalSubjectState | 'unknown';
  disposition: WithdrawalDisposition;
  /** legal 未承認のために保守側へ倒したか（監査用）。 */
  conservativeFallbackApplied: boolean;
  /** 以後の寄与が止まるか（**常に true**。構造的保証）。 */
  futureContributionsBlocked: true;
};

/**
 * 撤回時の挙動を計画する（**legal 未承認なら最も保守的な挙動**）。
 *
 * ★ `derived_multi_source` は本来 `legal_policy_gate`（法務判断）。
 *   legal 未承認の間は **自動 retain を production behavior にしない**という指示に従い、
 *   可逆な `unpublish` へ倒す（削除は不可逆なので選ばない）。
 */
export function planWithdrawal(input: {
  state: string;
  legalApproved: boolean;
}): WithdrawalPlan {
  const known = (Object.keys(WITHDRAWAL_POLICY.rules) as WithdrawalSubjectState[]).includes(
    input?.state as WithdrawalSubjectState,
  );
  const raw = (WITHDRAWAL_POLICY.rules as Record<string, WithdrawalDisposition>)[input?.state]
    ?? 'legal_policy_gate';
  const disposition = withdrawalDispositionFor(input?.state ?? '', input?.legalApproved === true);
  return {
    state: known ? (input.state as WithdrawalSubjectState) : 'unknown',
    disposition,
    conservativeFallbackApplied: raw === 'legal_policy_gate' && input?.legalApproved !== true,
    futureContributionsBlocked: true,
  };
}

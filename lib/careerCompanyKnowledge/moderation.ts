/**
 * Company Knowledge (Layer 5) — moderation / privacy / confidentiality gate（P17-A §6.3）。
 *
 * fail-closed の pure policy。外部 moderation API は使わない。
 *
 * read 可否の必要条件（すべて満たすときのみ readable）:
 *   - moderation.state === 'approved'
 *   - piiScan === 'clean'（not_scanned / pii_detected は不可）
 *   - confidentiality ∈ {low}（unknown / elevated / restricted は不可）
 *   - abuse !== 'upheld'
 *
 * → pending / unknown / not_scanned を「安全」と見なさない。
 */

import type {
  ContributionModeration,
  ModerationRejectionReason,
} from '@/types/careerCompanyKnowledge';

export type ModerationBlockReason =
  | 'not_approved'
  | 'pii_not_clean'
  | 'confidentiality_not_cleared'
  | 'abuse_upheld';

export type ModerationReadDecision =
  | { readable: true }
  | { readable: false; reason: ModerationBlockReason };

/** read projection へ出してよいか（fail-closed・pure）。 */
export function evaluateModerationReadable(
  m: ContributionModeration,
): ModerationReadDecision {
  if (!m || typeof m !== 'object') return { readable: false, reason: 'not_approved' };
  if (m.state !== 'approved') return { readable: false, reason: 'not_approved' };
  if (m.piiScan !== 'clean') return { readable: false, reason: 'pii_not_clean' };
  if (m.confidentiality !== 'low') return { readable: false, reason: 'confidentiality_not_cleared' };
  if (m.abuse === 'upheld') return { readable: false, reason: 'abuse_upheld' };
  return { readable: true };
}

export type ModerationDecisionInput = {
  approve: boolean;
  piiScanned: boolean;
  piiFound: boolean;
  confidentiality: ContributionModeration['confidentiality'];
  abuse: ContributionModeration['abuse'];
  rejectionReason?: ModerationRejectionReason | null;
};

/**
 * moderation 決定を適用して新しい moderation 状態を返す（pure・不変更新）。
 * approve=false は rejected（理由必須運用）。piiFound / restricted 等は自動的に非 approved へ。
 */
export function applyModerationDecision(
  input: ModerationDecisionInput,
): ContributionModeration {
  const piiScan: ContributionModeration['piiScan'] = !input.piiScanned
    ? 'not_scanned'
    : input.piiFound
      ? 'pii_detected'
      : 'clean';

  // 明示 reject / PII 検出 / confidentiality 未 low / abuse upheld は approved にしない。
  const canApprove =
    input.approve &&
    piiScan === 'clean' &&
    input.confidentiality === 'low' &&
    input.abuse !== 'upheld';

  const state: ContributionModeration['state'] = input.abuse === 'upheld'
    ? 'blocked'
    : canApprove
      ? 'approved'
      : 'rejected';

  const rejectionReason: ModerationRejectionReason | null =
    state === 'approved'
      ? null
      : (input.rejectionReason ??
          (piiScan === 'pii_detected'
            ? 'contains_pii'
            : input.confidentiality !== 'low'
              ? 'confidential_information'
              : input.abuse === 'upheld'
                ? 'legal_hold'
                : 'unverifiable'));

  return {
    state,
    piiScan,
    confidentiality: input.confidentiality,
    abuse: input.abuse,
    rejectionReason,
  };
}

/** pending の初期 moderation（安全 default・fail-closed）。 */
export function initialModeration(): ContributionModeration {
  return {
    state: 'pending',
    piiScan: 'not_scanned',
    confidentiality: 'unknown',
    abuse: 'none',
    rejectionReason: null,
  };
}

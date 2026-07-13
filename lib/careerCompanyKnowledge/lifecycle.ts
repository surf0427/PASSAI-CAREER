/**
 * Company Knowledge (Layer 5) — contribution lifecycle state machine（P17-B §4）。
 *
 * offline・pure・決定論。不正 transition を拒否し、consent / privacy / moderation の
 * 前提を型と遷移表で強制する。
 *
 * 正常フロー:
 *   draft --submit--> consent_pending --grant_consent--> submitted
 *   --start_privacy_review--> privacy_review --pass_privacy_review--> moderation_pending
 *   --start_moderation(任意)--> moderation_pending --approve--> approved --publish--> published
 *
 * 分岐:
 *   privacy_review --fail_privacy_review--> rejected
 *   moderation_pending --reject--> rejected
 *   (publish 前) --withdraw--> revoked / published --revoke--> revoked
 *   (非 terminal) --block--> blocked / --legal_hold--> legal_hold
 *   legal_hold --release_legal_hold--> moderation_pending（再審査）
 *   {approved, published} --expire--> expired
 */

import type {
  ContributionLifecycleAction,
  ContributionLifecycleState,
  LifecycleRejectReason,
  LifecycleTransitionResult,
} from '@/types/careerCompanyKnowledge';

const TERMINAL: ReadonlySet<ContributionLifecycleState> = new Set([
  'rejected',
  'revoked',
  'expired',
  'blocked',
]);

// from → action → to（許可遷移のみ）。
const TABLE: Record<ContributionLifecycleState, Partial<Record<ContributionLifecycleAction, ContributionLifecycleState>>> = {
  draft: { submit: 'consent_pending', block: 'blocked', legal_hold: 'legal_hold', withdraw: 'revoked' },
  consent_pending: { grant_consent: 'submitted', withdraw: 'revoked', block: 'blocked', legal_hold: 'legal_hold' },
  submitted: { start_privacy_review: 'privacy_review', withdraw: 'revoked', block: 'blocked', legal_hold: 'legal_hold' },
  privacy_review: {
    pass_privacy_review: 'moderation_pending',
    fail_privacy_review: 'rejected',
    withdraw: 'revoked',
    block: 'blocked',
    legal_hold: 'legal_hold',
  },
  moderation_pending: {
    start_moderation: 'moderation_pending',
    approve: 'approved',
    reject: 'rejected',
    withdraw: 'revoked',
    block: 'blocked',
    legal_hold: 'legal_hold',
  },
  approved: {
    publish: 'published',
    withdraw: 'revoked',
    expire: 'expired',
    block: 'blocked',
    legal_hold: 'legal_hold',
  },
  published: { revoke: 'revoked', expire: 'expired', block: 'blocked', legal_hold: 'legal_hold' },
  legal_hold: { release_legal_hold: 'moderation_pending', block: 'blocked' },
  // terminal
  rejected: {},
  revoked: {},
  blocked: {},
  expired: {},
};

/** 不正遷移の理由を具体化する（監査・デバッグ用）。 */
function refineReason(
  from: ContributionLifecycleState,
  action: ContributionLifecycleAction,
): LifecycleRejectReason {
  if (TERMINAL.has(from)) return 'terminal_state';
  if (action === 'publish' && from !== 'approved') {
    return from === 'submitted' || from === 'consent_pending' ? 'consent_required' : 'moderation_incomplete';
  }
  if (action === 'approve' && from !== 'moderation_pending') return 'privacy_review_incomplete';
  if (action === 'grant_consent' && from !== 'consent_pending') return 'invalid_transition';
  return 'invalid_transition';
}

/** lifecycle transition を評価する（pure）。 */
export function transitionContributionLifecycle(
  from: ContributionLifecycleState,
  action: ContributionLifecycleAction,
): LifecycleTransitionResult {
  const to = TABLE[from]?.[action];
  if (!to) return { ok: false, from, reason: refineReason(from, action) };
  return { ok: true, from, to };
}

/** published state か（read projection の唯一の許可 lifecycle）。 */
export function isPublishedLifecycle(state: ContributionLifecycleState | undefined): boolean {
  return state === 'published';
}

/** read 対象外（revoked / blocked / legal_hold / expired / rejected など）か。 */
export function isReadExcludedLifecycle(state: ContributionLifecycleState | undefined): boolean {
  if (state === undefined) return false; // 未設定は P17-A gate に委譲
  return state !== 'published';
}

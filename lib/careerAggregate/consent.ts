/**
 * Consent eligibility — pure 判定（P14-B / P14-A §Consent policy Option C）。
 *
 * DB / UI / 永続化は作らない。**pure function と型だけ**。後続実装（P14-C Consent Ledger）が
 * そのまま使える eligibility 契約を先に固定する。
 *
 * 原則:
 *   - default deny。required scope を明示 grant した場合のみ eligible の可能性が出る。
 *   - privacy notice 閲覧・利用規約包括同意・personal processing だけでは aggregate へ eligible にしない。
 *   - version mismatch / withdrawal 後 / account 削除 / grant 前 event は ineligible。
 *   - Layer 5（company_knowledge_contribution）は Layer 4 では決して満たさない。
 */

import {
  AUDIENCE_REQUIRED_SCOPE,
  CURRENT_CONSENT_POLICY_VERSION,
  LAYER5_ONLY_SCOPE,
} from './policy';
import type {
  AggregateAudience,
  ConsentEligibilityResult,
  ConsentRecord,
  ConsentScope,
} from '@/types/careerAggregate';

function ineligible(
  status: ConsentEligibilityResult['status'],
  requiredScope: ConsentScope,
): ConsentEligibilityResult {
  return { eligible: false, status, requiredScope };
}

/**
 * audience 由来の required scope に対する consent eligibility を判定する（pure）。
 *
 * @param input.consent          対象ユーザーの consent 状態
 * @param input.audience         aggregate 用途（→ required scope へ写像）
 * @param input.eventOccurredAt  対象 event の occurred_at（epoch ms）
 * @param input.requiredVersion  必要 consent policy version（既定は現行 version）
 */
export function evaluateConsentEligibility(input: {
  consent: ConsentRecord | null | undefined;
  audience: AggregateAudience;
  eventOccurredAt: number;
  requiredVersion?: number;
}): ConsentEligibilityResult {
  const requiredVersion = input.requiredVersion ?? CURRENT_CONSENT_POLICY_VERSION;
  const requiredScope = AUDIENCE_REQUIRED_SCOPE[input.audience];

  // audience が既知 3 種以外（＝required scope 不明）は unsupported purpose。
  if (!requiredScope) return ineligible('unsupported_purpose', LAYER5_ONLY_SCOPE);

  const consent = input.consent;
  if (!consent || typeof consent !== 'object') return ineligible('missing_consent', requiredScope);

  // account 削除は最優先で ineligible。
  if (consent.accountDeleted === true) return ineligible('account_deleted', requiredScope);

  // 明示 opt-out は missing_consent 扱い。
  if (consent.optedOut === true) return ineligible('missing_consent', requiredScope);

  const granted = Array.isArray(consent.grantedScopes) ? consent.grantedScopes : [];

  // Layer 5 scope は Layer 4 の required にならない（防御的・二重確認）。
  if (requiredScope === LAYER5_ONLY_SCOPE) return ineligible('unsupported_purpose', requiredScope);

  // required scope を明示 grant していない → scope 不足。
  //   何も grant していない場合は missing_consent、他 scope だけの場合は scope_mismatch。
  if (!granted.includes(requiredScope)) {
    return granted.length === 0
      ? ineligible('missing_consent', requiredScope)
      : ineligible('scope_mismatch', requiredScope);
  }

  // version mismatch。
  if (consent.version !== requiredVersion) return ineligible('version_mismatch', requiredScope);

  // grant timestamp 不明。
  if (typeof consent.grantedAt !== 'number' || !Number.isFinite(consent.grantedAt)) {
    return ineligible('invalid_timestamp', requiredScope);
  }

  // event timestamp 不正。
  if (typeof input.eventOccurredAt !== 'number' || !Number.isFinite(input.eventOccurredAt)) {
    return ineligible('invalid_timestamp', requiredScope);
  }

  // event が consent grant より前に発生 → 目的外。
  if (input.eventOccurredAt < consent.grantedAt) return ineligible('granted_after_event', requiredScope);

  // withdrawal 済みで、event が withdrawal 時点以降に発生 → ineligible。
  if (
    typeof consent.withdrawnAt === 'number' &&
    Number.isFinite(consent.withdrawnAt) &&
    input.eventOccurredAt >= consent.withdrawnAt
  ) {
    return ineligible('withdrawn_before_event', requiredScope);
  }

  return { eligible: true, status: 'eligible', requiredScope };
}

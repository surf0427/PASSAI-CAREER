/**
 * Consent Ledger — 本人向け consent receipt view model（P14-C）。
 *
 * UI へは接続しない pure contract。内部専用 field（ledger event id / idempotency key /
 * server sequence / raw user id / actor id / IP / device fingerprint / raw policy text）は含めない。
 */

import { DEFAULT_CONSENT_MANIFEST, manifestEntry } from './policy';
import { CONSENT_LEDGER_SCOPES } from './policy';
import type {
  ConsentPolicyManifest,
  ConsentReceipt,
  ConsentReceiptEntry,
  DerivedConsentState,
} from '@/types/careerConsent';

/**
 * 導出状態から consent receipt を作る（pure）。normal features は aggregate consent 有無に
 * 影響されないため常に unaffected=true。
 */
export function buildConsentReceipt(input: {
  state: DerivedConsentState;
  manifest?: ConsentPolicyManifest;
}): ConsentReceipt {
  const manifest = input.manifest ?? DEFAULT_CONSENT_MANIFEST;
  const entries: ConsentReceiptEntry[] = [];

  for (const scope of CONSENT_LEDGER_SCOPES) {
    const s = input.state.byScope[scope];
    const m = manifestEntry(scope, manifest);
    entries.push({
      scope,
      status: s.status,
      consentVersion: s.consentVersion,
      noticeVersion: s.noticeVersion,
      grantedAt: s.grantedAt,
      withdrawnAt: s.withdrawnAt,
      lastUpdatedAt: s.lastUpdatedAt,
      sourceSurface: null, // 内部 event の surface を receipt へは複製しない（将来は集約表示）
      legalReviewStatus: m?.legalReview ?? 'REQUIRED',
      currentPolicyVersion: m?.developmentVersion ?? 'unknown',
      reconsentRequired: s.reconsentRequired,
      normalFeaturesUnaffected: true,
    });
  }

  return { entries, accountStatus: input.state.accountStatus };
}

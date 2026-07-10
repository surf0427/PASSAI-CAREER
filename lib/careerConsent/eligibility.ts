/**
 * Consent Ledger → P14-B aggregate eligibility adapter（P14-C）。
 *
 * 論理フロー:
 *   Consent Ledger events
 *   → server-order validation（reducer 内）
 *   → scope state reducer
 *   → current policy manifest comparison
 *   → ledger-derived consent state
 *   → P14-B evaluateConsentEligibility（raw boolean を渡さない）
 *
 * P14-B の eligibility 関数を **置き換えず**、ledger を入力 source として利用する明示 adapter。
 * production aggregate pipeline へは接続しない。default true 禁止・missing/invalid はineligible。
 */

import { evaluateConsentEligibility } from '@/lib/careerAggregate/consent';
import { AUDIENCE_REQUIRED_SCOPE } from '@/lib/careerAggregate/policy';
import { DEFAULT_CONSENT_MANIFEST, manifestEntry } from './policy';
import { deriveConsentState } from './reducer';
import type { AggregateAudience, ConsentRecord } from '@/types/careerAggregate';
import type {
  ConsentLedgerEvent,
  ConsentPolicyManifest,
  ConsentScope,
  ConsentStateStatus,
  LedgerEligibilityResult,
} from '@/types/careerConsent';

function isoToMs(iso: string | null): number | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function shortCircuit(
  status: string,
  requiredScope: ConsentScope,
  ledgerStatus: ConsentStateStatus,
): LedgerEligibilityResult {
  return { eligible: false, status, requiredScope, ledgerStatus };
}

/**
 * ledger event 列（1 subject）から aggregate eligibility を判定する（pure adapter）。
 *
 * @param input.events          subject の全 ledger event
 * @param input.audience        aggregate 用途（→ required scope）
 * @param input.eventOccurredAt 対象 aggregate event の occurred_at（epoch ms）
 * @param input.now             現在時刻（epoch ms）
 * @param input.manifest        policy manifest（既定 DEFAULT_CONSENT_MANIFEST）
 */
export function adaptLedgerEligibility(input: {
  events: readonly ConsentLedgerEvent[];
  audience: AggregateAudience;
  eventOccurredAt: number;
  now: number;
  manifest?: ConsentPolicyManifest;
}): LedgerEligibilityResult {
  const manifest = input.manifest ?? DEFAULT_CONSENT_MANIFEST;
  const requiredScope = AUDIENCE_REQUIRED_SCOPE[input.audience];
  const entry = manifestEntry(requiredScope, manifest);

  // Layer 5 / Layer 4 非対象 scope は決して eligible にしない。
  if (!entry || !entry.usableInLayer4) {
    return shortCircuit('unsupported_purpose', requiredScope, 'never_granted');
  }

  const state = deriveConsentState({ events: input.events, now: input.now, manifest });
  const scopeState = state.byScope[requiredScope];
  const ledgerStatus = scopeState.status;

  // ledger 固有の ineligible は short-circuit（raw boolean を作らない）。
  if (state.invalidLedger || ledgerStatus === 'invalid_ledger') {
    return shortCircuit('invalid_ledger', requiredScope, 'invalid_ledger');
  }
  if (ledgerStatus === 'account_deleted') {
    return shortCircuit('account_deleted', requiredScope, 'account_deleted');
  }
  if (ledgerStatus === 'account_deletion_pending') {
    return shortCircuit('account_deletion_pending', requiredScope, 'account_deletion_pending');
  }

  // ledger-derived state を P14-B ConsentRecord へ写像（grant がある status のみ scope を積む）。
  const hasGrantHistory =
    ledgerStatus === 'active' || ledgerStatus === 'version_outdated' || ledgerStatus === 'withdrawn';
  const consent: ConsentRecord = {
    grantedScopes: hasGrantHistory ? [requiredScope] : [],
    version: scopeState.consentVersion ?? -1,
    grantedAt: isoToMs(scopeState.grantedAt),
    withdrawnAt: isoToMs(scopeState.withdrawnAt),
    accountDeleted: false,
    optedOut: false,
  };

  const result = evaluateConsentEligibility({
    consent,
    audience: input.audience,
    eventOccurredAt: input.eventOccurredAt,
    requiredVersion: entry.requiredVersion,
  });

  return {
    eligible: result.eligible,
    status: result.status,
    requiredScope: result.requiredScope,
    ledgerStatus,
  };
}

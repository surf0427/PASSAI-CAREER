/**
 * Consent Ledger — pure state reducer（P14-C）。
 *
 * append-only event 列（1 subject 分）から scope 単位の現在状態を導出する。
 * mutable boolean を source of truth にしない。event を mutation しない。
 *
 * 状態: never_granted / active / withdrawn / version_outdated /
 *       account_deletion_pending / account_deleted / invalid_ledger。
 */

import { CONSENT_LEDGER_SCOPES, DEFAULT_CONSENT_MANIFEST } from './policy';
import { validateOrdering } from './ledger';
import { dropIdempotentDuplicates } from './idempotency';
import type {
  ConsentLedgerEvent,
  ConsentPolicyManifest,
  ConsentScope,
  DerivedConsentState,
  ScopeConsentState,
} from '@/types/careerConsent';

type RuntimeAccount = 'active' | 'deletion_pending' | 'deleted';

function emptyScopeState(scope: ConsentScope, requiredVersion: number): ScopeConsentState {
  return {
    scope,
    status: 'never_granted',
    consentVersion: null,
    noticeVersion: null,
    grantedAt: null,
    withdrawnAt: null,
    lastUpdatedAt: null,
    reconsentRequired: false,
    requiredVersion,
  };
}

function reduceScope(
  sorted: readonly ConsentLedgerEvent[],
  scope: ConsentScope,
  manifest: ConsentPolicyManifest,
  invalidLedger: boolean,
): ScopeConsentState {
  const entry = manifest[scope];
  const requiredVersion = entry?.requiredVersion ?? 1;
  const state = emptyScopeState(scope, requiredVersion);
  if (invalidLedger) {
    state.status = 'invalid_ledger';
    return state;
  }

  let grantVersion: number | null = null;
  let supersededAfterGrant = false;
  let runtimeAccount: RuntimeAccount = 'active';

  for (const e of sorted) {
    // account 系は runtime account state を更新（scope 横断）。
    if (e.action === 'account_deleted') {
      runtimeAccount = 'deleted';
      state.lastUpdatedAt = e.effectiveAt;
      continue;
    }
    if (e.action === 'account_deletion_requested') {
      if (runtimeAccount !== 'deleted') runtimeAccount = 'deletion_pending';
      state.lastUpdatedAt = e.effectiveAt;
      continue;
    }

    if (e.scope !== scope) continue;

    // 削除済みでは grant / reconfirm を受け付けない。
    if (runtimeAccount === 'deleted') continue;

    switch (e.action) {
      case 'consent_granted':
      case 'consent_reconfirmed': {
        // 削除保留中は新規 eligibility を生まない（grant を active 化しない）。
        if (runtimeAccount === 'deletion_pending') break;
        grantVersion = e.consentVersion;
        supersededAfterGrant = false;
        state.consentVersion = e.consentVersion;
        state.noticeVersion = e.noticeVersion;
        state.grantedAt = e.effectiveAt;
        state.withdrawnAt = null; // 新 grant は以前の withdrawal を解消
        state.lastUpdatedAt = e.effectiveAt;
        break;
      }
      case 'consent_withdrawn': {
        if (grantVersion !== null) state.withdrawnAt = e.effectiveAt;
        state.lastUpdatedAt = e.effectiveAt;
        break;
      }
      case 'consent_policy_superseded': {
        if (grantVersion !== null) supersededAfterGrant = true;
        state.lastUpdatedAt = e.effectiveAt;
        break;
      }
      default:
        break;
    }
  }

  // account overlay を最優先で反映。
  if (runtimeAccount === 'deleted') {
    state.status = 'account_deleted';
    return state;
  }
  if (runtimeAccount === 'deletion_pending') {
    state.status = 'account_deletion_pending';
    return state;
  }

  if (grantVersion === null) {
    state.status = 'never_granted';
  } else if (state.withdrawnAt !== null) {
    state.status = 'withdrawn';
  } else if (
    supersededAfterGrant ||
    grantVersion !== requiredVersion ||
    (entry?.supersededVersions ?? []).includes(grantVersion)
  ) {
    state.status = 'version_outdated';
    state.reconsentRequired = true;
  } else {
    state.status = 'active';
  }
  return state;
}

/**
 * 1 subject の event 列から現在状態を導出する（pure）。
 * @param input.events   同一 subject の全 ledger event（順不同でよい・serverSequence で整列）
 * @param input.now      現在時刻（epoch ms・future effective timestamp 検知用）
 * @param input.manifest policy manifest（既定は DEFAULT_CONSENT_MANIFEST）
 */
export function deriveConsentState(input: {
  events: readonly ConsentLedgerEvent[];
  now: number;
  manifest?: ConsentPolicyManifest;
}): DerivedConsentState {
  const manifest = input.manifest ?? DEFAULT_CONSENT_MANIFEST;
  const events = Array.isArray(input.events) ? input.events : [];
  const subjectPresent = events.length > 0;

  const ordering = validateOrdering(events, input.now);
  const invalidLedger = !ordering.ok;

  // retry 二重化を除去してから serverSequence 昇順で整列（入力順非依存）。
  const deduped = dropIdempotentDuplicates(events);
  const sorted = [...deduped].sort((a, b) => a.serverSequence - b.serverSequence);

  // account 全体状態（overlay とは別に公開する）。
  let accountStatus: DerivedConsentState['accountStatus'] = 'active';
  for (const e of sorted) {
    if (e.action === 'account_deleted') accountStatus = 'deleted';
    else if (e.action === 'account_deletion_requested' && accountStatus !== 'deleted') {
      accountStatus = 'deletion_pending';
    }
  }

  const byScope = {} as Record<ConsentScope, ScopeConsentState>;
  for (const scope of CONSENT_LEDGER_SCOPES) {
    byScope[scope] = reduceScope(sorted, scope, manifest, invalidLedger);
  }

  return { subjectPresent, accountStatus, invalidLedger, byScope };
}

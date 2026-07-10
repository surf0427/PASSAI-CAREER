/*
 * scripts/fixtures/careerConsentFixtures.ts
 *
 * PASSAI CAREER — Consent Ledger synthetic fixtures（P14-C・dev-only）。
 *
 * 実データ・DB・Supabase を使わない pure な synthetic event 生成ヘルパ。
 * synthetic subject id はテスト内部だけで使い、receipt / aggregate へは残さない（QA で検証）。
 * 実在人物・実在メール・実在企業・実在 IP は使用しない。
 */

import { ACCOUNT_SCOPE } from '@/types/careerConsent';
import type {
  ConsentAction,
  ConsentLedgerEvent,
  ConsentScope,
  LedgerScope,
} from '@/types/careerConsent';

export const NOW = Date.parse('2026-07-10T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** now から daysAgo 日前の ISO（決定論）。 */
export function iso(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY).toISOString();
}

export const UF: ConsentScope = 'user_facing_aggregated_insight';
export const AI: ConsentScope = 'ai_context_aggregated_insight';
export const PERSONAL: ConsentScope = 'personal_service_processing';
export const INTERNAL: ConsentScope = 'internal_aggregated_analytics';
export const COMPANY_KB: ConsentScope = 'company_knowledge_contribution';

let seqCounter = 0;

/** 完全形の ledger event を作る（reducer / repository へ直接投入可能）。 */
export function ev(
  subject: string,
  action: ConsentAction,
  over: Partial<ConsentLedgerEvent> & { seq?: number; scope?: LedgerScope } = {},
): ConsentLedgerEvent {
  const seq = over.seq ?? ++seqCounter;
  const isAccount = action === 'account_deletion_requested' || action === 'account_deleted';
  const scope: LedgerScope = over.scope ?? (isAccount ? ACCOUNT_SCOPE : UF);
  const versioned = action === 'consent_granted' || action === 'consent_reconfirmed';
  const scopeStr = String(scope);
  return {
    ledgerEventId: over.ledgerEventId ?? `le-${subject}-${seq}`,
    subjectUserId: subject,
    scope,
    action,
    consentVersion: over.consentVersion !== undefined ? over.consentVersion : versioned ? 1 : null,
    noticeVersion: over.noticeVersion !== undefined ? over.noticeVersion : versioned ? 'notice-dev-1' : null,
    policyDigest: over.policyDigest !== undefined ? over.policyDigest : versioned ? `sha256:dev-${scopeStr}` : null,
    serverSequence: seq,
    recordedAt: over.recordedAt ?? over.effectiveAt ?? iso(30),
    effectiveAt: over.effectiveAt ?? iso(30),
    sourceSurface: over.sourceSurface ?? 'settings',
    idempotencyKey: over.idempotencyKey ?? `idem-${subject}-${action}-${scopeStr}-${seq}`,
    actorType: over.actorType ?? 'user',
    legalReviewMarker: over.legalReviewMarker ?? null,
    provenance: over.provenance,
  };
}

/** 便利ビルダ（scope / seq / effective を指定しやすく）。 */
export const grant = (subject: string, over: Parameters<typeof ev>[2] = {}) => ev(subject, 'consent_granted', over);
export const withdraw = (subject: string, over: Parameters<typeof ev>[2] = {}) => ev(subject, 'consent_withdrawn', over);
export const reconfirm = (subject: string, over: Parameters<typeof ev>[2] = {}) => ev(subject, 'consent_reconfirmed', over);
export const superseded = (subject: string, over: Parameters<typeof ev>[2] = {}) => ev(subject, 'consent_policy_superseded', over);
export const deletionRequested = (subject: string, over: Parameters<typeof ev>[2] = {}) => ev(subject, 'account_deletion_requested', over);
export const deleted = (subject: string, over: Parameters<typeof ev>[2] = {}) => ev(subject, 'account_deleted', over);

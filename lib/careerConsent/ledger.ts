/**
 * Consent Ledger — event build 検証 + server-authoritative ordering 検証（P14-C）。
 *
 * append-only。event の mutation はしない。client timestamp は権威にせず serverSequence を最優先。
 * evidence field（IP / user agent / device fingerprint / free-text reason / raw policy text）は拒否。
 *
 * pure。DB / Supabase / UI 非依存。
 */

import {
  KNOWN_CONSENT_ACTIONS,
  PROHIBITED_EVIDENCE_FIELDS,
  VERSION_REQUIRING_ACTIONS,
} from './policy';
import { ACCOUNT_SCOPE } from '@/types/careerConsent';
import type {
  ConsentAction,
  ConsentLedgerEvent,
  LedgerEventBuildResult,
  LedgerScope,
  OrderingIssue,
  OrderingValidation,
} from '@/types/careerConsent';

const KNOWN_ACTION_SET: ReadonlySet<string> = new Set(KNOWN_CONSENT_ACTIONS);
const VERSION_REQUIRING_SET: ReadonlySet<string> = new Set(VERSION_REQUIRING_ACTIONS);
const PROHIBITED_SET: ReadonlySet<string> = new Set(PROHIBITED_EVIDENCE_FIELDS);

function parseIso(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * 未検証の raw 入力から ledger event を構築する（pure・default deny）。
 * prohibited evidence field が **1 つでも**あれば拒否する（本文複製の遮断）。
 */
export function buildLedgerEvent(raw: unknown, now: number): LedgerEventBuildResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'unknown_action' };
  }
  const r = raw as Record<string, unknown>;

  // prohibited evidence field は allowlist ではなく明示拒否（混入を build 段で止める）。
  for (const key of Object.keys(r)) {
    if (PROHIBITED_SET.has(key)) return { ok: false, reason: 'prohibited_evidence_field' };
  }

  const action = r.action;
  if (typeof action !== 'string' || !KNOWN_ACTION_SET.has(action)) {
    return { ok: false, reason: 'unknown_action' };
  }

  const scope = r.scope;
  if (typeof scope !== 'string') return { ok: false, reason: 'missing_scope' };

  if (typeof r.serverSequence !== 'number' || !Number.isFinite(r.serverSequence)) {
    return { ok: false, reason: 'missing_server_sequence' };
  }

  const effectiveMs = parseIso(r.effectiveAt);
  if (effectiveMs === null) return { ok: false, reason: 'invalid_effective_timestamp' };
  if (effectiveMs > now) return { ok: false, reason: 'invalid_effective_timestamp' };

  // grant / reconfirm は version / notice / digest 必須。
  if (VERSION_REQUIRING_SET.has(action)) {
    if (typeof r.consentVersion !== 'number' || !Number.isFinite(r.consentVersion)) {
      return { ok: false, reason: 'missing_version' };
    }
    if (typeof r.noticeVersion !== 'string' || r.noticeVersion === '') {
      return { ok: false, reason: 'missing_notice_version' };
    }
    if (typeof r.policyDigest !== 'string' || r.policyDigest === '') {
      return { ok: false, reason: 'missing_policy_digest' };
    }
  }

  const event: ConsentLedgerEvent = {
    ledgerEventId: typeof r.ledgerEventId === 'string' ? r.ledgerEventId : '',
    subjectUserId: typeof r.subjectUserId === 'string' ? r.subjectUserId : '',
    scope: scope as LedgerScope,
    action: action as ConsentAction,
    consentVersion: typeof r.consentVersion === 'number' ? r.consentVersion : null,
    noticeVersion: typeof r.noticeVersion === 'string' ? r.noticeVersion : null,
    policyDigest: typeof r.policyDigest === 'string' ? r.policyDigest : null,
    serverSequence: r.serverSequence,
    recordedAt: typeof r.recordedAt === 'string' ? r.recordedAt : new Date(now).toISOString(),
    effectiveAt: r.effectiveAt as string,
    sourceSurface: typeof r.sourceSurface === 'string' ? r.sourceSurface : 'unspecified',
    idempotencyKey: typeof r.idempotencyKey === 'string' ? r.idempotencyKey : '',
    actorType:
      r.actorType === 'system' || r.actorType === 'legal' || r.actorType === 'import'
        ? r.actorType
        : 'user',
    legalReviewMarker: r.legalReviewMarker === 'LEGAL_REVIEW_REQUIRED' ? 'LEGAL_REVIEW_REQUIRED' : null,
    provenance: typeof r.provenance === 'string' ? r.provenance : undefined,
  };
  return { ok: true, event };
}

/** account 系 event か（subject-level）。 */
export function isAccountEvent(e: ConsentLedgerEvent): boolean {
  return e.scope === ACCOUNT_SCOPE || e.action === 'account_deletion_requested' || e.action === 'account_deleted';
}

// 同一 sequence の conflict 判定用の payload 署名（意味的 field のみ）。
function payloadSignature(e: ConsentLedgerEvent): string {
  return JSON.stringify([e.scope, e.action, e.consentVersion, e.noticeVersion, e.policyDigest, e.effectiveAt]);
}

/**
 * server-authoritative ordering を検証する（pure）。
 *   - serverSequence が非有限 → non_finite_sequence
 *   - effectiveAt 不正 → invalid_effective_timestamp / 未来 → future_effective_timestamp
 *   - 同一 sequence・異なる payload → conflicting_sequence
 *   - 同一 sequence・同一 payload → duplicate_sequence（冪等・致命ではない）
 * gap（欠番）は許容する。
 */
export function validateOrdering(
  events: readonly ConsentLedgerEvent[],
  now: number,
): OrderingValidation {
  const issues = new Set<OrderingIssue>();
  const bySeq = new Map<number, string>();

  for (const e of events) {
    if (typeof e.serverSequence !== 'number' || !Number.isFinite(e.serverSequence)) {
      issues.add('non_finite_sequence');
      continue;
    }
    const ms = parseIso(e.effectiveAt);
    if (ms === null) issues.add('invalid_effective_timestamp');
    else if (ms > now) issues.add('future_effective_timestamp');

    const sig = payloadSignature(e);
    const existing = bySeq.get(e.serverSequence);
    if (existing === undefined) bySeq.set(e.serverSequence, sig);
    else if (existing === sig) issues.add('duplicate_sequence');
    else issues.add('conflicting_sequence');
  }

  // 致命的 issue（reducer が invalid_ledger にすべきもの）。duplicate_sequence は致命ではない。
  const fatal: OrderingIssue[] = ['conflicting_sequence', 'non_finite_sequence', 'invalid_effective_timestamp', 'future_effective_timestamp'];
  const hasFatal = fatal.some((f) => issues.has(f));
  return { ok: !hasFatal, issues: Array.from(issues) };
}

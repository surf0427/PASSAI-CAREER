/*
 * scripts/career-consent-ledger-qa.ts
 *
 * PASSAI CAREER — Consent Ledger event model QA（P14-C・A. Ledger Model）。
 *
 * 何を守るか（P14-C §7 / §22-A）:
 *   - append-only event の build 検証: scope / version / notice / digest / server sequence 必須。
 *   - unknown action 拒否 / invalid・future effective timestamp 拒否。
 *   - prohibited evidence field（IP / user agent / device fingerprint / free-text reason / raw policy）拒否。
 *   - internal-only field の一覧が定義されている。
 *
 * 使い方: npx tsx scripts/career-consent-ledger-qa.ts
 */

import { buildLedgerEvent } from '@/lib/careerConsent/ledger';
import { LEDGER_INTERNAL_ONLY_FIELDS } from '@/types/careerConsent';
import { NOW, iso } from './fixtures/careerConsentFixtures';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const validGrant = {
  action: 'consent_granted',
  scope: 'user_facing_aggregated_insight',
  consentVersion: 1,
  noticeVersion: 'notice-dev-1',
  policyDigest: 'sha256:dev-user_facing_aggregated_insight',
  serverSequence: 1,
  effectiveAt: iso(10),
  idempotencyKey: 'idem-1',
};

console.log('[1] valid build');
{
  const r = buildLedgerEvent(validGrant, NOW);
  check('valid grant → ok', r.ok === true);
  const w = buildLedgerEvent({ action: 'consent_withdrawn', scope: 'user_facing_aggregated_insight', serverSequence: 2, effectiveAt: iso(5), idempotencyKey: 'idem-2' }, NOW);
  check('withdrawal（version 不要）→ ok', w.ok === true);
}

console.log('[2] required fields');
{
  check('unknown action → unknown_action', buildLedgerEvent({ ...validGrant, action: 'nope' }, NOW).ok === false);
  check('missing scope → missing_scope', (() => { const g = { ...validGrant } as Record<string, unknown>; delete g.scope; const r = buildLedgerEvent(g, NOW); return !r.ok && r.reason === 'missing_scope'; })());
  check('grant missing version → missing_version', (() => { const g = { ...validGrant } as Record<string, unknown>; delete g.consentVersion; const r = buildLedgerEvent(g, NOW); return !r.ok && r.reason === 'missing_version'; })());
  check('grant missing notice → missing_notice_version', (() => { const g = { ...validGrant } as Record<string, unknown>; delete g.noticeVersion; const r = buildLedgerEvent(g, NOW); return !r.ok && r.reason === 'missing_notice_version'; })());
  check('grant missing digest → missing_policy_digest', (() => { const g = { ...validGrant } as Record<string, unknown>; delete g.policyDigest; const r = buildLedgerEvent(g, NOW); return !r.ok && r.reason === 'missing_policy_digest'; })());
  check('missing server sequence → missing_server_sequence', (() => { const g = { ...validGrant } as Record<string, unknown>; delete g.serverSequence; const r = buildLedgerEvent(g, NOW); return !r.ok && r.reason === 'missing_server_sequence'; })());
}

console.log('[3] timestamp');
{
  check('invalid effectiveAt → invalid_effective_timestamp', (() => { const r = buildLedgerEvent({ ...validGrant, effectiveAt: 'not-a-date' }, NOW); return !r.ok && r.reason === 'invalid_effective_timestamp'; })());
  check('future effectiveAt → invalid_effective_timestamp', (() => { const r = buildLedgerEvent({ ...validGrant, effectiveAt: new Date(NOW + 86400000).toISOString() }, NOW); return !r.ok && r.reason === 'invalid_effective_timestamp'; })());
}

console.log('[4] prohibited evidence fields');
{
  for (const bad of ['ip', 'ipAddress', 'userAgent', 'deviceFingerprint', 'reason', 'rawPolicy', 'email', 'location']) {
    const r = buildLedgerEvent({ ...validGrant, [bad]: 'x' }, NOW);
    check(`${bad} 混入 → prohibited_evidence_field`, !r.ok && r.reason === 'prohibited_evidence_field');
  }
}

console.log('[5] internal-only fields 定義');
{
  check('ledgerEventId が internal-only', LEDGER_INTERNAL_ONLY_FIELDS.includes('ledgerEventId'));
  check('idempotencyKey が internal-only', LEDGER_INTERNAL_ONLY_FIELDS.includes('idempotencyKey'));
  check('serverSequence が internal-only', LEDGER_INTERNAL_ONLY_FIELDS.includes('serverSequence'));
  check('subjectUserId が internal-only', LEDGER_INTERNAL_ONLY_FIELDS.includes('subjectUserId'));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

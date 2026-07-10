/*
 * scripts/career-consent-eligibility-adapter-qa.ts
 *
 * PASSAI CAREER — Consent Ledger → P14-B aggregate eligibility adapter QA（P14-C・F）。
 *
 * 何を守るか（P14-C §14 / §22-F）:
 *   - missing / invalid ledger は ineligible。
 *   - current user-facing grant + event after grant は eligible。
 *   - AI scope なしで AI 利用不可 / user-facing と AI を混同しない。
 *   - grant 前 event（implicit backfill）は ineligible。
 *   - withdrawal 後 event は ineligible / withdrawal 前 event は eligible。
 *   - reconsent 後 event は eligible。
 *   - account deletion pending / deleted は ineligible。
 *   - Layer 5 scope を Layer 4 へ流用しない（manifest usableInLayer4=false）。
 *   - raw boolean を受け取らない（events を入力 source にする）。
 *
 * 使い方: npx tsx scripts/career-consent-eligibility-adapter-qa.ts
 */

import { adaptLedgerEligibility } from '@/lib/careerConsent/eligibility';
import { DEFAULT_CONSENT_MANIFEST } from '@/lib/careerConsent/policy';
import { grant, withdraw, reconfirm, deletionRequested, deleted, iso, NOW, UF, AI } from './fixtures/careerConsentFixtures';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) => NOW - daysAgo * DAY;
const uf = (events: Parameters<typeof adaptLedgerEligibility>[0]['events'], eventDaysAgo: number) =>
  adaptLedgerEligibility({ events, audience: 'user_facing', eventOccurredAt: at(eventDaysAgo), now: NOW });

console.log('[1] missing / invalid ledger');
{
  check('missing ledger → ineligible (missing_consent)', (() => { const r = uf([], 10); return !r.eligible && r.status === 'missing_consent'; })());
  const invalid = adaptLedgerEligibility({ events: [grant('u1', { seq: 1, effectiveAt: iso(20) }), withdraw('u1', { seq: 1, effectiveAt: iso(10) })], audience: 'user_facing', eventOccurredAt: at(10), now: NOW });
  check('invalid ledger → ineligible (invalid_ledger)', !invalid.eligible && invalid.status === 'invalid_ledger');
}

console.log('[2] active grant');
{
  const r = uf([grant('u1', { seq: 1, effectiveAt: iso(20) })], 10); // event after grant
  check('current UF grant + event after → eligible', r.eligible === true && r.status === 'eligible');
  check('ledgerStatus=active', r.ledgerStatus === 'active');
}

console.log('[3] scope separation');
{
  const eventsUF = [grant('u1', { seq: 1, scope: UF, effectiveAt: iso(20) })];
  const aiReq = adaptLedgerEligibility({ events: eventsUF, audience: 'ai_context', eventOccurredAt: at(10), now: NOW });
  check('UF grant のみで AI-context → ineligible', aiReq.eligible === false);
  check('AI required scope', aiReq.requiredScope === 'ai_context_aggregated_insight');

  // AI grant あり → AI eligible。
  const aiGrant = [grant('u1', { seq: 1, scope: AI, consentVersion: 1, noticeVersion: 'notice-dev-1', policyDigest: 'sha256:dev-ai_context_aggregated_insight', effectiveAt: iso(20) })];
  const aiOk = adaptLedgerEligibility({ events: aiGrant, audience: 'ai_context', eventOccurredAt: at(10), now: NOW });
  check('AI grant + event after → eligible', aiOk.eligible === true);
}

console.log('[4] backfill prohibited / withdrawal boundary');
{
  const beforeGrant = uf([grant('u1', { seq: 1, effectiveAt: iso(20) })], 25); // event 25d ago = before grant(20d)
  check('grant 前 event → ineligible (granted_after_event)', !beforeGrant.eligible && beforeGrant.status === 'granted_after_event');

  const events = [grant('u1', { seq: 1, effectiveAt: iso(30) }), withdraw('u1', { seq: 2, effectiveAt: iso(15) })];
  const afterWithdraw = uf(events, 10); // event 10d ago = after withdrawal(15d)
  check('withdrawal 後 event → ineligible (withdrawn_before_event)', !afterWithdraw.eligible && afterWithdraw.status === 'withdrawn_before_event');
  const beforeWithdraw = uf(events, 20); // event 20d ago = after grant(30d), before withdrawal(15d)
  check('withdrawal 前 event → eligible', beforeWithdraw.eligible === true);

  const reEvents = [grant('u1', { seq: 1, effectiveAt: iso(40) }), withdraw('u1', { seq: 2, effectiveAt: iso(30) }), reconfirm('u1', { seq: 3, effectiveAt: iso(20) })];
  const afterReconsent = uf(reEvents, 10);
  check('reconsent 後 event → eligible', afterReconsent.eligible === true);
}

console.log('[5] account deletion');
{
  const pending = uf([grant('u1', { seq: 1, effectiveAt: iso(30) }), deletionRequested('u1', { seq: 2, effectiveAt: iso(20) })], 10);
  check('deletion pending → ineligible', !pending.eligible && pending.status === 'account_deletion_pending');
  const del = uf([grant('u1', { seq: 1, effectiveAt: iso(30) }), deleted('u1', { seq: 2, effectiveAt: iso(20) })], 10);
  check('deleted → ineligible', !del.eligible && del.status === 'account_deleted');
}

console.log('[6] Layer 5 separation');
{
  check('company_knowledge は Layer 4 で usableInLayer4=false', DEFAULT_CONSENT_MANIFEST.company_knowledge_contribution.usableInLayer4 === false);
  check('personal_service_processing も aggregate 非対象', DEFAULT_CONSENT_MANIFEST.personal_service_processing.usableInLayer4 === false);
  check('user_facing / ai_context は Layer 4 で利用可', DEFAULT_CONSENT_MANIFEST.user_facing_aggregated_insight.usableInLayer4 === true && DEFAULT_CONSENT_MANIFEST.ai_context_aggregated_insight.usableInLayer4 === true);
  check('UF と AI は別 developmentVersion（混同しない）', DEFAULT_CONSENT_MANIFEST.user_facing_aggregated_insight.developmentVersion !== DEFAULT_CONSENT_MANIFEST.ai_context_aggregated_insight.developmentVersion);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

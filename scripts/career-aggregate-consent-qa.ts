/*
 * scripts/career-aggregate-consent-qa.ts
 *
 * PASSAI CAREER — Aggregated Insight consent eligibility QA（P14-B・B. Consent）。
 *
 * 何を守るか（P14-A §Consent policy / Option C）:
 *   - required scope なし / personal のみ / opt-out / version mismatch / grant 前 / withdrawal 後 /
 *     account deleted / timestamp 不明 は ineligible。
 *   - user-facing scope あり かつ全条件充足なら eligible。
 *   - AI scope と user-facing scope を混同しない（purpose limitation）。
 *   - privacy notice 閲覧・personal processing だけを aggregate consent 扱いしない。
 *
 * 使い方: npx tsx scripts/career-aggregate-consent-qa.ts
 */

import { evaluateConsentEligibility } from '@/lib/careerAggregate/consent';
import { consent, EVENT_TS } from './fixtures/careerAggregateFixtures';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const at = Date.parse(EVENT_TS);
const evalUF = (c: ReturnType<typeof consent.fullUserFacing> | undefined) =>
  evaluateConsentEligibility({ consent: c, audience: 'user_facing', eventOccurredAt: at });

console.log('[1] eligible');
{
  const r = evalUF(consent.fullUserFacing());
  check('user-facing scope + 全条件充足 → eligible', r.eligible && r.status === 'eligible');
  check('required scope が user_facing', r.requiredScope === 'user_facing_aggregated_insight');

  const rw = evalUF(consent.withdrawnAfterEvent());
  check('withdrawal が event より後 → eligible', rw.eligible === true);
}

console.log('[2] ineligible');
{
  check('consent なし → missing_consent', evalUF(consent.none()).status === 'missing_consent');
  check('personal のみ → scope_mismatch', evalUF(consent.personalOnly()).status === 'scope_mismatch');
  check('AI scope のみ（user-facing 要求）→ scope_mismatch', evalUF(consent.aiOnly()).status === 'scope_mismatch');
  check('opt-out → missing_consent', evalUF(consent.optedOut()).status === 'missing_consent');
  check('version mismatch → version_mismatch', evalUF(consent.versionMismatch()).status === 'version_mismatch');
  check('grant が event より後 → granted_after_event', evalUF(consent.grantedAfterEvent()).status === 'granted_after_event');
  check('withdrawal が event より前 → withdrawn_before_event', evalUF(consent.withdrawnBeforeEvent()).status === 'withdrawn_before_event');
  check('account deleted → account_deleted', evalUF(consent.accountDeleted()).status === 'account_deleted');
  check('grant timestamp 不明 → invalid_timestamp', evalUF(consent.missingTimestamp()).status === 'invalid_timestamp');

  check('全 ineligible ケースで eligible=false', [
    consent.none(), consent.personalOnly(), consent.aiOnly(), consent.optedOut(),
    consent.versionMismatch(), consent.grantedAfterEvent(), consent.withdrawnBeforeEvent(),
    consent.accountDeleted(), consent.missingTimestamp(),
  ].every((c) => evalUF(c as never).eligible === false));
}

console.log('[3] purpose limitation（AI ≠ user-facing）');
{
  // user-facing 同意で AI-context を要求 → scope_mismatch（混同しない）。
  const aiReq = evaluateConsentEligibility({ consent: consent.fullUserFacing(), audience: 'ai_context', eventOccurredAt: at });
  check('user-facing 同意では AI-context 対象にならない', aiReq.status === 'scope_mismatch');
  check('AI-context の required scope が ai_context', aiReq.requiredScope === 'ai_context_aggregated_insight');

  // internal は internal scope が必要。
  const intReq = evaluateConsentEligibility({ consent: consent.fullUserFacing(), audience: 'internal', eventOccurredAt: at });
  check('user-facing 同意では internal 対象にならない', intReq.status === 'scope_mismatch');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

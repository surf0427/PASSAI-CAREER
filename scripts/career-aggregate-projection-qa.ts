/*
 * scripts/career-aggregate-projection-qa.ts
 *
 * PASSAI CAREER — Aggregated Insight (Layer 4) default-deny projection QA（P14-B・A. Field Allowlist）。
 *
 * 何を守るか（P14-A §Projection / Field allowlist）:
 *   - feature / event_type だけが直接残り、occurred_at は month bucket 化され exact は残らない。
 *   - prohibited field（score_band / company_id / metadata / weakness_category / next_action / 本文 /
 *     industry / job_type / selection_phase / exact timestamp / unknown key）は contribution へ流れない。
 *   - raw input を spread しない（injin した任意 key が contribution に現れない）。
 *   - unsupported feature / unsupported event_type / consent ineligible / excluded account は reject。
 *   - user_id は internal dedup 鍵としてのみ、client_event_id は duplicate 判定としてのみ保持。
 *
 * 使い方: npx tsx scripts/career-aggregate-projection-qa.ts
 * 終了コード: 全 PASS → 0 / FAIL → 1。
 */

import { projectAggregateContribution, toMonthBucket } from '@/lib/careerAggregate/projection';
import { evaluateConsentEligibility } from '@/lib/careerAggregate/consent';
import { FEATURE_USAGE_PREVALENCE } from '@/lib/careerAggregate/policy';
import { consent, mkEvent, EVENT_TS, TARGET_MONTH } from './fixtures/careerAggregateFixtures';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const metric = FEATURE_USAGE_PREVALENCE;
const eligible = evaluateConsentEligibility({
  consent: consent.fullUserFacing(),
  audience: 'user_facing',
  eventOccurredAt: Date.parse(EVENT_TS),
});

// contribution が持ってよい key（internal dedup 2 + allowlist 3）。
const ALLOWED_CONTRIB_KEYS = new Set([
  '__dedupUserKey',
  '__dedupEventKey',
  'feature',
  'eventType',
  'monthBucket',
]);

console.log('[1] allowlist projection');
{
  const raw = mkEvent('u1', {
    feature: 'interview',
    eventType: 'feature_completed',
    clientEventId: 'c-1',
    inject: {
      score_band: 'A',
      company_id: '11111111-1111-1111-1111-111111111111',
      metadata: { note: 'ES本文らしい長文がここに入る', count: 3 },
      weakness_category: '論理性',
      next_action: '面接練習',
      industry: 'IT',
      job_type: 'engineer',
      selection_phase: 'final',
      text: '自由記述の本文',
      university: 'A大学',
      created_at: '2026-05-15T09:00:01.000Z',
      id: 'row-123',
      evilUnknownKey: 'should-be-dropped',
    },
  });
  const res = projectAggregateContribution({ raw, eligibility: eligible, metric });
  check('eligible + valid → ok', res.ok === true);
  if (res.ok) {
    const keys = Object.keys(res.contribution);
    check('contribution key が allowlist のみ', keys.every((k) => ALLOWED_CONTRIB_KEYS.has(k)), keys.join(','));
    check('feature が残る', res.contribution.feature === 'interview');
    check('eventType が残る', res.contribution.eventType === 'feature_completed');
    check('occurred_at は month bucket 化', res.contribution.monthBucket === TARGET_MONTH);
    check('exact timestamp を持たない', !JSON.stringify(res.contribution).includes('09:00'));
    check('score_band が残らない', !('score_band' in res.contribution));
    check('company_id が残らない', !('company_id' in res.contribution));
    check('metadata が残らない', !('metadata' in res.contribution));
    check('weakness_category が残らない', !('weakness_category' in res.contribution));
    check('next_action が残らない', !('next_action' in res.contribution));
    check('industry / job_type / selection_phase が残らない', !('industry' in res.contribution) && !('job_type' in res.contribution) && !('selection_phase' in res.contribution));
    check('free text が残らない', !JSON.stringify(res.contribution).includes('本文'));
    check('unknown key を spread しない', !('evilUnknownKey' in res.contribution));
    check('user_id は internal dedup 鍵として保持', res.contribution.__dedupUserKey === 'u1');
    check('client_event_id は internal dedup 鍵として保持', res.contribution.__dedupEventKey === 'c-1');
  }
}

console.log('[2] reject paths');
{
  const ineligible = evaluateConsentEligibility({
    consent: consent.personalOnly(),
    audience: 'user_facing',
    eventOccurredAt: Date.parse(EVENT_TS),
  });
  const r1 = projectAggregateContribution({ raw: mkEvent('u1'), eligibility: ineligible, metric });
  check('consent ineligible → reject', !r1.ok && r1.reason === 'consent_ineligible');

  const r2 = projectAggregateContribution({
    raw: mkEvent('u1', { feature: 'not_a_feature' }),
    eligibility: eligible,
    metric,
  });
  check('unsupported feature → reject', !r2.ok && r2.reason === 'unsupported_feature');

  const r3 = projectAggregateContribution({
    raw: mkEvent('u1', { eventType: 'consultation_asked' }),
    eligibility: eligible,
    metric,
  });
  check('metric 非許可 event_type → reject', !r3.ok && r3.reason === 'unsupported_event_type');

  const r4 = projectAggregateContribution({
    raw: mkEvent('u1', { occurredAt: 'not-a-date' }),
    eligibility: eligible,
    metric,
  });
  check('invalid occurred_at → reject', !r4.ok && r4.reason === 'invalid_timestamp');

  const r5 = projectAggregateContribution({
    raw: mkEvent('u1'),
    eligibility: eligible,
    metric,
    accountType: 'bot',
  });
  check('bot account → reject', !r5.ok && r5.reason === 'excluded_account');

  const r6 = projectAggregateContribution({
    raw: mkEvent('', {}),
    eligibility: eligible,
    metric,
  });
  check('dedup 不能（user_id 空）→ reject', !r6.ok && r6.reason === 'malformed_input');
}

console.log('[3] toMonthBucket');
{
  check('ISO → YYYY-MM', toMonthBucket('2026-05-15T09:00:00Z') === '2026-05');
  check('epoch ms → YYYY-MM', toMonthBucket(Date.parse('2026-12-31T23:59:59Z')) === '2026-12');
  check('invalid → null', toMonthBucket('nope') === null);
  check('exact 情報を含まない', toMonthBucket('2026-05-15T09:00:00Z')!.length === 7);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

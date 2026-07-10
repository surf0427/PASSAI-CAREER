/*
 * scripts/career-aggregate-contribution-qa.ts
 *
 * PASSAI CAREER — Aggregated Insight contribution bounding QA（P14-B・D. Contribution）。
 *
 * 何を守るか（P14-A §Contribution）:
 *   - heavy user の 100 event が 1 contribution になる。
 *   - duplicate / retry（同一 client_event_id）を二重計上しない。
 *   - 同一 user × month × feature は 1 / 別 feature・別 month は別 contribution。
 *   - event count を user count へ変換しない。
 *   - bot / QA / internal は除外 / unknown event は除外。
 *
 * 使い方: npx tsx scripts/career-aggregate-contribution-qa.ts
 */

import { boundContributions, countUniqueUsersForFeature, countUniqueUsersInMonth } from '@/lib/careerAggregate/contribution';
import { runFeatureUsagePrevalence } from '@/lib/careerAggregate/pipeline';
import { baseInput, consent, mkEvent, usersEachOneEvent, TARGET_MONTH } from './fixtures/careerAggregateFixtures';
import type { InternalProjectedContribution } from '@/types/careerAggregate';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function contrib(user: string, feature: string, month: string, eventKey: string | null): InternalProjectedContribution {
  return { __dedupUserKey: user, __dedupEventKey: eventKey, feature: feature as InternalProjectedContribution['feature'], eventType: 'feature_completed', monthBucket: month };
}

console.log('[1] user-level boolean');
{
  // 同一 user × month × feature を 100 回。
  const many = Array.from({ length: 100 }, (_v, i) => contrib('u1', 'interview', TARGET_MONTH, `k-${i}`));
  const bounded = boundContributions(many);
  check('100 event → 1 boolean contribution', bounded.length === 1);
  check('user 数 1', countUniqueUsersForFeature(bounded, 'interview', TARGET_MONTH) === 1);
}

console.log('[2] duplicate / retry');
{
  // 同一 client_event_id（retry）。
  const dup = [contrib('u1', 'interview', TARGET_MONTH, 'same'), contrib('u1', 'interview', TARGET_MONTH, 'same')];
  check('duplicate client_event_id → 1', boundContributions(dup).length === 1);

  // 別 client_event_id でも同 user×month×feature なら boolean 1。
  const diffKey = [contrib('u1', 'interview', TARGET_MONTH, 'a'), contrib('u1', 'interview', TARGET_MONTH, 'b')];
  check('別 eventKey でも boolean 1', boundContributions(diffKey).length === 1);
}

console.log('[3] 分離（別 feature / 別 month は別 contribution）');
{
  const b = boundContributions([
    contrib('u1', 'interview', TARGET_MONTH, '1'),
    contrib('u1', 'es', TARGET_MONTH, '2'),
    contrib('u1', 'interview', '2026-06', '3'),
  ]);
  check('別 feature / 別 month は 3 contribution', b.length === 3);
  check('interview@month の user 数 1', countUniqueUsersForFeature(b, 'interview', TARGET_MONTH) === 1);
}

console.log('[4] event count ≠ user count');
{
  const b = boundContributions([
    contrib('u1', 'interview', TARGET_MONTH, '1'),
    contrib('u1', 'interview', TARGET_MONTH, '2'),
    contrib('u2', 'interview', TARGET_MONTH, '3'),
  ]);
  check('3 event / 2 user → unique user 2', countUniqueUsersInMonth(b, TARGET_MONTH) === 2);
  check('feature unique user 2', countUniqueUsersForFeature(b, 'interview', TARGET_MONTH) === 2);
}

console.log('[5] pipeline: 50 unique vs 1 heavy');
{
  const fifty = usersEachOneEvent(50, 'interview');
  const a = runFeatureUsagePrevalence(baseInput({ ...fifty }));
  check('50 unique user → valid denom 50', a.kind === 'valid' && a.denominator === 50);

  const heavy = Array.from({ length: 200 }, (_v, i) => mkEvent('solo', { feature: 'interview', clientEventId: `h-${i}` }));
  const b = runFeatureUsagePrevalence(baseInput({ events: heavy, consentByUser: { solo: consent.fullUserFacing() } }));
  check('200 event / 1 user → suppressed（支配しない）', b.kind === 'suppressed');
}

console.log('[6] bot / QA / internal / unknown 除外');
{
  const fifty = usersEachOneEvent(50, 'interview');
  // 51 人目を bot にしても denominator は 50 のまま（除外）。
  const withBot = {
    events: [...fifty.events, mkEvent('botUser', { feature: 'interview', clientEventId: 'b-1' })],
    consentByUser: { ...fifty.consentByUser, botUser: consent.fullUserFacing() },
    accountTypeByUser: { botUser: 'bot' },
  };
  const a = runFeatureUsagePrevalence(baseInput(withBot));
  check('bot account は寄与しない（denom 50）', a.kind === 'valid' && a.denominator === 50);

  // unknown event type は寄与しない。
  const withUnknown = {
    events: [...fifty.events, mkEvent('x', { feature: 'interview', eventType: 'not_a_type', clientEventId: 'x-1' })],
    consentByUser: { ...fifty.consentByUser, x: consent.fullUserFacing() },
  };
  const c = runFeatureUsagePrevalence(baseInput(withUnknown));
  check('unknown event type は寄与しない（denom 50）', c.kind === 'valid' && c.denominator === 50);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

/*
 * scripts/career-aggregate-cohort-qa.ts
 *
 * PASSAI CAREER — Aggregated Insight cohort guard QA（P14-B・C. Cohort）。
 *
 * 何を守るか（P14-A §Cohort policy）:
 *   - unique-user 数で threshold 判定（event 数ではない）。
 *   - k=49 は user-facing suppressed / k=50 は eligible / k=9 は absolute minimum 未満。
 *   - zero と suppressed を型で区別（zero variant / suppressed variant）。
 *   - prohibited dimension / 任意複合 dimension / 不正粒度は reject。
 *   - roll-up 後に再判定（graduation_year 不足 → all）。
 *   - stale / incomplete は valid 扱いしない。
 *
 * 使い方: npx tsx scripts/career-aggregate-cohort-qa.ts
 */

import { evaluateCohort, validateCohortSpec } from '@/lib/careerAggregate/cohort';
import { runFeatureUsagePrevalence } from '@/lib/careerAggregate/pipeline';
import { COHORT_THRESHOLDS } from '@/lib/careerAggregate/policy';
import { baseInput, usersEachOneEvent, consent, mkEvent, TARGET_MONTH } from './fixtures/careerAggregateFixtures';
import type { CareerEventFeature } from '@/types/careerAggregate';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('[1] evaluateCohort thresholds (user-facing = 50)');
{
  check('k=50 → not suppressed', evaluateCohort({ uniqueUsers: 50, audience: 'user_facing', cohortType: 'all' }).suppressed === false);
  const k49 = evaluateCohort({ uniqueUsers: 49, audience: 'user_facing', cohortType: 'all' });
  check('k=49 → suppressed below_audience_threshold', k49.suppressed && k49.reason === 'below_audience_threshold');
  const k9 = evaluateCohort({ uniqueUsers: 9, audience: 'user_facing', cohortType: 'all' });
  check('k=9 → suppressed below_absolute_minimum', k9.suppressed && k9.reason === 'below_absolute_minimum');
  check('threshold は PROVISIONAL', COHORT_THRESHOLDS.status === 'PROVISIONAL');
  check('absolute<internal<user_facing<ai_context', COHORT_THRESHOLDS.absoluteLowerBound < COHORT_THRESHOLDS.internal && COHORT_THRESHOLDS.internal < COHORT_THRESHOLDS.userFacing && COHORT_THRESHOLDS.userFacing < COHORT_THRESHOLDS.aiContext);
}

console.log('[2] validateCohortSpec');
{
  check('all + month → ok', 'ok' in validateCohortSpec({ cohortType: 'all', timeGranularity: 'month' }));
  const inter = validateCohortSpec({ cohortType: 'graduation_year', extraDimensions: ['company'], timeGranularity: 'month' });
  check('graduation_year × company → prohibited_dimension', 'suppressed' in inter && inter.reason === 'prohibited_dimension');
  const inter2 = validateCohortSpec({ cohortType: 'graduation_year', extraDimensions: ['some_other'], timeGranularity: 'month' });
  check('任意複合 dimension → unsupported_dimension_intersection', 'suppressed' in inter2 && inter2.reason === 'unsupported_dimension_intersection');
  const gran = validateCohortSpec({ cohortType: 'all', timeGranularity: 'day' });
  check('day 粒度 → unsafe_time_granularity', 'suppressed' in gran && gran.reason === 'unsafe_time_granularity');
}

console.log('[3] pipeline: unique-user threshold（k=50 eligible / k=49 suppressed）');
{
  const k50 = usersEachOneEvent(50, 'interview');
  const a50 = runFeatureUsagePrevalence(baseInput({ ...k50 }));
  check('k=50 → valid', a50.kind === 'valid');
  if (a50.kind === 'valid') check('k=50 denominator=50', a50.denominator === 50 && a50.numerator === 50);

  const k49 = usersEachOneEvent(49, 'interview');
  const a49 = runFeatureUsagePrevalence(baseInput({ ...k49 }));
  check('k=49 → suppressed（数値なし）', a49.kind === 'suppressed');
  check('k=49 suppressed に numerator が無い', !('numerator' in a49));
}

console.log('[4] event count ≠ user count（heavy user は threshold を満たさない）');
{
  // 1 ユーザーが同 feature を 60 event（=k=1）。event 数 60 でも user 数 1。
  const events = Array.from({ length: 60 }, (_v, i) => mkEvent('solo', { feature: 'interview', clientEventId: `solo-${i}` }));
  const a = runFeatureUsagePrevalence(baseInput({ events, consentByUser: { solo: consent.fullUserFacing() } }));
  check('60 event / 1 user → suppressed（user 数で判定）', a.kind === 'suppressed');
}

console.log('[5] zero ≠ suppressed');
{
  // eligible contributor 0（全員 personal のみ）。
  const events = usersEachOneEvent(50, 'interview').events;
  const consentByUser: Record<string, ReturnType<typeof consent.personalOnly>> = {};
  for (const e of events) consentByUser[String(e.user_id)] = consent.personalOnly();
  const a = runFeatureUsagePrevalence(baseInput({ events, consentByUser }));
  check('eligible 0 → zero variant', a.kind === 'zero');
  if (a.kind === 'zero') check('zero は denominator=0', a.denominator === 0);
  check('zero は suppressed ではない', a.suppression.suppressed === false);
}

console.log('[6] roll-up（graduation_year 不足 → all で再判定）');
{
  const feature: CareerEventFeature = 'interview';
  // grad 2027: 40 人（<50, suppressed）。grad 2028: 20 人。all=60（>=50）。
  const g27 = usersEachOneEvent(40, feature, 0);
  const g28 = usersEachOneEvent(20, feature, 1000);
  const events = [...g27.events, ...g28.events];
  const consentByUser = { ...g27.consentByUser, ...g28.consentByUser };
  const cohortByUser: Record<string, string> = {};
  for (const e of g27.events) cohortByUser[String(e.user_id)] = '2027';
  for (const e of g28.events) cohortByUser[String(e.user_id)] = '2028';

  const noRoll = runFeatureUsagePrevalence(baseInput({
    events, consentByUser, cohortByUser,
    target: { feature, cohortType: 'graduation_year', cohortValue: '2027', monthBucket: TARGET_MONTH, audience: 'user_facing' },
  }));
  check('roll-up 無効: grad2027=40 → suppressed', noRoll.kind === 'suppressed');

  const rolled = runFeatureUsagePrevalence(baseInput({
    events, consentByUser, cohortByUser,
    target: { feature, cohortType: 'graduation_year', cohortValue: '2027', monthBucket: TARGET_MONTH, audience: 'user_facing' },
    options: { allowRollUp: true },
  }));
  check('roll-up 有効: all=60 → valid', rolled.kind === 'valid');
  if (rolled.kind === 'valid') {
    check('roll-up 後 cohortType=all', rolled.cohortType === 'all');
    check('provenance.rolledUpFrom=graduation_year', rolled.provenance.rolledUpFrom === 'graduation_year');
    check('roll-up 後 denominator=60', rolled.denominator === 60);
  }
}

console.log('[7] roll-up 後も不足なら suppressed');
{
  const feature: CareerEventFeature = 'interview';
  const g = usersEachOneEvent(9, feature, 0); // all でも 9 < 10
  const cohortByUser: Record<string, string> = {};
  for (const e of g.events) cohortByUser[String(e.user_id)] = '2027';
  const a = runFeatureUsagePrevalence(baseInput({
    events: g.events, consentByUser: g.consentByUser, cohortByUser,
    target: { feature, cohortType: 'graduation_year', cohortValue: '2027', monthBucket: TARGET_MONTH, audience: 'user_facing' },
    options: { allowRollUp: true },
  }));
  check('roll-up 後も absolute 未満 → zero/suppressed（数値なし）', a.kind !== 'valid');
}

console.log('[8] stale / incomplete は valid 扱いしない');
{
  const k50 = usersEachOneEvent(50, 'interview');
  const stale = runFeatureUsagePrevalence(baseInput({ ...k50, qualityStatus: 'stale' }));
  check('stale → suppressed stale_source', stale.kind === 'suppressed' && stale.suppression.suppressed && stale.suppression.reason === 'stale_source');
  const incomplete = runFeatureUsagePrevalence(baseInput({ ...k50, qualityStatus: 'incomplete' }));
  check('incomplete → suppressed incomplete_batch', incomplete.kind === 'suppressed' && incomplete.suppression.suppressed && incomplete.suppression.reason === 'incomplete_batch');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

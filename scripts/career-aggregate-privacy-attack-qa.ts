/*
 * scripts/career-aggregate-privacy-attack-qa.ts
 *
 * PASSAI CAREER — Aggregated Insight privacy attack QA（P14-B・E. Privacy Attack）。
 *
 * 何を守るか（P14-A §Threat model）— **enforced** な防御のみ PASS で固定し、
 * 未対応の攻撃は KNOWN-GAP として明示する（「防げている」と誤認させない）。
 *
 * ENFORCED:
 *   - prohibited company / job-type dimension → suppressed。
 *   - arbitrary cross-filter（複合 dimension）→ suppressed。
 *   - rare cohort / small cell → suppressed（threshold）。
 *   - single-user は threshold 未満 → suppressed。
 *   - hashed id 再識別: hashed_user_id を inject しても artifact に残らない。
 *   - exact timestamp linkage: artifact に exact time が無い。
 *   - heavy-user fingerprint: boolean 化で 1。
 *
 * KNOWN-GAP（今回未対応・将来課題／初期 pilot は fixed report + 非表示で緩和のみ）:
 *   - difference attack（逐次 cohort 差分）
 *   - multi-period comparison による少数推定
 *   - complementary cell inference（隣接セルからの逆算）
 *   → これらは differential privacy / complementary suppression 未実装。fixed dimensions・
 *     fixed reports・arbitrary query 禁止で表面積を絞るのみ。
 *
 * 使い方: npx tsx scripts/career-aggregate-privacy-attack-qa.ts
 */

import { runFeatureUsagePrevalence } from '@/lib/careerAggregate/pipeline';
import { SUPPRESSION_REASONS } from '@/lib/careerAggregate/policy';
import { baseInput, usersEachOneEvent, mkEvent, consent, TARGET_MONTH } from './fixtures/careerAggregateFixtures';
import type { CareerEventFeature } from '@/types/careerAggregate';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function gap(name: string): void {
  console.log(`  KNOWN-GAP  ${name} — 未対応（将来課題・fixed report で表面積のみ緩和）`);
}

const feature: CareerEventFeature = 'interview';
const enough = usersEachOneEvent(60, feature);

console.log('[1] prohibited dimension / arbitrary cross-filter → suppressed');
{
  const company = runFeatureUsagePrevalence(baseInput({
    ...enough,
    target: { feature, cohortType: 'graduation_year', cohortValue: '2027', monthBucket: TARGET_MONTH, audience: 'user_facing' },
    cohortByUser: Object.fromEntries(enough.events.map((e) => [String(e.user_id), '2027'])),
    options: { extraDimensions: ['company'] },
  }));
  check('graduation_year × company → suppressed prohibited_dimension', company.kind === 'suppressed' && company.suppression.suppressed && company.suppression.reason === 'prohibited_dimension');

  const arbitrary = runFeatureUsagePrevalence(baseInput({
    ...enough,
    options: { extraDimensions: ['arbitrary_field'] },
  }));
  check('任意 cross-filter → suppressed', arbitrary.kind === 'suppressed');
}

console.log('[2] small cell / rare cohort / single-user → suppressed');
{
  const rare = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(3, feature) }));
  check('3 人 cohort → suppressed（数値なし）', rare.kind === 'suppressed');

  const single = runFeatureUsagePrevalence(baseInput({ events: [mkEvent('lonely', { feature, clientEventId: 's-1' })], consentByUser: { lonely: consent.fullUserFacing() } }));
  check('single-user → suppressed', single.kind === 'suppressed');
}

console.log('[3] hashed id 再識別 / exact timestamp linkage → artifact に残らない');
{
  const dirtied = enough.events.map((e, i) => mkEvent(String(e.user_id), {
    feature, clientEventId: `h-${i}`,
    inject: { hashed_user_id: `hash-${i}`, occurred_exact: '2026-05-15T09:00:00.123Z' },
  }));
  const a = runFeatureUsagePrevalence(baseInput({ events: dirtied, consentByUser: enough.consentByUser }));
  const json = JSON.stringify(a);
  check('hashed_user_id が artifact に残らない', !json.includes('hash-'));
  check('exact timestamp が artifact に残らない', !json.includes('09:00:00.123'));
  check('artifact の time は month 粒度', a.timeBucket === TARGET_MONTH && a.timeBucket.length === 7);
}

console.log('[4] heavy-user fingerprint → boolean 1');
{
  const heavy = Array.from({ length: 300 }, (_v, i) => mkEvent('whale', { feature, clientEventId: `w-${i}` }));
  const a = runFeatureUsagePrevalence(baseInput({ events: heavy, consentByUser: { whale: consent.fullUserFacing() } }));
  check('300 event / 1 user → suppressed（支配せず）', a.kind === 'suppressed');
}

console.log('[5] KNOWN-GAP（明示・未対応）');
{
  gap('difference attack（逐次 cohort 差分）');
  gap('multi-period comparison による少数推定');
  gap('complementary cell inference（隣接セル逆算）');
  // complementary_suppression_required は「予約 reason」として型に存在するが、自動適用は未実装であることを固定。
  check('complementary_suppression_required が予約 reason として存在（自動適用は未実装）', SUPPRESSION_REASONS.includes('complementary_suppression_required'));
}

console.log(failures === 0 ? '\nALL PASS（KNOWN-GAP は別途明示済み）' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

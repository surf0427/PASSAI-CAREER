/*
 * scripts/career-aggregate-artifact-qa.ts
 *
 * PASSAI CAREER — Aggregated Insight safe artifact QA（P14-B・F. Artifact）。
 *
 * 何を守るか（P14-A §Safe artifact）:
 *   - denominator 必須（valid）。suppressed artifact に numerator / denominator / ratio が無い。
 *   - raw ID / hashed ID / client_event_id / reverse lookup key / exact timestamp / company /
 *     score_band / raw metadata / synthetic user id を **一切**含まない（deep scan）。
 *   - zero / suppressed / valid が別 union（kind）で区別される。
 *   - quality status が valid でない場合は valid を作らない。
 *   - calculation version mismatch は render 対象にならない（suppressed）。
 *
 * 使い方: npx tsx scripts/career-aggregate-artifact-qa.ts
 */

import { runFeatureUsagePrevalence } from '@/lib/careerAggregate/pipeline';
import { toSampleSizeBucket } from '@/lib/careerAggregate/artifact';
import { baseInput, usersEachOneEvent, mkEvent, consent } from './fixtures/careerAggregateFixtures';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// artifact を再帰走査して全 key と全 string 値を集める。
function collect(obj: unknown, keys: string[], vals: string[]): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') { vals.push(obj); return; }
  if (typeof obj !== 'object') return;
  if (Array.isArray(obj)) { for (const v of obj) collect(v, keys, vals); return; }
  for (const [k, v] of Object.entries(obj)) {
    keys.push(k);
    collect(v, keys, vals);
  }
}

const FORBIDDEN_KEYS = ['user_id', '__dedupUserKey', '__dedupEventKey', 'client_event_id', 'metadata', 'score_band', 'company_id', 'hashed_user_id', 'rawRowId', 'id'];
const FORBIDDEN_VALUE_SUBSTR = ['u00000', 'u00001', 'solo', 'T09:00', 'T00:00:00.000Z-'];

console.log('[1] valid artifact 構造');
{
  const a = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(120, 'interview') }));
  check('valid', a.kind === 'valid');
  if (a.kind === 'valid') {
    check('denominator 必須', typeof a.denominator === 'number' && a.denominator === 120);
    check('numerator <= denominator', a.numerator <= a.denominator);
    check('prevalence 0..1', a.prevalence >= 0 && a.prevalence <= 1);
    check('sampleSizeBucket=100–199', a.sampleSizeBucket === '100–199');
    check('provenance あり', a.provenance.metricKey === 'feature_usage_prevalence');
    check('calculationVersion あり', a.calculationVersion === 'feature_usage_prevalence@1');
    check('expiresAt > generatedAt', Date.parse(a.expiresAt) > Date.parse(a.generatedAt));
    check('disclaimerKey あり', a.disclaimerKey.length > 0);
    check('policyStatus=PROVISIONAL', a.provenance.policyStatus === 'PROVISIONAL');
  }
}

console.log('[2] deep scan（識別子・exact time・raw を含まない）');
{
  // prohibited field を大量に inject した events から artifact を作っても漏れないこと。
  const fifty = usersEachOneEvent(60, 'interview');
  const dirtied = fifty.events.map((e, i) => mkEvent(String(e.user_id), {
    feature: 'interview', clientEventId: `d-${i}`,
    inject: { score_band: 'S', company_id: '22222222-2222-2222-2222-222222222222', metadata: { note: '本文' }, hashed_user_id: 'deadbeef', text: '面接回答の本文' },
  }));
  const a = runFeatureUsagePrevalence(baseInput({ events: dirtied, consentByUser: fifty.consentByUser }));
  const keys: string[] = []; const vals: string[] = [];
  collect(a, keys, vals);
  check('禁止 key を含まない', !FORBIDDEN_KEYS.some((k) => keys.includes(k)), keys.filter((k) => FORBIDDEN_KEYS.includes(k)).join(','));
  check('synthetic user id / exact time を含まない', !FORBIDDEN_VALUE_SUBSTR.some((s) => vals.some((v) => v.includes(s))));
  check('本文が漏れない', !vals.some((v) => v.includes('本文')));
  check('score_band 値が漏れない', !vals.includes('S'));
}

console.log('[3] suppressed に数値が無い');
{
  const a = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(49, 'interview') }));
  check('suppressed', a.kind === 'suppressed');
  check('numerator を持たない', !('numerator' in a));
  check('denominator を持たない', !('denominator' in a));
  check('prevalence を持たない', !('prevalence' in a));
  check('suppression.reason を持つ', a.kind === 'suppressed' && a.suppression.suppressed && typeof a.suppression.reason === 'string');
}

console.log('[4] zero / suppressed / valid の union 区別');
{
  const valid = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(50, 'interview') }));
  const suppressed = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(20, 'interview') }));
  const zeroInput = usersEachOneEvent(50, 'interview');
  const zc: Record<string, ReturnType<typeof consent.personalOnly>> = {};
  for (const e of zeroInput.events) zc[String(e.user_id)] = consent.personalOnly();
  const zero = runFeatureUsagePrevalence(baseInput({ events: zeroInput.events, consentByUser: zc }));
  check('kind が valid/suppressed/zero で分岐', valid.kind === 'valid' && suppressed.kind === 'suppressed' && zero.kind === 'zero');
}

console.log('[5] calculation version mismatch');
{
  const a = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(50, 'interview'), calculationVersionOverride: 'feature_usage_prevalence@999' }));
  check('version mismatch → suppressed invalid_calculation_version', a.kind === 'suppressed' && a.suppression.suppressed && a.suppression.reason === 'invalid_calculation_version');
}

console.log('[6] sample size bucket');
{
  check('50→50–99', toSampleSizeBucket(50) === '50–99');
  check('100→100–199', toSampleSizeBucket(100) === '100–199');
  check('200→200–499', toSampleSizeBucket(200) === '200–499');
  check('500→500+', toSampleSizeBucket(500) === '500+');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

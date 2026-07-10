/*
 * scripts/career-aggregate-renderer-qa.ts
 *
 * PASSAI CAREER — Aggregated Insight safe renderer QA（P14-B・G. Renderer）。
 *
 * 何を守るか（P14-A §Safe renderer / AI policy）:
 *   - valid は一般傾向文 + 固定 disclaimer。
 *   - 禁止表現（遅れ・不足・能力・合否・属性適性・比較・因果）を生成しない。
 *   - suppressed / zero は数値を出さず neutral 文言。
 *   - missing(null) は render しない（negative evidence にしない）。
 *   - 生の numerator / denominator を文へ出さない。
 *   - AI-safe context は valid のみ生成（suppressed → null）。
 *
 * 使い方: npx tsx scripts/career-aggregate-renderer-qa.ts
 */

import { runFeatureUsagePrevalence } from '@/lib/careerAggregate/pipeline';
import { renderSafeAggregate, buildAiSafeAggregateContext } from '@/lib/careerAggregate/renderer';
import { AGGREGATE_DISCLAIMER, INSUFFICIENT_DATA_MESSAGE, PROHIBITED_RENDER_PHRASES } from '@/lib/careerAggregate/policy';
import { baseInput, usersEachOneEvent, consent } from './fixtures/careerAggregateFixtures';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const validArtifact = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(120, 'interview') }));
const suppressedArtifact = runFeatureUsagePrevalence(baseInput({ ...usersEachOneEvent(49, 'interview') }));

console.log('[1] valid render');
{
  const r = renderSafeAggregate(validArtifact);
  check('valid → render 出力あり', r !== null && r.kind === 'valid');
  if (r) {
    check('disclaimer 必須', r.disclaimer === AGGREGATE_DISCLAIMER);
    check('feature ラベルを含む（面接練習）', r.text.includes('面接練習'));
    check('禁止表現を含まない', !PROHIBITED_RENDER_PHRASES.some((p) => (r.text + r.disclaimer).includes(p)));
    check('生 count（120/割合数値）を文へ出さない', !/\d{2,}/.test(r.text) && !r.text.includes('%') && !r.text.includes('/'));
  }
}

console.log('[2] suppressed / zero → neutral（数値なし）');
{
  const r = renderSafeAggregate(suppressedArtifact);
  check('suppressed → neutral 文言', r !== null && r.text === INSUFFICIENT_DATA_MESSAGE);
  check('suppressed 出力に数値なし', r !== null && !/\d/.test(r.text));

  const zin = usersEachOneEvent(50, 'interview');
  const zc: Record<string, ReturnType<typeof consent.personalOnly>> = {};
  for (const e of zin.events) zc[String(e.user_id)] = consent.personalOnly();
  const zero = runFeatureUsagePrevalence(baseInput({ events: zin.events, consentByUser: zc }));
  const rz = renderSafeAggregate(zero);
  check('zero → neutral 文言', rz !== null && rz.text === INSUFFICIENT_DATA_MESSAGE && rz.kind === 'zero');
}

console.log('[3] missing → render しない');
{
  check('null → null', renderSafeAggregate(null) === null);
  check('undefined → null', renderSafeAggregate(undefined) === null);
}

console.log('[4] AI-safe context は valid のみ');
{
  const ctx = buildAiSafeAggregateContext(validArtifact);
  check('valid → context あり', ctx !== null && ctx.sufficientCohort === true);
  if (ctx) {
    check('sampleSizeBucket を語彙で持つ', ctx.sampleSizeBucket === '100–199');
    check('非因果 disclaimer あり', ctx.nonCausalDisclaimer.length > 0);
    check('非評価 disclaimer あり', ctx.nonEvaluativeDisclaimer.length > 0);
    check('exact count / user id を含まない', !/\d{2,}/.test(ctx.metricDescription) && !ctx.metricDescription.includes('u0'));
  }
  check('suppressed → context null', buildAiSafeAggregateContext(suppressedArtifact) === null);
  check('missing → context null', buildAiSafeAggregateContext(null) === null);
}

console.log('[5] 全禁止表現が policy に列挙されている（defensive）');
{
  check('禁止表現リストが空でない', PROHIBITED_RENDER_PHRASES.length >= 10);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

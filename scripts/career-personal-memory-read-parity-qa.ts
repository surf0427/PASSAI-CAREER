/*
 * scripts/career-personal-memory-read-parity-qa.ts
 *
 * PASSAI CAREER — P17-M1: company_research read pilot の byte-parity QA（dev-only・純関数）。
 *
 * 目的: L2 Personal Memory を prompt へ結合する変更が、**Memory 無し時に company_research の system prompt を
 *   byte-identical に保つ**ことを常設検証する。route は block を `.filter(s => s !== '').join('\n\n')` で結合するため、
 *   personalMemoryContext === '' は「その要素が無い」ことと完全同値であることを併せて証明する。
 *
 * 検証:
 *   - buildCareerContextForPurpose('company_research_review', ctx) の出力が、extras 無し / {personalMemory: []} /
 *     {personalMemory: undefined} で **完全一致**、かつ personalMemoryContext === ''。
 *   - personalMemory を渡しても systemPrompt / crossFeatureContext / policy / estimatedChars は不変
 *     （＝Memory 注入は他 context を汚さない・独立 field に閉じる）。
 *   - fresh section 有り → personalMemoryContext は injection 境界付き非空。
 *   - route 結合等価性: filter/join 上で ''（空 block）を挟んでも、要素を除いた結合と byte 一致。
 *   - 対象外 purpose（matching）では personalMemory を渡しても personalMemoryContext === ''。
 *
 * 厳守: production 純関数のみ。route / AI / DB / env / secret 非接続。
 * 使い方: npx tsx scripts/career-personal-memory-read-parity-qa.ts
 */

import { createHash } from 'node:crypto';
import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
import type { CareerProfileInput, CareerActivityInput, CareerValuesInput } from '@/lib/careerAi';
import type { CareerPersonalMemorySection } from '@/lib/careerMemory/persistence/schema';

let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };
const cast = <T>(v: unknown): T => v as T;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const byteEq = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')) === 0;

const profile = cast<CareerProfileInput>({ name: '本人', university: '東京大学', faculty: '工学部', targetIndustries: ['IT', '商社'] });
const activity = cast<CareerActivityInput>({ academics: { detail: '研究' }, work: { detail: 'インターン' } });
const values = cast<CareerValuesInput>({ selections: { priorities: ['成長', '裁量'] }, overallNote: '裁量重視' });

const ctx = () => buildCareerAiContext({ featureKey: 'career-company-research', profile, activity, values, userInput: '' });

const baseSection: CareerPersonalMemorySection = cast({
  sectionKey: 'base', schemaVersion: 1,
  payload: { profile: { university: '東京大学', targetIndustries: ['IT'], strengths: ['実行力'] }, values: { priorities: ['成長'] }, activity: { presentSections: ['学業'], highlights: ['PM'] } },
});
const selfSection: CareerPersonalMemorySection = cast({
  sectionKey: 'self_analysis', schemaVersion: 1,
  payload: { latest: [{ summary: '課題設定が強み', strengths: ['計画性'] }], longTerm: { consistentStrengths: ['計画性'] } },
});

// route（company-research/route.ts）の結合手順を逐語で再現し、空 block の除去等価性を検証する。
function joinLikeRoute(parts: string[]): string {
  return parts.filter((s) => s !== '').join('\n\n');
}

// 現在 wiring 済みの全 target purpose（route が loader→orchestrator→personalMemoryContext を結合する）。
const WIRED_PURPOSES = ['company_research_review', 'consultation', 'interview_practice'] as const;

function main() {
  const PURPOSE = 'company_research_review';

  console.log('[1] Memory 無し（extras 無 / [] / undefined）→ 出力完全一致・personalMemoryContext ==="" — 全 wired purpose');
  for (const p of WIRED_PURPOSES) {
    const noExtras = buildCareerContextForPurpose(p, ctx());
    const emptyArr = buildCareerContextForPurpose(p, ctx(), { personalMemory: [] });
    const undef = buildCareerContextForPurpose(p, ctx(), { personalMemory: undefined });
    check(noExtras.personalMemoryContext === '', `${p}: extras 無 → ""`);
    check(emptyArr.personalMemoryContext === '', `${p}: [] → ""`);
    check(undef.personalMemoryContext === '', `${p}: undefined → ""`);
    check(sha(JSON.stringify(noExtras)) === sha(JSON.stringify(emptyArr)), `${p}: extras 無 == {personalMemory: []}`);
    check(sha(JSON.stringify(noExtras)) === sha(JSON.stringify(undef)), `${p}: extras 無 == {personalMemory: undefined}`);
  }
  const noExtras = buildCareerContextForPurpose(PURPOSE, ctx());

  console.log('[2] personalMemory を渡しても他 field（systemPrompt/crossFeature/policy/chars）は不変');
  const withMem = buildCareerContextForPurpose(PURPOSE, ctx(), { personalMemory: [baseSection, selfSection] });
  check(byteEq(withMem.systemPrompt, noExtras.systemPrompt), 'systemPrompt 不変');
  check(byteEq(withMem.crossFeatureContext, noExtras.crossFeatureContext), 'crossFeatureContext 不変');
  check(JSON.stringify(withMem.policy) === JSON.stringify(noExtras.policy), 'policy 不変');
  check(withMem.estimatedChars === noExtras.estimatedChars, 'estimatedChars 不変（Memory は systemPrompt に載らない）');

  console.log('[3] fresh section 有り → personalMemoryContext は injection 境界付き非空');
  check(withMem.personalMemoryContext.startsWith('<personal_memory>'), 'block 開始が境界');
  check(withMem.personalMemoryContext.trimEnd().endsWith('</personal_memory>'), 'block 終了が境界');
  check(withMem.personalMemoryContext.length > 0, 'block 非空');

  console.log('[4] route 結合等価性: 空 block を挟んでも要素を除いた結合と byte 一致');
  {
    const sys = noExtras.systemPrompt;
    const other = '# 直近の企業マッチング結果\nダミー';
    const withEmpty = joinLikeRoute([sys, other, '' /* personalMemoryContext 空 */, '# 出力形式']);
    const without = joinLikeRoute([sys, other, '# 出力形式']);
    check(byteEq(withEmpty, without), '空 personalMemoryContext は結合に影響しない（byte 一致）');
    const withBlock = joinLikeRoute([sys, other, withMem.personalMemoryContext, '# 出力形式']);
    check(withBlock.includes('<personal_memory>') && withBlock.length > without.length, '非空 block は結合へ挿入される');
  }

  console.log('[5] 対象外 purpose（matching）は personalMemory を渡しても "" のまま');
  {
    const m = buildCareerContextForPurpose('matching', ctx(), { personalMemory: [baseSection, selfSection] });
    check(m.personalMemoryContext === '', 'matching → personalMemoryContext ""（対象外 purpose）');
  }

  console.log('[6] 決定性: 同一入力 → 同一出力');
  {
    const a = buildCareerContextForPurpose(PURPOSE, ctx(), { personalMemory: [baseSection, selfSection] }).personalMemoryContext;
    const b = buildCareerContextForPurpose(PURPOSE, ctx(), { personalMemory: [baseSection, selfSection] }).personalMemoryContext;
    check(byteEq(a, b), 'deterministic personalMemoryContext');
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-read-parity-qa: ALL PASS' : `career-personal-memory-read-parity-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

/*
 * scripts/career-es-body-summary-qa.ts
 *
 * PASSAI CAREER — ESトレーニングシステム: matching / presentation ES summary の
 * 「ユーザー執筆 body 反映」決定論 QA（dev-only harness）。
 *
 * 目的:
 *   ES 再設計後、ユーザーが自分で書いた本文（CareerEsLog.body）が matching / presentation の
 *   strict summary に安全に反映されること、かつ body が無い旧ログでは従来の result フィールド経路が
 *   byte 不変であることを、外部 AI・DB 非接続の純関数比較で常設検証する。
 *
 * 厳守:
 *   - production の純関数（buildMatchingEsSummary / buildPresentationEsSummary）を読むだけ。
 *   - 外部 AI 非実行・実データ非参照・secret/env 非接続。
 *
 * 使い方: npx tsx scripts/career-es-body-summary-qa.ts
 * 終了コード: 全 assertion pass → 0 / 失敗 → 1。
 */

import {
  buildMatchingEsSummary,
  MATCHING_ES_SELFPR_CAP,
} from '@/lib/careerMemory/matchingEs';
import {
  buildPresentationEsSummary,
  PRESENTATION_ES_GAKUCHIKA_CAP,
} from '@/lib/careerMemory/presentationEs';
import type { CareerEsResult } from '@/types/careerEs';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

// 空の CareerEsResult（新ログ相当。生成系フィールドは空、answer は body の写し）。
function authoredResult(body: string): CareerEsResult {
  return {
    gakuchika: '',
    selfPr: '',
    motivation: '',
    headline: '',
    appealPoints: [],
    interviewQuestions: [],
    improvements: [],
    answer: body,
  };
}

// 旧生成ログ相当の result（生成系フィールドが埋まっている）。
function legacyResult(): CareerEsResult {
  return {
    gakuchika: 'ガクチカ本文（旧）',
    selfPr: '自己PR本文（旧）',
    motivation: '志望動機本文（旧）',
    headline: 'キャッチコピー（旧）',
    appealPoints: ['アピール1'],
    interviewQuestions: [],
    improvements: [],
  };
}

console.log('# Scenario 1: 新形式（body のみ）→ summary に body が入る');
{
  const body = '私はゼミ長として20人をまとめ、発表大会で最優秀賞を獲得しました。';
  const m = buildMatchingEsSummary(authoredResult(body), { body, question: '自己PRを教えてください' })!;
  const p = buildPresentationEsSummary(authoredResult(body), { body, question: '自己PRを教えてください' })!;
  check('matching selfPr に body', m.selfPr.includes('ゼミ長'));
  check('presentation selfPr に body', p.selfPr.includes('ゼミ長'));
  check('matching は headline 空（新ログ）', m.headline === '');
}

console.log('# Scenario 2: 旧形式（legacy result のみ・body 無し）→ 従来経路 byte 不変');
{
  const r = legacyResult();
  const m = buildMatchingEsSummary(r)!;
  const p = buildPresentationEsSummary(r)!;
  const mLegacy = { headline: 'キャッチコピー（旧）', selfPr: '自己PR本文（旧）', motivation: '志望動機本文（旧）' };
  check('matching legacy byte 一致', JSON.stringify(m) === JSON.stringify(mLegacy));
  check('presentation gakuchika legacy', p.gakuchika === 'ガクチカ本文（旧）');
}

console.log('# Scenario 3: body が空白 + legacy result → legacy にフォールバック');
{
  const r = legacyResult();
  const m = buildMatchingEsSummary(r, { body: '   ', question: '自己PR' })!;
  check('空白 body は無視して legacy selfPr', m.selfPr === '自己PR本文（旧）');
}

console.log('# Scenario 4: 新旧両方 → 新しい body を優先');
{
  const body = '新しく自分で書いた自己PR本文です。';
  const r = { ...legacyResult() }; // 旧フィールドも埋まっている
  const m = buildMatchingEsSummary(r, { body, question: '自己PRを教えてください' })!;
  check('body が legacy selfPr を上書き', m.selfPr.includes('新しく自分で書いた'));
}

console.log('# Scenario 4b: 設問種別で投影先が変わる（志望動機 → motivation）');
{
  const body = '御社の理念に共感し、地域貢献の事業に携わりたいと考えました。';
  const m = buildMatchingEsSummary(authoredResult(body), { body, question: '当社を志望する理由を教えてください' })!;
  const p = buildPresentationEsSummary(authoredResult(body), { body, question: '志望動機を教えてください' })!;
  check('matching motivation に body', m.motivation.includes('地域貢献'));
  check('matching selfPr は空（新ログ・志望動機型）', m.selfPr === '');
  check('presentation motivation に body', p.motivation.includes('地域貢献'));
  check('presentation gakuchika は空（志望動機型）', p.gakuchika === '');
}

console.log('# Scenario 4c: ガクチカ型 body → presentation は gakuchika へ');
{
  const body = '学生時代はカフェのバイトで新人教育マニュアルを作りました。';
  const p = buildPresentationEsSummary(authoredResult(body), { body, question: '学生時代に力を入れたことは？' })!;
  check('presentation gakuchika に body', p.gakuchika.includes('新人教育'));
  check('presentation selfPr は空（ガクチカ型）', p.selfPr === '');
}

console.log('# Scenario 6: review なしでも summary 生成（builder は review を参照しない）');
{
  const body = 'レビュー未実施だが本文はある。';
  const m = buildMatchingEsSummary(authoredResult(body), { body, question: '自己PR' })!;
  check('review 無関係に body 反映', m.selfPr.includes('レビュー未実施'));
}

console.log('# Scenario 7: body 長文でも既存上限内に収まる');
{
  const body = 'あ'.repeat(1000);
  const m = buildMatchingEsSummary(authoredResult(body), { body, question: '自己PR' })!;
  const p = buildPresentationEsSummary(authoredResult(body), { body, question: '学生時代に力を入れたこと' })!;
  // truncate は max 文字 + 省略記号「…」を返すため上限は cap + 1。
  check('matching selfPr <= cap+1', m.selfPr.length <= MATCHING_ES_SELFPR_CAP + 1);
  check('presentation gakuchika <= cap+1', p.gakuchika.length <= PRESENTATION_ES_GAKUCHIKA_CAP + 1);
}

console.log('# Scenario 9: undefined / malformed でも例外にならず null 安全');
{
  check('matching null result → null', buildMatchingEsSummary(null) === null);
  check('presentation undefined result → null', buildPresentationEsSummary(undefined) === null);
  check('matching opts 欠損でも OK', buildMatchingEsSummary(authoredResult('x')) !== null);
  // question 欠損（other 扱い）→ selfPr へ投影
  const m = buildMatchingEsSummary(authoredResult('本文'), { body: '本文' })!;
  check('question 欠損 → other → selfPr 投影', m.selfPr === '本文');
}

console.log('# Scenario 10: missing data を negative evidence にしない（空文字であり負値でない）');
{
  const m = buildMatchingEsSummary(authoredResult(''), { body: '', question: '自己PR' })!;
  check('body 空でも例外/負値なし（空文字）', m.selfPr === '' && m.motivation === '');
}

if (failures > 0) {
  console.error(`\n✖ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\n✓ all assertions passed');

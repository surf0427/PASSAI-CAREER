/*
 * scripts/career-mypage-progress-qa.ts
 *
 * PASSAI CAREER — マイページ「練習・作成の進度 / 成長進度」の決定論 QA（dev-only harness）。
 *
 * 背景:
 *   マイページの進度・成長グラフは **既存機能が保存済みの実評価だけ**を読み出して描く。
 *   ここで新しい評価を作らない・欠損を 0 点で埋めない・未完了を混ぜないことが要点なので、
 *   集計の純関数（lib/careerMyPageProgress/progress.ts）の判定を固定する。
 *
 * 検証項目:
 *   1. 0 件 / 1 件 / 複数件（グラフが壊れない・前回比が「初回」になる）
 *   2. 時系列順（保存順に依存せず createdAt 昇順・同時刻は id で決定的）
 *   3. 異常データ除外（score NULL / 範囲外 / NaN / 未完了 / legacy / 壊れた日時）
 *   4. 重複行（同一 id の二重保存を 1 件に潰す）
 *   5. 自己分析 latest 判定（最新・中身が空の行を選ばない・軸は実 field と 1:1）
 *   6. 実施回数の単位（評価が無い実施も回数には数える）
 *   7. server / 端末 canonical の両経路で同じ入力 → 同じ出力（同じ純関数を使っている保証）
 *   8. payload に本文・transcript・AI 全文が入らない
 *
 * 使い方: npx tsx scripts/career-mypage-progress-qa.ts
 * 終了コード: 全 assertion pass → 0 / 1 件でも失敗 → 1。
 */

import {
  CAREER_SELF_UNDERSTANDING_AXES,
  buildCareerMyPageProgress,
  isCareerMyPageProgressEmpty,
} from '@/lib/careerMyPageProgress/progress';
import { EMPTY_CAREER_SOURCE_BUNDLE, type CareerSourceBundle } from '@/lib/careerSourceData/types';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerEsLog } from '@/types/careerEs';
import type { CareerInterviewResult } from '@/types/careerInterview';
import type { CareerPresentationResult } from '@/types/careerPresentation';

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── fixture factory（実型に沿った最小データ） ───────────────────────

function bundleOf(partial: Partial<CareerSourceBundle>): CareerSourceBundle {
  return { ...EMPTY_CAREER_SOURCE_BUNDLE, ...partial };
}

function esLog(id: string, createdAt: string, overallScore: number | null | undefined): CareerEsLog {
  const log = {
    id,
    createdAt,
    userInput: '',
    result: {} as CareerEsLog['result'],
    body: '本文。ここはグラフ payload に入ってはいけない。',
  } as CareerEsLog;
  if (overallScore !== undefined) {
    log.review = {
      overallScore: overallScore as number,
      rank: 'B',
      overallComment: '総評テキスト',
      breakdown: {
        logic: 70,
        specificity: 70,
        originality: 70,
        readability: 70,
        persuasion: 70,
        companyFit: 70,
      },
      strengths: [],
      improvements: [],
      missingElements: [],
      recruiterComments: [],
      priorityActions: [],
    };
  }
  return log;
}

function interviewResult(
  id: string,
  createdAt: string,
  overallScore: number | null | undefined,
): CareerInterviewResult {
  const result = {
    overallComment: '総評',
    strengths: [],
    improvements: [],
    sampleAnswers: [],
    deepDiveTopics: [],
    nextActions: [],
    companyFit: '',
  } as CareerInterviewResult['result'];
  if (overallScore !== undefined) result.overallScore = overallScore as number;
  return {
    id,
    createdAt,
    mode: 'voice',
    turns: [{ role: 'question', content: '長い面接 transcript' }],
    result,
  };
}

function presentationResult(
  id: string,
  createdAt: string,
  totalScore: number | null | undefined,
): CareerPresentationResult {
  const result = {
    totalScore: totalScore as number,
    rank: 'B',
    overallComment: '総評',
    axes: [],
    goodPoints: [],
    improvements: [],
    priorityImprovements: [],
    nextPractice: [],
    expectedQuestions: [],
    improvedStructure: [],
    passLikelihood: '',
    companyFit: '',
    interviewerConcerns: [],
  } as CareerPresentationResult['result'];
  if (totalScore === undefined) delete (result as Record<string, unknown>).totalScore;
  return {
    id,
    createdAt,
    presentationType: 'real',
    mode: 'voice',
    theme: 'お題',
    timeLimitSec: 180,
    durationSec: 170,
    transcript: '発表の全文文字起こし。これも payload に入ってはいけない。',
    result,
  };
}

function selfAnalysisLog(
  id: string,
  createdAt: string,
  overrides: Record<string, unknown> = {},
): CareerSelfAnalysisLog {
  return {
    id,
    createdAt,
    userInput: '',
    result: {
      summary: '',
      strengths: [],
      weaknesses: [],
      gakuchikaIdeas: [],
      selfPrIdeas: [],
      esAngles: [],
      interviewQuestions: [],
      nextActions: [],
      careerDirection: '',
      recommendedIndustries: [],
      recommendedJobs: [],
      suitableEnvironment: [],
      valueKeywords: [],
      strengthKeywords: [],
      motivationSources: [],
      stressFactors: [],
      companySelectionCriteria: [],
      developmentPoints: [],
      ...overrides,
    } as CareerSelfAnalysisLog['result'],
  };
}

// ── 1. 0 件 / 1 件 / 複数件 ─────────────────────────────────────────

section('1. 0 件 / 1 件 / 複数件');
{
  const empty = buildCareerMyPageProgress(EMPTY_CAREER_SOURCE_BUNDLE);
  check('1a 0 件: activity が全て 0', 
    empty.activity.selfAnalysisCount === 0 &&
    empty.activity.esCount === 0 &&
    empty.activity.interviewCount === 0 &&
    empty.activity.presentationCount === 0);
  check('1b 0 件: history 空・latestScore/delta は null（0 点にしない）',
    empty.es.history.length === 0 && empty.es.latestScore === null && empty.es.delta === null);
  check('1c 0 件: 自己分析 latest は null（偽データを描かない）', empty.selfAnalysis.latest === null);
  check('1d 0 件: isCareerMyPageProgressEmpty が true', isCareerMyPageProgressEmpty(empty));

  const one = buildCareerMyPageProgress(
    bundleOf({ esLogs: [esLog('e1', '2026-08-01T00:00:00.000Z', 60)] }),
  );
  check('1e 1 件: 1 点だけ・attempt=1', one.es.history.length === 1 && one.es.history[0].attempt === 1);
  check('1f 1 件: latestScore=60', one.es.latestScore === 60);
  check('1g 1 件: delta は null（＝UI で「初回」）', one.es.delta === null);

  const many = buildCareerMyPageProgress(
    bundleOf({
      esLogs: [
        esLog('e1', '2026-08-01T00:00:00.000Z', 60),
        esLog('e2', '2026-08-05T00:00:00.000Z', 72),
        esLog('e3', '2026-08-09T00:00:00.000Z', 80),
      ],
    }),
  );
  check('1h 複数件: 3 点・attempt が 1..3', 
    many.es.history.map((p) => p.attempt).join(',') === '1,2,3');
  check('1i 複数件: latestScore=80 / delta=+8', many.es.latestScore === 80 && many.es.delta === 8);
}

// ── 2. 時系列 ordering ──────────────────────────────────────────────

section('2. chronological ordering');
{
  // 保存順はバラバラ（localStorage は新しい順、Supabase は created_at DESC）。
  const p = buildCareerMyPageProgress(
    bundleOf({
      interviewResults: [
        interviewResult('i3', '2026-08-09T00:00:00.000Z', 80),
        interviewResult('i1', '2026-08-01T00:00:00.000Z', 55),
        interviewResult('i2', '2026-08-05T00:00:00.000Z', 70),
      ],
    }),
  );
  check('2a 保存順に依存せず createdAt 昇順', p.interview.history.map((x) => x.id).join(',') === 'i1,i2,i3');
  check('2b 前回比は最新 2 点の差', p.interview.delta === 10);

  const tie = buildCareerMyPageProgress(
    bundleOf({
      presentationResults: [
        presentationResult('b', '2026-08-01T00:00:00.000Z', 70),
        presentationResult('a', '2026-08-01T00:00:00.000Z', 60),
      ],
    }),
  );
  check('2c 同時刻は id で決定的に並ぶ', tie.presentation.history.map((x) => x.id).join(',') === 'a,b');
}

// ── 3. 異常データ ──────────────────────────────────────────────────

section('3. 異常データの除外');
{
  const p = buildCareerMyPageProgress(
    bundleOf({
      esLogs: [
        esLog('ok', '2026-08-01T00:00:00.000Z', 70),
        esLog('legacy', '2026-08-02T00:00:00.000Z', undefined), // review 自体が無い旧生成ログ
        esLog('nullScore', '2026-08-03T00:00:00.000Z', null as unknown as number),
        esLog('nan', '2026-08-04T00:00:00.000Z', Number.NaN),
        esLog('over', '2026-08-05T00:00:00.000Z', 120),
        esLog('negative', '2026-08-06T00:00:00.000Z', -5),
        esLog('brokenDate', 'not-a-date', 88),
      ],
    }),
  );
  check('3a 評価対象は正常な 1 件だけ', p.es.history.map((x) => x.id).join(',') === 'ok');
  check('3b 除外した実施も「作成回数」には数える', p.activity.esCount === 7);
  check('3c 履歴件数と総数の差が保持される', p.es.totalCount === 7 && p.es.history.length === 1);

  const incomplete = buildCareerMyPageProgress(
    bundleOf({
      interviewResults: [interviewResult('mid', '2026-08-01T00:00:00.000Z', undefined)],
      presentationResults: [presentationResult('mid', '2026-08-01T00:00:00.000Z', undefined)],
    }),
  );
  check('3d 面接: overallScore 欠損（旧ログ / 未確定）はグラフに載らない',
    incomplete.interview.history.length === 0 && incomplete.interview.totalCount === 1);
  check('3e プレゼン: totalScore 欠損はグラフに載らない',
    incomplete.presentation.history.length === 0 && incomplete.presentation.totalCount === 1);

  const noId = buildCareerMyPageProgress(
    bundleOf({ esLogs: [{ ...esLog('x', '2026-08-01T00:00:00.000Z', 70), id: '' }] }),
  );
  check('3f id が無い壊れた行は数にも履歴にも入らない',
    noId.activity.esCount === 0 && noId.es.history.length === 0);
}

// ── 4. 重複行 ──────────────────────────────────────────────────────

section('4. duplicate');
{
  const p = buildCareerMyPageProgress(
    bundleOf({
      esLogs: [
        esLog('same', '2026-08-01T00:00:00.000Z', 60),
        esLog('same', '2026-08-04T00:00:00.000Z', 75), // 同 id の再保存（新しい方を採用）
        esLog('other', '2026-08-06T00:00:00.000Z', 80),
      ],
    }),
  );
  check('4a 同一 id は 1 件に潰れる', p.activity.esCount === 2);
  check('4b 採用されるのは createdAt が新しい方', 
    p.es.history.map((x) => `${x.id}:${x.score}`).join(',') === 'same:75,other:80');
}

// ── 5. 自己分析 latest / 軸 ─────────────────────────────────────────

section('5. self-analysis latest & axes');
{
  check('5a 軸は 6 本', CAREER_SELF_UNDERSTANDING_AXES.length === 6);
  check('5b 軸 key は CareerSelfAnalysisResult の実 field と 1:1',
    CAREER_SELF_UNDERSTANDING_AXES.map((a) => a.key).join(',') ===
      'strengths,weaknesses,gakuchikaIdeas,selfPrIdeas,valueKeywords,esAngles');

  const p = buildCareerMyPageProgress(
    bundleOf({
      selfAnalysisLogs: [
        selfAnalysisLog('old', '2026-08-01T00:00:00.000Z', { strengths: ['a'] }),
        selfAnalysisLog('new', '2026-08-05T00:00:00.000Z', {
          strengths: ['a', 'b', ' ', 'a'], // 空白と重複は数えない
          weaknesses: ['w'],
          valueKeywords: ['v1', 'v2', 'v3'],
        }),
        selfAnalysisLog('empty', '2026-08-09T00:00:00.000Z'), // 中身が空（生成失敗 / legacy）
      ],
    }),
  );
  check('5c latest は「中身のある最新」を選ぶ（空の最新行を選ばない）',
    p.selfAnalysis.latest?.id === 'new');
  const dims = p.selfAnalysis.latest?.dimensions ?? [];
  check('5d 件数は非空・重複除去後', 
    dims.find((d) => d.key === 'strengths')?.count === 2 &&
    dims.find((d) => d.key === 'valueKeywords')?.count === 3);
  check('5e 未入力の軸は 0 件（スコア化しない）',
    dims.find((d) => d.key === 'esAngles')?.count === 0);
  check('5f 自己分析の回数は空行も含む実施数', p.activity.selfAnalysisCount === 3);

  const allEmpty = buildCareerMyPageProgress(
    bundleOf({ selfAnalysisLogs: [selfAnalysisLog('e', '2026-08-01T00:00:00.000Z')] }),
  );
  check('5g 全軸 0 件しか無ければ latest=null（空レーダーを描かない）',
    allEmpty.selfAnalysis.latest === null && allEmpty.activity.selfAnalysisCount === 1);
}

// ── 6. server / device 経路の一致 ───────────────────────────────────

section('6. server / device 経路の同一性');
{
  const source = bundleOf({
    selfAnalysisLogs: [selfAnalysisLog('s1', '2026-08-01T00:00:00.000Z', { strengths: ['a'] })],
    esLogs: [esLog('e1', '2026-08-02T00:00:00.000Z', 70)],
    interviewResults: [interviewResult('i1', '2026-08-03T00:00:00.000Z', 65)],
    presentationResults: [presentationResult('p1', '2026-08-04T00:00:00.000Z', 55)],
  });
  // server 経路は created_at DESC、端末 canonical は「最新が先頭」。順序だけが違う同じ集合。
  const reversed = bundleOf({
    selfAnalysisLogs: [...source.selfAnalysisLogs].reverse(),
    esLogs: [...source.esLogs].reverse(),
    interviewResults: [...source.interviewResults].reverse(),
    presentationResults: [...source.presentationResults].reverse(),
  });
  check('6a 同じ集合なら順序が違っても byte 一致',
    JSON.stringify(buildCareerMyPageProgress(source)) ===
      JSON.stringify(buildCareerMyPageProgress(reversed)));
}

// ── 7. payload に本文が漏れない ─────────────────────────────────────

section('7. payload に本文・transcript を含めない');
{
  const p = buildCareerMyPageProgress(
    bundleOf({
      esLogs: [esLog('e1', '2026-08-01T00:00:00.000Z', 70)],
      interviewResults: [interviewResult('i1', '2026-08-01T00:00:00.000Z', 70)],
      presentationResults: [presentationResult('p1', '2026-08-01T00:00:00.000Z', 70)],
    }),
  );
  const json = JSON.stringify(p);
  check('7a ES 本文が含まれない', !json.includes('グラフ payload に入ってはいけない'));
  check('7b プレゼン transcript が含まれない', !json.includes('文字起こし'));
  check('7c 面接 turns / 総評テキストが含まれない',
    !json.includes('長い面接 transcript') && !json.includes('総評'));
}

console.log(`\n結果: PASS ${passes} / FAIL ${failures}`);
process.exit(failures > 0 ? 1 : 0);

/*
 * scripts/career-memory-presentation-byte-qa.ts
 *
 * PASSAI CAREER — presentation request context の byte 一致 QA（P5-D 常設 harness）。
 *
 * 目的:
 *   presentation selector（buildPresentationRequestContext）の返り値と、
 *   additive snapshot→projection 経路（buildCareerMemorySnapshot('presentation',…)→
 *   projectPresentationRequestContext）の返り値が **byte 一致（key 順込み）** することを常設で守る。
 *   P5-D で presentation production flow を snapshot 経路へ接続した後の回帰ガード。
 *
 * 厳守:
 *   - 本番 route / prompt / AI schema / DB / Supabase を一切変更・参照しない。
 *   - 純粋 fixture のみ（env / secret / 本番データ非接続）。
 *   - presentation のみが対象（consultation / interview / matching は扱わない）。
 *   - presentation は externals 不要（gdResultId も選択ログも無し）。
 *
 * 使い方: npx tsx scripts/career-memory-presentation-byte-qa.ts
 * 終了コード: 全ケース一致 → 0 / 1 件でも不一致 → 1。
 */

import { buildPresentationRequestContext } from '@/lib/careerMemory/selector';
import {
  buildCareerMemorySnapshot,
  projectPresentationRequestContext,
  type PresentationMemorySnapshot,
} from '@/lib/careerMemory/snapshot';

/* eslint-disable @typescript-eslint/no-explicit-any */
const any = (v: unknown) => v as any;

// ── fixtures（branch 網羅を優先。malformed でも両経路が同一挙動なら byte 一致する） ──
const selfLog = (id: string) =>
  any({ createdAt: `2026-07-0${id}`, result: { summary: `s${id}`, careerDirection: `d${id}`, strengths: [`a${id}`], weaknesses: [], recommendedIndustries: ['IT'], recommendedJobs: ['eng'], companySelectionCriteria: ['x'], gakuchikaIdeas: ['g'], valueKeywords: ['v'], strengthKeywords: ['k'], nextActions: ['n'] } });
const esLog = (id: string) =>
  any({ createdAt: `2026-06-0${id}`, companyName: `Co${id}`, question: `q${id}`, result: { headline: `h${id}`, gakuchika: 'g', selfPr: 'p', motivation: 'm', companyName: `Co${id}`, question: `q${id}`, appealPoints: ['ap'] } });
const interviewResult = (id: string) =>
  any({ createdAt: `2026-05-0${id}`, result: { overallComment: `oc${id}`, strengths: ['s'], improvements: ['i'], companyFit: 'f', mode: 'normal', deepDiveTopics: [], nextActions: [] } });
const presResult = (id: string) =>
  any({ createdAt: `2026-04-0${id}`, theme: `t${id}`, result: { overallComment: `oc${id}`, improvements: ['i'], companyFit: 'f' } });
const matchLog = (id: string) =>
  any({ createdAt: `2025-12-0${id}`, result: { careerDirection: 'dir', topCandidates: [], fitSignals: [] } });
const thread = (insights: string[]) =>
  any({ updatedAt: '2026-07-08', messages: [{ role: 'user' }, { role: 'assistant', result: { keyInsights: insights, currentFocus: 'f', openConcerns: [], recentActions: [] } }] });

const valuesFilled = any({ selections: { priorities: ['p'] }, notes: {}, overallNote: 'o' });
const baseFilled = { profile: any({ preferences: ['大学A'], targetIndustries: ['IT'], name: 'x' }), activity: any({ academics: { detail: 'y' } }) };

// presentation selector 入力（PresentationSelectorInput）。externals は無い。
type PresInput = {
  profile: any; activity: any; values: any;
  selfAnalysisLogs: any[]; esLogs: any[]; interviewResults: any[];
  matchingLogs: any[]; consultationThreads: any[];
  // snapshot 側でのみ意味を持つ（selector には無い）。ignored 確認用に harness だけ保持。
  presentationResults?: any[];
};

function base(over: Partial<PresInput>): PresInput {
  return {
    profile: null, activity: null, values: null,
    selfAnalysisLogs: [], esLogs: [], interviewResults: [],
    matchingLogs: [], consultationThreads: [],
    ...over,
  };
}

const cases: Array<{ name: string; input: PresInput }> = [
  { name: 'empty', input: base({}) },
  {
    name: 'rich (all present)',
    input: base({
      ...baseFilled, values: valuesFilled,
      selfAnalysisLogs: [selfLog('1'), selfLog('2')],
      esLogs: [esLog('1')],
      interviewResults: [interviewResult('1'), interviewResult('2')],
      matchingLogs: [matchLog('1')],
      consultationThreads: [thread(['a', 'b'])],
    }),
  },
  { name: 'selfAnalysis present', input: base({ selfAnalysisLogs: [selfLog('1')] }) },
  { name: 'selfAnalysis absent', input: base({ selfAnalysisLogs: [] }) },
  { name: 'ES present', input: base({ esLogs: [esLog('1')] }) },
  { name: 'ES absent', input: base({ esLogs: [] }) },
  { name: 'interview present', input: base({ interviewResults: [interviewResult('1')] }) },
  { name: 'interview absent', input: base({ interviewResults: [] }) },
  { name: 'matching present', input: base({ matchingLogs: [matchLog('1'), matchLog('2')] }) },
  { name: 'matching absent', input: base({ matchingLogs: [] }) },
  { name: 'consultationInsights present', input: base({ consultationThreads: [thread(['x', 'y'])] }) },
  { name: 'consultationInsights absent (empty thread)', input: base({ consultationThreads: [thread([])] }) },
  { name: 'consultation absent (no threads)', input: base({ consultationThreads: [] }) },
  { name: 'profile/activity/values present', input: base({ ...baseFilled, values: valuesFilled }) },
  { name: 'profile/activity/values absent', input: base({ profile: null, activity: null, values: null }) },
  // snapshot 入力に presentationResults があっても presentation snapshot は未参照＝出力不変を確認。
  { name: 'presentation logs in input (must be ignored)', input: base({ presentationResults: [presResult('1'), presResult('2')] }) },
];

let mismatches = 0;
for (const c of cases) {
  const { presentationResults = [], ...sel } = c.input;
  // old: 現行 selector（P5-D 接続後は内部 snapshot 経路）。presentationResults は selector 入力に無い。
  const oldBody = buildPresentationRequestContext(any(sel));
  // new: raw input → snapshot → projection。presentation は externals 不要。
  const snapshotInput = {
    profile: sel.profile, activity: sel.activity, values: sel.values,
    selfAnalysisLogs: sel.selfAnalysisLogs, esLogs: sel.esLogs,
    interviewResults: sel.interviewResults, presentationResults,
    companyResearchLogs: [], gdResults: [], gdRoomLogs: [],
    matchingLogs: sel.matchingLogs, consultationThreads: sel.consultationThreads,
  };
  const snapshot = buildCareerMemorySnapshot('presentation', any(snapshotInput), {}) as PresentationMemorySnapshot;
  const newBody = projectPresentationRequestContext(snapshot);

  const a = JSON.stringify(oldBody);
  const b = JSON.stringify(newBody);
  if (a !== b) {
    mismatches++;
    console.log(`❌ MISMATCH | ${c.name}`);
    console.log(`   old: ${a}`);
    console.log(`   new: ${b}`);
  } else {
    console.log(`✅ match    | ${c.name}`);
  }
}

console.log('');
console.log(`total=${cases.length} match=${cases.length - mismatches} mismatch=${mismatches}`);
console.log(mismatches === 0 ? 'ALL_MATCH' : 'DIFF_FOUND');
process.exit(mismatches === 0 ? 0 : 1);

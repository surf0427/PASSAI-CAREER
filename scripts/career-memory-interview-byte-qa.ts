/*
 * scripts/career-memory-interview-byte-qa.ts
 *
 * PASSAI CAREER — interview request context の byte 一致 QA（P5-E 常設 harness）。
 *
 * 目的:
 *   interview selector（buildInterviewRequestContext）の返り値と、
 *   additive snapshot→projection 経路（buildCareerMemorySnapshot('interview',…)→
 *   projectInterviewRequestContext）の返り値が **byte 一致（key 順込み）** することを常設で守る。
 *   P5-E で interview production flow（start/turn/complete が共有）を snapshot 経路へ接続した後の回帰ガード。
 *
 * 厳守:
 *   - 本番 route / prompt / AI schema / DB / Supabase を一切変更・参照しない。
 *   - 純粋 fixture のみ（env / secret / 本番データ非接続）。
 *   - interview のみが対象（consultation / matching / presentation は扱わない）。
 *   - selected companyResearchLog は snapshot externals として渡す。
 *
 * 使い方: npx tsx scripts/career-memory-interview-byte-qa.ts
 * 終了コード: 全ケース一致 → 0 / 1 件でも不一致 → 1。
 */

import { buildInterviewRequestContext } from '@/lib/careerMemory/selector';
import {
  buildCareerMemorySnapshot,
  projectInterviewRequestContext,
  type InterviewMemorySnapshot,
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
const matchLog = (id: string) =>
  any({ createdAt: `2025-12-0${id}`, result: { careerDirection: 'dir', topCandidates: [], fitSignals: [] } });
const thread = (insights: string[]) =>
  any({ updatedAt: '2026-07-08', messages: [{ role: 'user' }, { role: 'assistant', result: { keyInsights: insights, currentFocus: 'f', openConcerns: [], recentActions: [] } }] });
// build 成功する企業研究ログ（plain object）。
const crLogValid = (id: string) =>
  any({ id: `cr${id}`, companyName: `Co${id}`, industry: 'IT', interestLevel: 'high', verifiedResearchText: 'text', updatedAt: `2026-03-0${id}` });
// property get で必ず throw する log（resolveInterviewCompanyResearch の catch→null を強制）。
const crLogThrows = () =>
  new Proxy({}, { get() { throw new Error('boom'); } }) as any;

const valuesFilled = any({ selections: { priorities: ['p'] }, notes: {}, overallNote: 'o' });
const baseFilled = { profile: any({ preferences: ['大学A'], targetIndustries: ['IT'], name: 'x' }), activity: any({ academics: { detail: 'y' } }) };

// interview selector 入力（InterviewSelectorInput）。externals = companyResearchLog。
type ItvInput = {
  profile: any; activity: any; values: any;
  selfAnalysisLogs: any[]; esLogs: any[]; matchingLogs: any[];
  consultationThreads: any[]; companyResearchLog: any;
  // snapshot 側でのみ意味を持つ（selector には無い）。ignored 確認用に harness だけ保持。
  interviewResults?: any[]; companyResearchLogs?: any[];
};

function base(over: Partial<ItvInput>): ItvInput {
  return {
    profile: null, activity: null, values: null,
    selfAnalysisLogs: [], esLogs: [], matchingLogs: [],
    consultationThreads: [], companyResearchLog: null,
    ...over,
  };
}

const cases: Array<{ name: string; input: ItvInput }> = [
  { name: 'empty', input: base({}) },
  {
    name: 'rich (all present, cr selected)',
    input: base({
      ...baseFilled, values: valuesFilled,
      selfAnalysisLogs: [selfLog('1'), selfLog('2')],
      esLogs: [esLog('1')],
      matchingLogs: [matchLog('1')],
      consultationThreads: [thread(['a', 'b'])],
      companyResearchLog: crLogValid('1'),
    }),
  },
  { name: 'selfAnalysis present', input: base({ selfAnalysisLogs: [selfLog('1')] }) },
  { name: 'selfAnalysis absent', input: base({ selfAnalysisLogs: [] }) },
  { name: 'ES present', input: base({ esLogs: [esLog('1')] }) },
  { name: 'ES absent', input: base({ esLogs: [] }) },
  { name: 'matching present', input: base({ matchingLogs: [matchLog('1'), matchLog('2')] }) },
  { name: 'matching absent', input: base({ matchingLogs: [] }) },
  { name: 'consultationInsights present', input: base({ consultationThreads: [thread(['x', 'y'])] }) },
  { name: 'consultationInsights absent (empty thread)', input: base({ consultationThreads: [thread([])] }) },
  { name: 'consultation absent (no threads)', input: base({ consultationThreads: [] }) },
  { name: 'profile/activity/values present', input: base({ ...baseFilled, values: valuesFilled }) },
  { name: 'profile/activity/values absent', input: base({ profile: null, activity: null, values: null }) },
  { name: 'companyResearchLog 未選択 (null)', input: base({ companyResearchLog: null }) },
  { name: 'companyResearchLog 選択あり (build success)', input: base({ companyResearchLog: crLogValid('2') }) },
  { name: 'companyResearch build throw → null fallback', input: base({ companyResearchLog: crLogThrows() }) },
  // companyResearch logs があっても companyResearchLog=null なら companyResearch=null（logs は selector に無い）。
  { name: 'companyResearch logs present but none selected → null', input: base({ companyResearchLogs: [crLogValid('3')], companyResearchLog: null }) },
  // snapshot 入力に interviewResults があっても interview snapshot は未参照＝出力不変を確認。
  { name: 'interview logs in input (must be ignored)', input: base({ interviewResults: [interviewResult('1')] }) },
];

let mismatches = 0;
for (const c of cases) {
  const { interviewResults = [], companyResearchLogs = [], companyResearchLog, ...rest } = c.input;
  // old: 現行 selector（P5-E 接続後は内部 snapshot 経路）。companyResearchLog は input 内で渡す。
  const oldBody = buildInterviewRequestContext(any({ ...rest, companyResearchLog }));
  // new: raw input → snapshot → projection。companyResearchLog は externals。
  const snapshotInput = {
    profile: rest.profile, activity: rest.activity, values: rest.values,
    selfAnalysisLogs: rest.selfAnalysisLogs, esLogs: rest.esLogs,
    interviewResults, presentationResults: [],
    companyResearchLogs, gdResults: [], gdRoomLogs: [],
    matchingLogs: rest.matchingLogs, consultationThreads: rest.consultationThreads,
  };
  const snapshot = buildCareerMemorySnapshot('interview', any(snapshotInput), { companyResearchLog }) as InterviewMemorySnapshot;
  const newBody = projectInterviewRequestContext(snapshot);

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

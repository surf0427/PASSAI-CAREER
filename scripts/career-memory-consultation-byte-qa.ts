/*
 * scripts/career-memory-consultation-byte-qa.ts
 *
 * PASSAI CAREER — consultation request context の byte 一致 QA（P5-F 常設 harness）。
 *
 * 目的:
 *   consultation selector（buildConsultationRequestContext）の返り値と、
 *   additive snapshot→projection 経路（buildCareerMemorySnapshot('consultation',…)→
 *   projectConsultationRequestContext）の返り値が **byte 一致（key 順込み）** することを常設で守る。
 *   P5-F で consultation production flow を snapshot 経路へ接続した後の回帰ガード。
 *
 * 厳守:
 *   - 本番 route / prompt / AI schema / DB / Supabase を一切変更・参照しない。
 *   - 純粋 fixture のみ（env / secret / 本番データ非接続）。
 *   - consultation のみが対象（matching / presentation / interview は扱わない）。
 *   - gdResultId は snapshot externals として渡す。
 *
 * 使い方: npx tsx scripts/career-memory-consultation-byte-qa.ts
 * 終了コード: 全ケース一致 → 0 / 1 件でも不一致 → 1。
 */

import { buildConsultationRequestContext } from '@/lib/careerMemory/selector';
import {
  buildCareerMemorySnapshot,
  projectConsultationRequestContext,
  type ConsultationMemorySnapshot,
} from '@/lib/careerMemory/snapshot';

/* eslint-disable @typescript-eslint/no-explicit-any */
const any = (v: unknown) => v as any;

// ── fixtures（branch 網羅を優先。malformed でも両経路が同一挙動なら byte 一致する） ──
const selfLog = (id: number) =>
  any({ createdAt: `2026-07-${String(id).padStart(2, '0')}`, result: { summary: `s${id}`, careerDirection: `d${id}`, strengths: [`a${id}`], weaknesses: [], recommendedIndustries: ['IT'], recommendedJobs: ['eng'], companySelectionCriteria: ['x'], gakuchikaIdeas: ['g'] } });
const esLog = (id: number) =>
  any({ createdAt: `2026-06-${String(id).padStart(2, '0')}`, companyName: `Co${id}`, question: `q${id}`, result: { headline: `h${id}`, gakuchika: 'g', selfPr: 'p', motivation: 'm', companyName: `Co${id}`, question: `q${id}` } });
const interviewResult = (id: number) =>
  any({ createdAt: `2026-05-${String(id).padStart(2, '0')}`, result: { overallComment: `oc${id}`, strengths: ['s'], improvements: ['i'], companyFit: 'f' } });
const presResult = (id: number) =>
  any({ createdAt: `2026-04-${String(id).padStart(2, '0')}`, theme: `t${id}`, result: { overallComment: `oc${id}`, improvements: ['i'], companyFit: 'f' } });
const crLog = (id: number) =>
  any({ id: `cr${id}`, companyName: `Co${id}`, industry: 'IT', interestLevel: 'high', verifiedResearchText: 'text', updatedAt: `2026-03-${String(id).padStart(2, '0')}` });
const gdResult = (id: number) =>
  any({ id: `gd${id}`, createdAt: `2026-02-${String(id).padStart(2, '0')}`, participants: [{ id: 'p1', isSelf: true }], feedbacks: [{ participantId: 'p1' }], theme: 'th', format: 'fmt', durationMin: 30 });
const gdRoom = (id: number) =>
  any({ id: `room${id}`, createdAt: `2026-01-${String(id).padStart(2, '0')}`, result: {} });
const matchLog = (id: number) =>
  any({ createdAt: `2025-12-${String(id).padStart(2, '0')}`, result: { careerDirection: 'dir', topCandidates: [], fitSignals: [] } });
const thread = (insights: string[]) =>
  any({ updatedAt: '2026-07-08', messages: [{ role: 'assistant', result: { keyInsights: insights } }] });
const arr = (n: number, f: (i: number) => any) => Array.from({ length: n }, (_, i) => f(i + 1));

const valuesFilled = any({ selections: { priorities: ['p'] }, notes: {}, overallNote: 'o' });
const baseFilled = { profile: any({ preferences: ['大学A'], targetIndustries: ['IT'], name: 'x' }), activity: any({ academics: { detail: 'y' } }) };

// consultation selector 入力（ConsultationSelectorInput）。externals = gdResultId。
type ConInput = {
  profile: any; activity: any; values: any;
  selfAnalysisLogs: any[]; esLogs: any[]; interviewResults: any[]; presentationResults: any[];
  companyResearchLogs: any[]; gdResults: any[]; gdRoomLogs: any[]; matchingLogs: any[];
  gdResultId?: string | null;
  // snapshot 側でのみ意味を持つ（consultation selector には無い）。ignored 確認用。
  consultationThreads?: any[];
};

function base(over: Partial<ConInput>): ConInput {
  return {
    profile: null, activity: null, values: null,
    selfAnalysisLogs: [], esLogs: [], interviewResults: [], presentationResults: [],
    companyResearchLogs: [], gdResults: [], gdRoomLogs: [], matchingLogs: [],
    ...over,
  };
}

const cases: Array<{ name: string; input: ConInput }> = [
  { name: 'empty', input: base({}) },
  {
    name: 'rich (all present)',
    input: base({
      ...baseFilled, values: valuesFilled,
      selfAnalysisLogs: arr(2, selfLog), esLogs: arr(2, esLog),
      interviewResults: arr(2, interviewResult), presentationResults: arr(2, presResult),
      companyResearchLogs: arr(3, crLog), gdResults: arr(2, gdResult),
      gdRoomLogs: arr(2, gdRoom), matchingLogs: arr(2, matchLog), gdResultId: 'gd1',
    }),
  },
  { name: 'profile/activity/values present', input: base({ ...baseFilled, values: valuesFilled }) },
  { name: 'profile/activity/values absent', input: base({}) },
  { name: 'selfAnalysis history present', input: base({ selfAnalysisLogs: arr(2, selfLog) }) },
  { name: 'selfAnalysis history absent', input: base({ selfAnalysisLogs: [] }) },
  { name: 'selfAnalysis history >3 (limit 3)', input: base({ selfAnalysisLogs: arr(5, selfLog) }) },
  { name: 'ES history present', input: base({ esLogs: arr(2, esLog) }) },
  { name: 'ES history absent', input: base({ esLogs: [] }) },
  { name: 'ES history >3 (limit 3)', input: base({ esLogs: arr(5, esLog) }) },
  { name: 'interview history present', input: base({ interviewResults: arr(2, interviewResult) }) },
  { name: 'interview history absent', input: base({ interviewResults: [] }) },
  { name: 'interview history >3 (limit 3)', input: base({ interviewResults: arr(5, interviewResult) }) },
  { name: 'presentation history present', input: base({ presentationResults: arr(2, presResult) }) },
  { name: 'presentation history absent', input: base({ presentationResults: [] }) },
  { name: 'presentation history >3 (limit 3)', input: base({ presentationResults: arr(5, presResult) }) },
  { name: 'companyResearch present', input: base({ companyResearchLogs: arr(3, crLog) }) },
  { name: 'companyResearch absent', input: base({ companyResearchLogs: [] }) },
  { name: 'companyResearch >5 (limit 5)', input: base({ companyResearchLogs: arr(7, crLog) }) },
  { name: 'GD result id MATCH', input: base({ gdResults: arr(3, gdResult), gdResultId: 'gd2' }) },
  { name: 'GD result id MISMATCH', input: base({ gdResults: arr(3, gdResult), gdResultId: 'gd999' }) },
  { name: 'GD result id NONE', input: base({ gdResults: arr(3, gdResult), gdResultId: null }) },
  { name: 'GD solo logs present', input: base({ gdResults: arr(2, gdResult) }) },
  { name: 'GD solo logs absent', input: base({ gdResults: [] }) },
  { name: 'GD solo logs >2 (limit 2, no id)', input: base({ gdResults: arr(4, gdResult), gdResultId: null }) },
  { name: 'GD room logs present', input: base({ gdRoomLogs: arr(2, gdRoom) }) },
  { name: 'GD room logs absent', input: base({ gdRoomLogs: [] }) },
  { name: 'GD room logs >3 (limit 3)', input: base({ gdRoomLogs: arr(5, gdRoom) }) },
  { name: 'matching logs present', input: base({ matchingLogs: arr(2, matchLog) }) },
  { name: 'matching logs absent', input: base({ matchingLogs: [] }) },
  { name: 'matching logs >2 (limit 2)', input: base({ matchingLogs: arr(4, matchLog) }) },
  // snapshot 入力に consultationThreads があっても consultation snapshot は未参照＝出力不変を確認。
  { name: 'consultation logs in input (must be ignored)', input: base({ consultationThreads: [thread(['a', 'b'])] }) },
];

let mismatches = 0;
for (const c of cases) {
  const { gdResultId, consultationThreads = [], ...rest } = c.input;
  // old: 現行 selector（P5-F 接続後は内部 snapshot 経路）。gdResultId は input 内で渡す。
  const oldBody = buildConsultationRequestContext(any({ ...rest, gdResultId }));
  // new: raw input → snapshot → projection。gdResultId は externals。
  const snapshotInput = { ...rest, consultationThreads };
  const snapshot = buildCareerMemorySnapshot('consultation', any(snapshotInput), { gdResultId }) as ConsultationMemorySnapshot;
  const newBody = projectConsultationRequestContext(snapshot);

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

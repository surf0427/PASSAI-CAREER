/*
 * scripts/career-memory-matching-byte-qa.ts
 *
 * PASSAI CAREER — matching request context の byte 一致 QA（P5-C 常設 harness）。
 *
 * 目的:
 *   matching selector（buildMatchingRequestContext）の返り値と、
 *   additive snapshot→projection 経路（buildCareerMemorySnapshot('matching',…)→
 *   projectMatchingRequestContext）の返り値が **byte 一致（key 順込み）** することを常設で守る。
 *   P5-C で matching production flow を snapshot 経路へ pilot 接続した後の回帰ガード。
 *
 * 厳守:
 *   - 本番 route / prompt / AI schema / DB / Supabase を一切変更・参照しない。
 *   - 純粋 fixture のみ（env / secret / 本番データ非接続）。
 *   - matching のみが対象（consultation / interview / presentation は扱わない）。
 *
 * 使い方: npx tsx scripts/career-memory-matching-byte-qa.ts
 * 終了コード: 全ケース一致 → 0 / 1 件でも不一致 → 1。
 */

import { buildMatchingRequestContext } from '@/lib/careerMemory/selector';
import {
  buildCareerMemorySnapshot,
  projectMatchingRequestContext,
  type MatchingMemorySnapshot,
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
const gdResult = (id: string) =>
  any({ id: `gd${id}`, createdAt: `2026-02-0${id}`, participants: [{ id: 'p1', isSelf: true }], feedbacks: [{ participantId: 'p1' }], theme: 'th', format: 'fmt', durationMin: 30 });
const gdRoom = (id: string) =>
  any({ id: `room${id}`, createdAt: `2026-01-0${id}`, result: {} });
const matchLog = (id: string) =>
  any({ createdAt: `2025-12-0${id}`, result: { careerDirection: 'dir', topCandidates: [], fitSignals: [] } });
const thread = (insights: string[]) =>
  any({ updatedAt: '2026-07-08', messages: [{ role: 'user' }, { role: 'assistant', result: { keyInsights: insights, currentFocus: 'f', openConcerns: [], recentActions: [] } }] });

const valuesFilled = any({ selections: { priorities: ['p'] }, notes: {}, overallNote: 'o' });
const baseFilled = { profile: any({ preferences: ['大学A'], targetIndustries: ['IT'], name: 'x' }), activity: any({ academics: { detail: 'y' } }) };

// matching selector 入力（MatchingSelectorInput）。
type MatchingInput = {
  profile: any; activity: any; values: any;
  selfAnalysisLogs: any[]; esLogs: any[]; interviewResults: any[];
  consultationThreads: any[]; gdResults: any[]; gdRoomLogs: any[];
  gdResultId?: string | null;
};

function base(over: Partial<MatchingInput>): MatchingInput {
  return {
    profile: null, activity: null, values: null,
    selfAnalysisLogs: [], esLogs: [], interviewResults: [],
    consultationThreads: [], gdResults: [], gdRoomLogs: [],
    ...over,
  };
}

const cases: Array<{ name: string; input: MatchingInput }> = [
  { name: 'empty', input: base({}) },
  {
    name: 'rich (all present)',
    input: base({
      ...baseFilled, values: valuesFilled,
      selfAnalysisLogs: [selfLog('1'), selfLog('2')],
      esLogs: [esLog('1')],
      interviewResults: [interviewResult('1'), interviewResult('2')],
      consultationThreads: [thread(['a', 'b'])],
      gdResults: [gdResult('1'), gdResult('2')],
      gdRoomLogs: [gdRoom('1'), gdRoom('2')],
      gdResultId: 'gd1',
    }),
  },
  { name: 'selfAnalysis present', input: base({ selfAnalysisLogs: [selfLog('1')] }) },
  { name: 'selfAnalysis absent', input: base({ selfAnalysisLogs: [] }) },
  { name: 'ES present', input: base({ esLogs: [esLog('1')] }) },
  { name: 'ES absent', input: base({ esLogs: [] }) },
  { name: 'interviewResult present', input: base({ interviewResults: [interviewResult('1')] }) },
  { name: 'interviewResult absent', input: base({ interviewResults: [] }) },
  { name: 'consultation present', input: base({ consultationThreads: [thread(['x'])] }) },
  { name: 'consultation absent', input: base({ consultationThreads: [] }) },
  { name: 'matching logs present (ignored by matching)', input: base({}) },
  { name: 'GD result id MATCH', input: base({ gdResults: [gdResult('1'), gdResult('2')], gdResultId: 'gd2' }) },
  { name: 'GD result id MISMATCH', input: base({ gdResults: [gdResult('1'), gdResult('2')], gdResultId: 'gd999' }) },
  { name: 'GD result id NONE', input: base({ gdResults: [gdResult('1')], gdResultId: null }) },
  { name: 'GD room logs present', input: base({ gdRoomLogs: [gdRoom('1'), gdRoom('2')] }) },
  { name: 'GD room logs absent', input: base({ gdRoomLogs: [] }) },
  { name: 'values present', input: base({ values: valuesFilled }) },
  { name: 'values absent', input: base({ values: null }) },
];

// matchLog は matching selector 入力に無いため参照だけ確認（unused 警告回避）。
void matchLog;

let mismatches = 0;
for (const c of cases) {
  const { gdResultId, ...rest } = c.input;
  // old: 現行 selector（P5-C 接続後は内部 snapshot 経路。接続前は直接組み立て）。
  const oldBody = buildMatchingRequestContext(any(c.input));
  // new: raw input → snapshot → projection。
  const snapshotInput = {
    profile: rest.profile, activity: rest.activity, values: rest.values,
    selfAnalysisLogs: rest.selfAnalysisLogs, esLogs: rest.esLogs,
    interviewResults: rest.interviewResults, presentationResults: [],
    companyResearchLogs: [], gdResults: rest.gdResults, gdRoomLogs: rest.gdRoomLogs,
    matchingLogs: [], consultationThreads: rest.consultationThreads,
  };
  const snapshot = buildCareerMemorySnapshot('matching', any(snapshotInput), { gdResultId }) as MatchingMemorySnapshot;
  const newBody = projectMatchingRequestContext(snapshot);

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

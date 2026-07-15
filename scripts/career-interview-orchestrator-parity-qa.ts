/*
 * scripts/career-interview-orchestrator-parity-qa.ts
 *
 * PASSAI CAREER — P15-B: 面接評価 prompt の byte parity QA（dev-only 常設 harness）。
 *
 * 目的（P15-B）:
 *   「面接機能で利用している機能横断 context の組み立てを Context Orchestrator 側へ移す」構造変更の
 *   前後で、production の buildInterviewBaseSystem / buildFinalFeedbackInstruction / buildSeedUserPrompt /
 *   buildFollowupUserPrompt / buildFinalUserPrompt が生成する start / turn / complete の完成 prompt が
 *   **UTF-8 byte 列として同一**であることを常設で守る。
 *
 *   golden は「リファクタ前（HEAD）の出力」を固定したもの。リファクタ後に本 harness を無引数で回し、
 *   全 fixture / stage / mode で EXACT_MATCH（byte 差 0 / hash 一致 / line 不変 / 見出し不変 / PII 不変）
 *   を受入条件とする。
 *
 * 厳守:
 *   - production の純関数（interviewPrompt.ts の export 群）を **読むだけ**。
 *   - route / prompt 文面 / AI schema / request・response body / model / timeout / retry / DB / Supabase /
 *     env / secret 非接続。外部 AI 非実行・実データ非参照。日時・乱数・不安定 key 順を持ち込まない。
 *   - interview のみが対象（presentation / consultation / matching route は扱わない）。
 *
 * 使い方:
 *   npx tsx scripts/career-interview-orchestrator-parity-qa.ts            # golden と比較（既定）
 *   npx tsx scripts/career-interview-orchestrator-parity-qa.ts --update   # 現在の出力を golden に固定
 * 終了コード: 全比較 EXACT_MATCH → 0 / 1 件でも差分 → 1。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  buildInterviewBaseSystem,
  buildFinalFeedbackInstruction,
  buildSeedUserPrompt,
  buildFollowupUserPrompt,
  buildFinalUserPrompt,
  type CareerInterviewContextInput,
} from '@/app/api/career/interview/interviewPrompt';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import type {
  CareerInterviewType,
  CareerInterviewTarget,
  CareerInterviewTurn,
} from '@/types/careerInterview';
import type { InterviewCompanyResearchContext } from '@/lib/careerCompanyResearch/context';

const cast = <T>(v: unknown): T => v as T;

const GOLDEN_DIR = join(process.cwd(), 'scripts/fixtures/interview-orchestrator-parity');
const UPDATE = process.argv.includes('--update') || process.env.UPDATE === '1';

// ── 決定的な cross-feature 部品（domain 型に薄くキャスト。branch 網羅の固定値のみ） ──
const selfAnalysis = (tag: string): CareerSelfAnalysisResult =>
  cast({
    summary: `全体所感${tag}`,
    strengths: [`強みA${tag}`, `強みB${tag}`],
    weaknesses: [`弱み${tag}`],
    developmentPoints: [`伸ばす点${tag}`],
    gakuchikaIdeas: [`ガクチカ${tag}`],
    selfPrIdeas: [`自己PR${tag}`],
    careerDirection: `方向性${tag}`,
  });

const es = (tag: string): CareerEsResult =>
  cast({
    headline: `キャッチ${tag}`,
    gakuchika: `ガクチカ本文${tag}`,
    selfPr: `自己PR本文${tag}`,
    motivation: `志望動機${tag}`,
    appealPoints: ['論点1', '論点2'],
    companyName: `Co${tag}`,
  });

const matching = (tag: string): CareerMatchEngineResult =>
  cast({
    careerType: `適性タイプ${tag}`,
    recommendedIndustries: ['IT・通信', 'コンサル', '商社', '金融', 'メーカー', '広告'],
    recommendedJobs: ['エンジニア', '営業', '企画', 'コンサル', 'マーケ', 'PdM'],
    developmentAreas: ['定量化', '構造化', '巻き込み', '発信', '継続'],
  });

const consultationInsights = (tag: string): string[] => [
  `気づき1${tag}`,
  `気づき2${tag}`,
  ` `, // 空白のみ（trim で落ちる branch）
  `気づき3${tag}`,
  `気づき4${tag}`,
  `気づき5${tag}`,
  `気づき6${tag}`, // slice(0,5) で落ちる branch
];

const companyResearch = (tag: string): InterviewCompanyResearchContext =>
  cast({
    logId: `log${tag}`,
    companyName: `サンプル株式会社${tag}`,
    industry: 'IT・通信',
    interestLevel: 'high',
    interviewContextSummary: `面接連携メモ${tag}`,
    fitSummary: `適合分析${tag}`,
    reviewSummary: `添削サマリ${tag}`,
    verifiedResearchTextPreview: `本人記述抜粋${tag}`,
  });

const target = (tag: string): CareerInterviewTarget => ({
  companyName: `志望企業${tag}`,
  industry: 'IT・通信',
  jobType: 'エンジニア',
  selectionType: 'main',
  interviewPhase: 'final',
  companyMemo: `企業メモ${tag}`,
  focusPoint: `対策したい点${tag}`,
});

const profileWithPii = cast<CareerInterviewContextInput['profile']>({
  name: '山田太郎',
  targetIndustries: ['IT'],
  preferences: ['大学A'],
});

const activityMulti = cast<CareerInterviewContextInput['activity']>({
  academics: { detail: '研究室でのデータ分析' },
  extracurricular: { detail: 'サークルの代表として運営' },
  work: { detail: '長期インターンで新規事業開発' },
});

const values = cast<CareerInterviewContextInput['values']>({
  selections: { priorities: ['成長', '社会貢献'] },
  overallNote: '裁量のある環境で働きたい',
});

// ── fixtures（P15-B 受入条件の網羅。presentation-history / gd-history は interview の
//    cross-feature 入力に該当フィールドが無い＝base path を通ることを固定する） ──
type Fixture = { name: string; base: Omit<CareerInterviewContextInput, 'interviewType'> };
const FIXTURES: Fixture[] = [
  { name: 'normal', base: { selfAnalysis: selfAnalysis('N'), es: es('N'), matching: matching('N'), consultationInsights: consultationInsights('N') } },
  {
    name: 'heavy',
    base: {
      profile: profileWithPii, activity: activityMulti, values,
      selfAnalysis: selfAnalysis('H'), es: es('H'), matching: matching('H'),
      consultationInsights: consultationInsights('H'), companyResearch: companyResearch('H'), target: target('H'),
    },
  },
  { name: 'missing', base: {} },
  { name: 'pii-profile', base: { profile: profileWithPii } },
  { name: 'activity-multi-section', base: { activity: activityMulti } },
  { name: 'self-analysis-multi', base: { selfAnalysis: selfAnalysis('S') } },
  { name: 'es-multi', base: { es: es('E') } },
  { name: 'matching-multi', base: { matching: matching('M') } },
  { name: 'consultation-multi', base: { consultationInsights: consultationInsights('C') } },
  { name: 'company-research', base: { companyResearch: companyResearch('R'), target: target('R') } },
  // interview は presentation / GD の過去結果を cross-feature 入力に持たない（該当フィールド無し）。
  //   base path（横断ブロック無し）を通ることを固定する回帰ガード。
  { name: 'presentation-history', base: {} },
  { name: 'gd-history', base: {} },
  {
    name: 'all-context',
    base: {
      profile: profileWithPii, activity: activityMulti, values,
      selfAnalysis: selfAnalysis('A'), es: es('A'), matching: matching('A'),
      consultationInsights: consultationInsights('A'), companyResearch: companyResearch('A'), target: target('A'),
    },
  },
];

const ALL_MODES: CareerInterviewType[] = ['self_analysis', 'gakuchika', 'self_pr', 'motivation', 'real', 'pressure'];

// 比較対象 (fixture, mode) の組。
//   - 13 fixtures × mode=real（cross-feature parity を stage 横断で網羅）。
//   - all-context × 全 mode（mode 分岐 parity を stage 横断で網羅）。real は重複するため除外。
type Pair = { fixture: Fixture; mode: CareerInterviewType };
const PAIRS: Pair[] = [
  ...FIXTURES.map((f) => ({ fixture: f, mode: 'real' as CareerInterviewType })),
  ...ALL_MODES.filter((m) => m !== 'real').map((m) => ({
    fixture: FIXTURES.find((f) => f.name === 'all-context')!,
    mode: m,
  })),
];

// 会話履歴（turn / complete 用。決定的な固定 transcript）。
const TURNS: CareerInterviewTurn[] = [
  cast({ role: 'question', content: '学生時代に力を入れたことを教えてください。' }),
  cast({ role: 'answer', content: '長期インターンで新規事業開発に取り組みました。' }),
  cast({ role: 'question', content: 'その中で最も苦労した点は何ですか。' }),
  cast({ role: 'answer', content: '要件が曖昧な中での優先順位づけに苦労しました。' }),
];

// 見出し（byte parity の観測対象。interview cross-feature の見出し）。
const HEADINGS = [
  '# 直近の自己分析結果',
  '# 直近の ES ドラフト',
  '# 就活マッチング結果（参考・断定しない）',
  '# 相談AIでの最近の気づき（参考程度）',
  '【企業研究コンテキスト（ユーザー本人が作成・保存したもの）】',
];
const PII_NAME = '山田太郎';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const countOccur = (s: string, sub: string) => (sub === '' ? 0 : s.split(sub).length - 1);
const lineCount = (s: string) => s.split('\n').length;

// 各 stage の完成 prompt（route と同じ組み立て）。
function buildStages(input: CareerInterviewContextInput): Record<string, { system: string; user: string }> {
  const it = input.interviewType;
  const startSystem = buildInterviewBaseSystem(input);
  const hasCompanyResearch = !!input.companyResearch;
  const completeSystem = [
    buildInterviewBaseSystem(input),
    buildFinalFeedbackInstruction(it, hasCompanyResearch, input.target),
  ].join('\n\n');
  return {
    // seed/followup は target がある fixture でのみ operative な入口・優先度指示が増える
    //   （target 無し fixture では第3引数 undefined ＝ byte 不変）。route と同じ配線。
    start: { system: startSystem, user: buildSeedUserPrompt(it, input.target) },
    // turn は base system を共有し、user が followup。
    turn: { system: startSystem, user: buildFollowupUserPrompt(TURNS, it, input.target) },
    complete: { system: completeSystem, user: buildFinalUserPrompt(TURNS) },
  };
}

type Metrics = {
  systemBytes: number; systemHash: string; systemLines: number;
  userBytes: number; userHash: string; userLines: number;
  headingCounts: Record<string, number>;
  piiCount: number;
};

function metricsOf(system: string, user: string): Metrics {
  const headingCounts: Record<string, number> = {};
  for (const h of HEADINGS) headingCounts[h] = countOccur(system, h);
  return {
    systemBytes: bytes(system), systemHash: sha256(system), systemLines: lineCount(system),
    userBytes: bytes(user), userHash: sha256(user), userLines: lineCount(user),
    headingCounts,
    piiCount: countOccur(system, PII_NAME) + countOccur(user, PII_NAME),
  };
}

const key = (fixtureName: string, mode: string, stage: string) => `${fixtureName}__${mode}__${stage}`;
const goldenPath = (k: string) => join(GOLDEN_DIR, `${k}.txt`);
const metricsPath = (k: string) => join(GOLDEN_DIR, `${k}.metrics.json`);

if (UPDATE && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

let failures = 0;
const note = (ok: boolean, msg: string) => {
  if (!ok) {
    console.log(`❌ ${msg}`);
    failures++;
  }
};

console.log(`# interview orchestrator byte parity QA (${UPDATE ? 'UPDATE' : 'COMPARE'})`);
console.log('');
console.log('| Fixture | Mode | Stage | sys bytes | sys lines | hash(head) | pii | 判定 |');
console.log('|---|---|---|---:|---:|---|---:|---|');

let compared = 0;
let exactCount = 0;

for (const { fixture, mode } of PAIRS) {
  const input: CareerInterviewContextInput = { ...fixture.base, interviewType: mode };
  const stages = buildStages(input);
  for (const stage of ['start', 'turn', 'complete']) {
    const { system, user } = stages[stage];
    const m = metricsOf(system, user);
    const k = key(fixture.name, mode, stage);
    // 完成 prompt（system + user）を 1 つの golden として固定する。
    const combined = `===SYSTEM===\n${system}\n===USER===\n${user}`;

    if (UPDATE) {
      writeFileSync(goldenPath(k), combined, 'utf8');
      writeFileSync(metricsPath(k), JSON.stringify(m, null, 2) + '\n', 'utf8');
      console.log(`| ${fixture.name} | ${mode} | ${stage} | ${m.systemBytes} | ${m.systemLines} | ${m.systemHash.slice(0, 10)} | ${m.piiCount} | WROTE |`);
      continue;
    }

    compared++;
    if (!existsSync(goldenPath(k)) || !existsSync(metricsPath(k))) {
      note(false, `golden 欠落 | ${k}`);
      console.log(`| ${fixture.name} | ${mode} | ${stage} | ${m.systemBytes} | ${m.systemLines} | ${m.systemHash.slice(0, 10)} | ${m.piiCount} | NO_GOLDEN |`);
      continue;
    }
    const goldenCombined = readFileSync(goldenPath(k), 'utf8');
    const goldenM = cast<Metrics>(JSON.parse(readFileSync(metricsPath(k), 'utf8')));

    const byteEqual = Buffer.compare(Buffer.from(combined, 'utf8'), Buffer.from(goldenCombined, 'utf8')) === 0;
    const sysHashEqual = m.systemHash === goldenM.systemHash;
    const userHashEqual = m.userHash === goldenM.userHash;
    const lineEqual = m.systemLines === goldenM.systemLines && m.userLines === goldenM.userLines;
    const headingsEqual = HEADINGS.every((h) => m.headingCounts[h] === goldenM.headingCounts[h]);
    const piiNotIncreased = m.piiCount <= goldenM.piiCount;
    const budgetNotIncreased = m.systemBytes <= goldenM.systemBytes && m.userBytes <= goldenM.userBytes;

    const exact = byteEqual && sysHashEqual && userHashEqual && lineEqual && headingsEqual && piiNotIncreased && budgetNotIncreased;
    if (exact) exactCount++;
    console.log(`| ${fixture.name} | ${mode} | ${stage} | ${m.systemBytes} | ${m.systemLines} | ${m.systemHash.slice(0, 10)} | ${m.piiCount} | ${exact ? 'EXACT_MATCH' : 'DIFF'} |`);

    note(byteEqual, `byte 列一致 | ${k}`);
    note(sysHashEqual, `system hash 一致 | ${k}`);
    note(userHashEqual, `user hash 一致 | ${k}`);
    note(lineEqual, `line 数一致 | ${k}`);
    note(headingsEqual, `見出し出現数一致 | ${k}`);
    note(piiNotIncreased, `PII 出現増加なし | ${k} (${m.piiCount} <= ${goldenM.piiCount})`);
    note(budgetNotIncreased, `prompt byte budget 増加なし | ${k}`);

    if (!byteEqual) {
      let i = 0;
      while (i < combined.length && i < goldenCombined.length && combined[i] === goldenCombined[i]) i++;
      console.log(`   first diff at char ${i}:`);
      console.log(`   new: ${JSON.stringify(combined.slice(Math.max(0, i - 20), i + 40))}`);
      console.log(`   old: ${JSON.stringify(goldenCombined.slice(Math.max(0, i - 20), i + 40))}`);
    }
  }
}

console.log('');
if (UPDATE) {
  console.log('GOLDEN_WRITTEN');
  process.exit(0);
}
console.log(`compared=${compared} exact=${exactCount}`);
console.log(failures === 0 ? 'ALL_EXACT_MATCH' : `FAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

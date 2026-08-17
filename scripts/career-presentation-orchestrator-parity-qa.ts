/*
 * scripts/career-presentation-orchestrator-parity-qa.ts
 *
 * PASSAI CAREER — P15-A: presentation 評価 system prompt の byte parity QA（dev-only 常設 harness）。
 *
 * 目的（P15-A）:
 *   「プレゼン評価で利用している機能横断 context の組み立てを Context Orchestrator 側へ移す」
 *   構造変更の前後で、production の buildPresentationBaseSystem / buildEvaluateInstruction が生成する
 *   system prompt が **UTF-8 byte 列として同一**であることを常設で守る。
 *
 *   golden は「リファクタ前（HEAD）の出力」を固定したもの。リファクタ後に本 harness を無引数で回し、
 *   全 fixture EXACT_MATCH（byte 差 0 / hash 一致 / 見出し数不変 / PII 出現不変）を受入条件とする。
 *
 * 厳守:
 *   - production の純関数（buildPresentationBaseSystem / buildEvaluateInstruction）を **読むだけ**。
 *   - route / prompt 文面 / AI schema / request・response body / DB / Supabase / env / secret 非接続。
 *   - 外部 AI 非実行・実データ非参照。日時・乱数・不安定 key 順を持ち込まない（決定的 fixture のみ）。
 *   - presentation のみが対象（interview / consultation / matching route は扱わない）。
 *
 * 使い方:
 *   npx tsx scripts/career-presentation-orchestrator-parity-qa.ts            # golden と比較（既定）
 *   npx tsx scripts/career-presentation-orchestrator-parity-qa.ts --update   # 現在の出力を golden に固定
 * 終了コード: 全 fixture EXACT_MATCH → 0 / 1 件でも差分 → 1。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  buildPresentationBaseSystem,
  buildEvaluateInstruction,
  type CareerPresentationContextInput,
} from '@/app/api/career/presentation/presentationPrompt';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import type { PresentationEsSummary } from '@/lib/careerMemory/presentationEs';
import type { CareerPresentationConfig } from '@/types/careerPresentation';

const cast = <T>(v: unknown): T => v as T;

const GOLDEN_DIR = join(process.cwd(), 'scripts/fixtures/presentation-orchestrator-parity');
const UPDATE = process.argv.includes('--update') || process.env.UPDATE === '1';

// ── 決定的な cross-feature 部品（domain 型に薄くキャスト。branch を網羅する固定値のみ） ──
const selfAnalysis = (tag: string): CareerSelfAnalysisResult =>
  cast({
    summary: `全体所感${tag}`,
    strengths: [`強みA${tag}`, `強みB${tag}`],
    weaknesses: [`弱み${tag}`],
    gakuchikaIdeas: [`ガクチカ${tag}`],
    selfPrIdeas: [`自己PR${tag}`],
    careerDirection: `方向性${tag}`,
  });

const es = (tag: string): PresentationEsSummary => ({
  headline: `キャッチ${tag}`,
  gakuchika: `ガクチカ本文${tag}`,
  selfPr: `自己PR本文${tag}`,
  motivation: `志望動機${tag}`,
});

const interview = (tag: string): CareerInterviewFinalResult =>
  cast({
    overallComment: `面接総評${tag}`,
    strengths: [`面接良点${tag}`],
    improvements: [`面接改善${tag}`],
  });

const matching = (tag: string): CareerMatchEngineResult =>
  cast({
    careerType: `適性タイプ${tag}`,
    recommendedIndustries: ['IT・通信', 'コンサル', '商社', '金融', 'メーカー', '広告'],
    recommendedJobs: ['エンジニア', '営業', '企画', 'コンサル', 'マーケ', 'PdM'],
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

const profileWithPii = cast<CareerPresentationContextInput['profile']>({
  name: '山田太郎',
  targetIndustries: ['IT'],
  preferences: ['大学A'],
});

const activityMulti = cast<CareerPresentationContextInput['activity']>({
  academics: { detail: '研究室でのデータ分析' },
  extracurricular: { detail: 'サークルの代表として運営' },
  work: { detail: '長期インターンで新規事業開発' },
});

const values = cast<CareerPresentationContextInput['values']>({
  selections: { priorities: ['成長', '社会貢献'] },
  overallNote: '裁量のある環境で働きたい',
});

const cfg = (over: Partial<CareerPresentationConfig>): CareerPresentationConfig => ({
  useCareerContext: true,
  ...over,
});

// ── 10 fixtures（P15-A 受入条件の必須網羅） ──
type Fixture = { name: string; input: CareerPresentationContextInput };
const FIXTURES: Fixture[] = [
  {
    name: 'normal',
    input: {
      theme: '自分を漢字一文字で表すと',
      config: cfg({ companyName: 'サンプル株式会社', industry: 'IT・通信', jobType: 'エンジニア' }),
      selfAnalysis: selfAnalysis('N'),
      es: es('N'),
      interview: interview('N'),
      matching: matching('N'),
      consultationInsights: consultationInsights('N'),
    },
  },
  {
    name: 'heavy',
    input: {
      theme: 'あなたが学生時代に最も力を入れたことと、そこから得た学びを踏まえた自己PR',
      config: cfg({
        companyName: 'サンプル株式会社',
        industry: 'IT・通信',
        jobType: 'プロダクトマネージャー',
        focusPoint: '結論ファーストで話す練習',
        note: '緊張すると早口になりがち',
        evaluationFocus: ['structure', 'persuasion'],
      }),
      profile: profileWithPii,
      activity: activityMulti,
      values,
      selfAnalysis: selfAnalysis('H'),
      es: es('H'),
      interview: interview('H'),
      matching: matching('H'),
      consultationInsights: consultationInsights('H'),
    },
  },
  {
    // useCareerContext off + 全 cross-feature 入力あり → cross block は 0（gate off）
    name: 'missing',
    input: {
      theme: '',
      config: cfg({ useCareerContext: false }),
      selfAnalysis: selfAnalysis('M'),
      es: es('M'),
      interview: interview('M'),
      matching: matching('M'),
      consultationInsights: consultationInsights('M'),
    },
  },
  {
    name: 'pii-profile',
    input: {
      theme: 'PII を含む profile',
      config: cfg({}),
      profile: profileWithPii,
    },
  },
  {
    name: 'activity-multi-section',
    input: {
      theme: '活動が複数セクション',
      config: cfg({}),
      activity: activityMulti,
    },
  },
  {
    name: 'self-analysis-multi',
    input: {
      theme: '自己分析のみ',
      config: cfg({}),
      selfAnalysis: selfAnalysis('S'),
    },
  },
  {
    name: 'es-multi',
    input: {
      theme: 'ES のみ',
      config: cfg({}),
      es: es('E'),
    },
  },
  {
    name: 'interview-multi',
    input: {
      theme: '面接のみ',
      config: cfg({}),
      interview: interview('I'),
    },
  },
  {
    // company research は presentation の cross-feature には無い（companyContext:'exclude'）。
    // ★ 旧 config.companyMemo（企業について分かっていること）は廃止したため、
    //   企業情報経路は config.companyName（＋業界/職種）が代表する。
    name: 'company-research',
    input: {
      theme: '企業情報あり',
      config: cfg({
        companyName: 'サンプル株式会社',
        industry: 'IT・通信',
      }),
      matching: matching('C'),
    },
  },
  {
    name: 'all-context',
    input: {
      theme: '全 context 投入',
      config: cfg({
        companyName: 'サンプル株式会社',
        industry: 'IT・通信',
        jobType: 'エンジニア',
        focusPoint: '構成',
        note: 'メモ',
        evaluationFocus: ['structure', 'clarity', 'persuasion'],
      }),
      profile: profileWithPii,
      activity: activityMulti,
      values,
      selfAnalysis: selfAnalysis('A'),
      es: es('A'),
      interview: interview('A'),
      matching: matching('A'),
      consultationInsights: consultationInsights('A'),
    },
  },
];

// 見出し（byte parity の観測対象）。
const HEADINGS = [
  '# 参考情報の扱い（重要）',
  '# 参考: 直近の自己分析結果（発表の主役ではない）',
  '# 参考: 直近の ES ドラフト（発表の主役ではない）',
  '# 参考: 直近のAI面接フィードバック',
  '# 参考: 就活マッチング結果（断定しない）',
  '# 参考: 相談AIでの最近の気づき',
];
// raw text guard 対象（禁止 PII: 氏名）。
const PII_NAME = '山田太郎';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const countOccur = (s: string, sub: string) => (sub === '' ? 0 : s.split(sub).length - 1);
const lineCount = (s: string) => s.split('\n').length;

// 評価 route（app/api/career/presentation/evaluate/route.ts 160-174）と同じ組み立て。
function buildFullSystem(input: CareerPresentationContextInput): string {
  const base = buildPresentationBaseSystem(input);
  const instruction = buildEvaluateInstruction({ theme: input.theme ?? '', config: input.config ?? null });
  return [base, instruction].join('\n\n');
}

type Metrics = {
  systemBytes: number;
  systemHash: string;
  systemLines: number;
  headingCounts: Record<string, number>;
  piiCount: number;
};

function metricsOf(system: string): Metrics {
  const headingCounts: Record<string, number> = {};
  for (const h of HEADINGS) headingCounts[h] = countOccur(system, h);
  return {
    systemBytes: bytes(system),
    systemHash: sha256(system),
    systemLines: lineCount(system),
    headingCounts,
    piiCount: countOccur(system, PII_NAME),
  };
}

const goldenPath = (name: string) => join(GOLDEN_DIR, `${name}.txt`);
const metricsPath = (name: string) => join(GOLDEN_DIR, `${name}.metrics.json`);

if (UPDATE && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

let failures = 0;
const note = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) failures++;
};

console.log(`# presentation orchestrator byte parity QA (${UPDATE ? 'UPDATE' : 'COMPARE'})`);
console.log('');
console.log('| Fixture | bytes | lines | hash(head) | pii | 判定 |');
console.log('|---|---:|---:|---|---:|---|');

for (const f of FIXTURES) {
  const system = buildFullSystem(f.input);
  const m = metricsOf(system);
  const gPath = goldenPath(f.name);
  const mPath = metricsPath(f.name);

  if (UPDATE) {
    writeFileSync(gPath, system, 'utf8');
    writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n', 'utf8');
    console.log(`| ${f.name} | ${m.systemBytes} | ${m.systemLines} | ${m.systemHash.slice(0, 12)} | ${m.piiCount} | WROTE |`);
    continue;
  }

  if (!existsSync(gPath) || !existsSync(mPath)) {
    note(false, `golden 欠落 | ${f.name}（--update で生成）`);
    console.log(`| ${f.name} | ${m.systemBytes} | ${m.systemLines} | ${m.systemHash.slice(0, 12)} | ${m.piiCount} | NO_GOLDEN |`);
    continue;
  }

  const goldenSystem = readFileSync(gPath, 'utf8');
  const goldenM = cast<Metrics>(JSON.parse(readFileSync(mPath, 'utf8')));

  const byteEqual = Buffer.compare(Buffer.from(system, 'utf8'), Buffer.from(goldenSystem, 'utf8')) === 0;
  const hashEqual = m.systemHash === goldenM.systemHash;
  const byteCountEqual = m.systemBytes === goldenM.systemBytes;
  const lineEqual = m.systemLines === goldenM.systemLines;
  const headingsEqual = HEADINGS.every((h) => m.headingCounts[h] === goldenM.headingCounts[h]);
  const piiNotIncreased = m.piiCount <= goldenM.piiCount;
  const budgetNotIncreased = m.systemBytes <= goldenM.systemBytes;

  const exact = byteEqual && hashEqual && byteCountEqual && lineEqual && headingsEqual && piiNotIncreased && budgetNotIncreased;
  const verdict = exact ? 'EXACT_MATCH' : 'DIFF';
  console.log(`| ${f.name} | ${m.systemBytes} | ${m.systemLines} | ${m.systemHash.slice(0, 12)} | ${m.piiCount} | ${verdict} |`);

  note(byteEqual, `byte 列一致 | ${f.name}`);
  note(hashEqual, `hash 一致 | ${f.name}`);
  note(byteCountEqual, `byte 数一致 | ${f.name} (${m.systemBytes} vs ${goldenM.systemBytes})`);
  note(lineEqual, `line 数一致 | ${f.name} (${m.systemLines} vs ${goldenM.systemLines})`);
  note(headingsEqual, `見出し出現数一致 | ${f.name}`);
  note(piiNotIncreased, `PII 出現増加なし | ${f.name} (${m.piiCount} <= ${goldenM.piiCount})`);
  note(budgetNotIncreased, `prompt byte budget 増加なし | ${f.name}`);

  if (!byteEqual) {
    // 最初の差分位置を表示（デバッグ用）。
    const a = system;
    const b = goldenSystem;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.log(`   first diff at char ${i}:`);
    console.log(`   new: ${JSON.stringify(a.slice(Math.max(0, i - 20), i + 40))}`);
    console.log(`   old: ${JSON.stringify(b.slice(Math.max(0, i - 20), i + 40))}`);
  }
}

console.log('');
if (UPDATE) {
  console.log('GOLDEN_WRITTEN');
  process.exit(0);
}
console.log(failures === 0 ? 'ALL_EXACT_MATCH' : `FAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

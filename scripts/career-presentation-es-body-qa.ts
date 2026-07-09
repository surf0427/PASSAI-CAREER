/*
 * scripts/career-presentation-es-body-qa.ts
 *
 * PASSAI CAREER — presentation request body の ES shape 固定 QA（P7-F 常設 harness）。
 *
 * 背景:
 *   既存 body-byte harness（career-memory-presentation-byte-qa）は「selector 経路 ≡ snapshot 経路」の
 *   **live 等価比較**であり、両経路が同一 build を通るため body の縮小そのものは検出・保証しない。
 *   本 harness は P7-F strict summary 化 **後** の presentation request body の ES shape を fixture に
 *   pin し、full CareerEsResult の未使用 field が body へ残らないこと・cap を回帰保証する。
 *
 * 何を守るか:
 *   - presentation request context の `es` が headline / gakuchika / selfPr / motivation の 4 key のみ。
 *   - appealPoints / interviewQuestions / answer / question / companyName / selectionType /
 *     industry / jobType 等が body に残らない。
 *   - gakuchika / selfPr / motivation が 300 字 cap 済み、headline が 80 字 cap 済み。
 *   - esLogs 空 / result 不在なら null。
 *   - `es` shape の golden 固定（heavy）。
 *
 * 厳守（P7-F）:
 *   - production の純関数（buildPresentationRequestContext）を **読むだけ**。
 *   - route / prompt / AI schema / DB / Supabase / env / secret 非接続。
 *   - presentation 専用。matching / interview / consultation は扱わない。
 *
 * 使い方:
 *   npx tsx scripts/career-presentation-es-body-qa.ts            # fixture と比較（既定）
 *   npx tsx scripts/career-presentation-es-body-qa.ts --update   # 現在の es shape を fixture に上書き
 * 終了コード: 全 assertion PASS & fixture 一致 → 0 / いずれか FAIL → 1。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildPresentationRequestContext } from '@/lib/careerMemory/selector';
import {
  PRESENTATION_ES_HEADLINE_CAP,
  PRESENTATION_ES_GAKUCHIKA_CAP,
  PRESENTATION_ES_SELFPR_CAP,
  PRESENTATION_ES_MOTIVATION_CAP,
} from '@/lib/careerMemory/presentationEs';

/* eslint-disable @typescript-eslint/no-explicit-any */
const any = (v: unknown) => v as any;

const FIXTURE_DIR = join(process.cwd(), 'scripts/fixtures/presentation-es-body');
const UPDATE = process.argv.includes('--update') || process.env.UPDATE === '1';

const rep = (base: string, n: number) => base.repeat(Math.ceil(n / base.length)).slice(0, n);

// full CareerEsResult（未使用 field を full で持たせ、body から落ちることを検証）。
function heavyEsLog() {
  return any({
    id: 'es1',
    createdAt: '2026-07-01',
    userInput: '',
    companyName: '株式会社サンプル',
    question: '学生時代に力を入れたことを教えてください（400字）',
    result: {
      headline: '一言でいうと挑戦を続ける人間です',
      gakuchika: rep('学生時代に力を入れたことは長期インターンでの新規事業開発であり課題を構造化して', 420),
      selfPr: rep('私の強みは課題を構造化し周囲を巻き込みながら粘り強く実行しやり切る力です', 400),
      motivation: rep('貴社を志望する理由は事業の社会的意義と成長環境に強く共感しているためで', 380),
      appealPoints: ['論理的思考力', '実行力', 'リーダーシップ'],
      interviewQuestions: ['なぜ?', '困難は?'],
      improvements: ['数値を入れる'],
      answer: rep('設問への回答本文です', 300),
      question: '学生時代に力を入れたことを教えてください（400字）',
      charLimit: 400,
      companyName: '株式会社サンプル',
      selectionType: 'main',
      industry: 'IT・通信',
      jobType: 'エンジニア',
    },
  });
}

function presentationInput(esLogs: unknown[]) {
  return {
    profile: null,
    activity: null,
    values: null,
    selfAnalysisLogs: [],
    esLogs,
    interviewResults: [],
    matchingLogs: [],
    consultationThreads: [],
  };
}

let failures = 0;
const note = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) failures++;
};

const body = buildPresentationRequestContext(any(presentationInput([heavyEsLog()])));
const es = body.es;

// 1) es が present で 4 key のみ
note(!!es, 'es が present');
const keys = es ? Object.keys(es).sort() : [];
note(
  JSON.stringify(keys) === JSON.stringify(['gakuchika', 'headline', 'motivation', 'selfPr']),
  `es は gakuchika/headline/motivation/selfPr の 4 key のみ | ${JSON.stringify(keys)}`,
);

// 2) 未使用 field が body に残らない
const FORBIDDEN_KEYS = [
  'appealPoints',
  'interviewQuestions',
  'improvements',
  'answer',
  'question',
  'charLimit',
  'companyName',
  'selectionType',
  'industry',
  'jobType',
];
for (const k of FORBIDDEN_KEYS) {
  note(!(es && k in (es as Record<string, unknown>)), `未使用 field が es に無い | ${k}`);
}

// 3) cap 済み & heavy truncate
if (es) {
  note(es.headline.length <= PRESENTATION_ES_HEADLINE_CAP + 1, `headline cap | ${es.headline.length}`);
  note(es.gakuchika.length <= PRESENTATION_ES_GAKUCHIKA_CAP + 1, `gakuchika cap | ${es.gakuchika.length}`);
  note(es.selfPr.length <= PRESENTATION_ES_SELFPR_CAP + 1, `selfPr cap | ${es.selfPr.length}`);
  note(es.motivation.length <= PRESENTATION_ES_MOTIVATION_CAP + 1, `motivation cap | ${es.motivation.length}`);
  note(es.gakuchika.endsWith('…'), 'heavy gakuchika が truncate される');
  note(es.selfPr.endsWith('…'), 'heavy selfPr が truncate される');
  note(es.motivation.endsWith('…'), 'heavy motivation が truncate される');
}

// 4) esLogs 空 / result 不在なら null
note(buildPresentationRequestContext(any(presentationInput([]))).es === null, 'esLogs 空 → es=null');
note(
  buildPresentationRequestContext(any(presentationInput([any({ id: 'x', createdAt: '2026', result: null })]))).es === null,
  'result 不在 → es=null',
);

// 5) es shape golden（heavy）
if (!existsSync(FIXTURE_DIR)) {
  if (UPDATE) mkdirSync(FIXTURE_DIR, { recursive: true });
}
const fixturePath = join(FIXTURE_DIR, 'heavy-es.json');
const esJson = JSON.stringify(es, null, 2);
if (UPDATE) {
  writeFileSync(fixturePath, esJson + '\n', 'utf8');
  console.log(`📝 wrote fixture | heavy-es.json (${esJson.length} chars)`);
} else if (!existsSync(fixturePath)) {
  note(false, 'fixture 欠落 | heavy-es.json（--update で生成）');
} else {
  const golden = readFileSync(fixturePath, 'utf8').trim();
  note(golden === esJson.trim(), 'es shape fixture 一致 | heavy-es.json');
  if (golden !== esJson.trim()) {
    console.log(`   fixture: ${golden}`);
    console.log(`   actual : ${esJson}`);
  }
}

console.log('');
console.log(failures === 0 ? 'ALL_PASS' : `FAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

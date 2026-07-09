/*
 * scripts/career-matching-es-render-golden-qa.ts
 *
 * PASSAI CAREER — matching ES block render の golden 固定 QA（P7-B 常設 harness）。
 *
 * 背景（P7-A 監査結論）:
 *   既存 prompt golden（career-memory-prompt-golden-qa）は **base prompt のみ**を固定しており、
 *   ES block（`# 直近の ES ドラフト`）の render 出力は非カバー。P7-B で matching の ES を strict
 *   summary 化（headline/selfPr/motivation のみ・selfPr/motivation を cap）した効果を回帰保証する。
 *
 * 何を守るか:
 *   - matching の ES block render 出力を golden として固定（typical / heavy）。
 *   - heavy case で長い selfPr / motivation が cap されること。
 *   - gakuchika や未使用 field（appealPoints / interviewQuestions / answer 等）が
 *     matching ES block に出ないこと。
 *
 * 厳守（P7-B）:
 *   - production の純関数（buildMatchingEsSummary / renderMatchingEsSummary）を **読むだけ**。
 *   - route / prompt / AI schema / DB / Supabase / env / secret 非接続。
 *   - matching 専用。interview / presentation / consultation は扱わない。
 *
 * 使い方:
 *   npx tsx scripts/career-matching-es-render-golden-qa.ts            # golden と比較（既定）
 *   npx tsx scripts/career-matching-es-render-golden-qa.ts --update   # 現在の出力を golden に上書き
 * 終了コード: 全ケース golden 一致 & 全 assertion PASS → 0 / いずれか不一致・FAIL → 1。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CareerEsResult } from '@/types/careerEs';
import {
  buildMatchingEsSummary,
  renderMatchingEsSummary,
  MATCHING_ES_SELFPR_CAP,
  MATCHING_ES_MOTIVATION_CAP,
} from '@/lib/careerMemory/matchingEs';

const GOLDEN_DIR = join(process.cwd(), 'scripts/fixtures/matching-es-render');
const UPDATE = process.argv.includes('--update') || process.env.UPDATE === '1';

const rep = (base: string, n: number) => base.repeat(Math.ceil(n / base.length)).slice(0, n);

// full CareerEsResult fixture（未使用 field も full で持たせ、summary で落ちることを検証する）。
function makeEs(gLen: number, sLen: number, mLen: number): CareerEsResult {
  return {
    headline: '一言でいうと挑戦を続ける人間です',
    gakuchika: rep('学生時代に力を入れたことは長期インターンでの新規事業開発であり', gLen),
    selfPr: rep('私の強みは課題を構造化し周囲を巻き込みながら実行する力です', sLen),
    motivation: rep('貴社を志望する理由は事業の社会的意義と成長環境に強く共感し', mLen),
    appealPoints: ['論理的思考力', '実行力', 'リーダーシップ', '傾聴力'],
    interviewQuestions: ['なぜその選択を?', '困難は?', '学びは?', '次にどう活かす?'],
    improvements: ['数値を入れる', '一文を短く', '結論を先に'],
    answer: rep('設問への回答本文です', 300),
    question: '学生時代に力を入れたことを教えてください（400字）',
    charLimit: 400,
    companyName: '株式会社サンプル',
    selectionType: 'main',
    industry: 'IT・通信',
    jobType: 'エンジニア',
  };
}

type Case = { name: string; es: CareerEsResult };
const CASES: Case[] = [
  // typical: cap 未満（selfPr/motivation はそのまま passthrough する枝を固定）。
  { name: 'typical', es: makeEs(150, 150, 150) },
  // heavy: cap 超過（selfPr/motivation が truncate される枝を固定）。
  { name: 'heavy', es: makeEs(420, 400, 380) },
];

// matching ES block の render 出力（summary 経由。route と同じ経路）。
function renderBlock(es: CareerEsResult): string {
  return renderMatchingEsSummary(buildMatchingEsSummary(es));
}

function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `${name}.txt`);
}

// ── 実行 ──
if (UPDATE && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

// matching ES block に出てはならない字句（未使用 field 由来）。
const FORBIDDEN_SUBSTRINGS = [
  'ガクチカ', // gakuchika ラベル（matching では render しない）
  '論理的思考力', // appealPoints
  'なぜその選択を', // interviewQuestions
  '数値を入れる', // improvements
  '設問への回答本文', // answer
  '株式会社サンプル', // companyName
  'IT・通信', // industry
  'エンジニア', // jobType
];

let failures = 0;
const note = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✅' : '❌'} ${msg}`);
  if (!ok) failures++;
};

for (const c of CASES) {
  const out = renderBlock(c.es);
  const path = goldenPath(c.name);

  // 1) golden 比較 / 更新
  if (UPDATE) {
    writeFileSync(path, out, 'utf8');
    console.log(`📝 wrote golden | ${c.name} (${out.length} chars)`);
  } else if (!existsSync(path)) {
    note(false, `golden 欠落 | ${c.name}（--update で生成）`);
  } else {
    const golden = readFileSync(path, 'utf8');
    note(golden === out, `golden 一致 | ${c.name} (${out.length} chars)`);
    if (golden !== out) {
      console.log(`   golden: ${JSON.stringify(golden)}`);
      console.log(`   actual: ${JSON.stringify(out)}`);
    }
  }

  // 2) 未使用 field が出ないこと
  for (const bad of FORBIDDEN_SUBSTRINGS) {
    note(!out.includes(bad), `未使用字句が出ない | ${c.name} | "${bad}"`);
  }

  // 3) summary shape は headline/selfPr/motivation のみ（gakuchika key を持たない）
  const summary = buildMatchingEsSummary(c.es);
  const keys = summary ? Object.keys(summary).sort() : [];
  note(
    JSON.stringify(keys) === JSON.stringify(['headline', 'motivation', 'selfPr']),
    `summary keys が3つのみ | ${c.name} | ${JSON.stringify(keys)}`,
  );

  // 4) cap 検証（… suffix を含め cap+1 以下）
  if (summary) {
    note(
      summary.selfPr.length <= MATCHING_ES_SELFPR_CAP + 1,
      `selfPr cap | ${c.name} | ${summary.selfPr.length} <= ${MATCHING_ES_SELFPR_CAP + 1}`,
    );
    note(
      summary.motivation.length <= MATCHING_ES_MOTIVATION_CAP + 1,
      `motivation cap | ${c.name} | ${summary.motivation.length} <= ${MATCHING_ES_MOTIVATION_CAP + 1}`,
    );
  }
}

// heavy では実際に truncate（… suffix）が起きていることを確認（cap が効いている証跡）。
const heavy = buildMatchingEsSummary(makeEs(420, 400, 380));
note(
  !!heavy && heavy.selfPr.endsWith('…') && heavy.motivation.endsWith('…'),
  `heavy で selfPr/motivation が truncate される`,
);

console.log('');
console.log(failures === 0 ? 'ALL_PASS' : `FAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

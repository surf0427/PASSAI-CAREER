/*
 * scripts/career-self-analysis-output-budget-qa.ts
 *
 * PASSAI CAREER — 自己分析まとめ生成の「出力量予算」QA（dev-only / 実 Claude API 非接続）。
 *
 * 背景（この QA が守っている不変条件）:
 *   自己分析の生成レイテンシは **ほぼ全量が出力トークン生成時間**である。
 *   実測（claude-sonnet-4-6）では入力 2.4k〜5.4k tokens の prefill は 1 秒未満で、
 *   latency ≒ output_tokens / 約50 tok/s だった。つまり:
 *     - 入力（prompt / context）を削っても latency はほぼ改善しない。
 *     - 出力量の上限指示だけが実効的な latency レバーである。
 *     - max_tokens は「上限」であって生成量の駆動要因ではない。下げると truncation を招く。
 *
 *   最適化前は heavy ケースで出力が max_tokens=4000 に達し、stop_reason='max_tokens' →
 *   OUTPUT_TRUNCATED（**非 retryable な terminal 失敗**）になっていた。
 *   したがって本 QA は「出力量を絞る指示」と「max_tokens の余裕」を両方固定する。
 *
 * 検証項目:
 *   1. 出力量 CAP 指示（配列最大3個 / 1文60字 / keyword は語句のみ）が prompt にある。
 *   2. 完全性 FLOOR 指示（材料が乏しくても仮説として埋める）が prompt にある。
 *   3. 旧「原則2〜5個」「該当が無いフィールドは空配列」指示が**残っていない**。
 *   4. 出力スキーマ 18 キーは不変（contract 非破壊）。
 *   5. max_tokens は 4000 のまま（truncation 余裕。下げない）。
 *   6. job path / legacy path の両方が effort=low + thinking disabled を指定している。
 *   7. prompt revision が旧値から更新されている（idempotency key を分離するため）。
 *
 * 使い方: npx tsx scripts/career-self-analysis-output-budget-qa.ts
 * 終了コード: 全 PASS → 0 / 1 件でも FAIL → 1。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  OUTPUT_FORMAT_INSTRUCTION,
  SELF_ANALYSIS_MAX_TOKENS,
} from '../lib/careerSelfAnalysis/summaryPrompt';
import { SELF_ANALYSIS_PROMPT_REVISION } from '../lib/careerGenerationJob/constants';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('career-self-analysis-output-budget-qa');

// ── 1. 出力量 CAP 指示 ───────────────────────────────────────────────
check(
  '1a CAP: 配列フィールドは最大3個',
  OUTPUT_FORMAT_INSTRUCTION.includes('配列フィールドは最大3個'),
);
check(
  '1b CAP: 各要素は1文・60字以内',
  OUTPUT_FORMAT_INSTRUCTION.includes('1文・60字以内'),
);
check(
  '1c CAP: keyword 系は語句のみ・最大5個',
  OUTPUT_FORMAT_INSTRUCTION.includes('valueKeywords / strengthKeywords') &&
    OUTPUT_FORMAT_INSTRUCTION.includes('最大5個'),
);
check(
  '1d CAP: 冗長な言い換え・一般論の反復を禁止',
  OUTPUT_FORMAT_INSTRUCTION.includes('情報密度'),
);
check(
  '1e CAP: フィールド間の重複禁止',
  OUTPUT_FORMAT_INSTRUCTION.includes('複数のフィールドで言い換えて重複'),
);

// ── 2. 完全性 FLOOR 指示 ─────────────────────────────────────────────
check(
  '2a FLOOR: 材料が乏しくても仮説として埋める',
  OUTPUT_FORMAT_INSTRUCTION.includes('「仮説」として1〜2項目は必ず埋めて'),
);
check(
  '2b FLOOR: 全キーは常に含める',
  OUTPUT_FORMAT_INSTRUCTION.includes('キーは必ず全て含める'),
);

// ── 3. 旧指示が残っていない ──────────────────────────────────────────
check(
  '3a 旧「原則2〜5個」が残っていない',
  !OUTPUT_FORMAT_INSTRUCTION.includes('原則2〜5個'),
);
check(
  '3b 旧「該当が無いフィールドは空配列」が残っていない',
  !OUTPUT_FORMAT_INSTRUCTION.includes('該当が無いフィールドは空配列'),
);

// ── 4. 出力スキーマ 18 キー不変 ──────────────────────────────────────
const SCHEMA_KEYS = [
  'summary', 'strengths', 'weaknesses', 'gakuchikaIdeas', 'selfPrIdeas', 'esAngles',
  'interviewQuestions', 'nextActions', 'careerDirection', 'recommendedIndustries',
  'recommendedJobs', 'suitableEnvironment', 'valueKeywords', 'strengthKeywords',
  'motivationSources', 'stressFactors', 'companySelectionCriteria', 'developmentPoints',
];
const missing = SCHEMA_KEYS.filter((k) => !OUTPUT_FORMAT_INSTRUCTION.includes(`"${k}"`));
check('4a 出力スキーマ 18 キーがすべて prompt に存在', missing.length === 0, missing.join(','));
check('4b 出力スキーマは 18 キー', SCHEMA_KEYS.length === 18);

// ── 5. max_tokens は下げない ─────────────────────────────────────────
check(
  '5a max_tokens は 4000（truncation 余裕を確保。下げない）',
  SELF_ANALYSIS_MAX_TOKENS === 4000,
  `got ${SELF_ANALYSIS_MAX_TOKENS}`,
);

// ── 6. 両経路が effort=low + thinking disabled ───────────────────────
const providerSrc = read('lib/careerSelfAnalysis/summaryProvider.ts');
const routeSrc = read('app/api/career/self-analysis/route.ts');

for (const [label, src] of [
  ['job path (summaryProvider)', providerSrc],
  ['legacy path (route.ts)', routeSrc],
] as const) {
  check(
    `6 ${label}: output_config effort='low'`,
    /output_config:\s*\{[\s\S]*?effort:\s*'low'/.test(src),
  );
  check(
    `6 ${label}: thinking disabled`,
    /thinking:\s*\{\s*type:\s*'disabled'\s*\}/.test(src),
  );
}

// ── 7. prompt revision が更新されている ──────────────────────────────
// `as const` により型が literal に絞られるため、比較は string へ widen して行う
// （型上は常に true でも、定数を戻す regression を実行時に検出したいチェック）。
const promptRevision: string = SELF_ANALYSIS_PROMPT_REVISION;
check(
  '7a prompt revision が旧値ではない',
  promptRevision !== 'self-analysis-prompt-2026-07-15',
  promptRevision,
);
check(
  '7b prompt revision は self-analysis-prompt- 接頭辞',
  promptRevision.startsWith('self-analysis-prompt-'),
);

console.log(`\n結果: PASS ${passes} / FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);

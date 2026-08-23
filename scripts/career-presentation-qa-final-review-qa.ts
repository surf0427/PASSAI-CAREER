/*
 * scripts/career-presentation-qa-final-review-qa.ts
 *
 * PASSAI CAREER — 発表後 Q&A の最終評価 QA（dev-only 常設・決定的）。
 *
 * 目的（回帰ガード）:
 *   Q&A は「最後の回答を送る → 終了しました」で終わり、**質疑応答全体の最終評価が
 *   一切生成・表示されない**状態だった（final evaluation の AI call・prompt・型・
 *   client state・描画・永続化のすべてが存在しなかった）。二度とその状態に戻らないよう固定する。
 *
 *   A. 終了条件: 途中回答なら次質問（最終評価はまだ）／上限到達で done → 最終評価へ進む。
 *   B. 最終評価 prompt に **最後のユーザー回答**が必ず含まれる（stale state 事故の構造的排除）。
 *   C. 総合点 / ランクは server が軸から導出する（AI の自己申告を採用しない）。
 *   D. 最終評価が result へ永続化され、リロード相当の再読込・過去結果からも復元される。
 *   E. client 実装契約（done → 最終評価呼び出し / 確定配列を渡す / 描画 / 二重実行ガード）。
 *
 *   外部 AI 非実行・Supabase 非接続（localStorage を in-memory stub で再現する）。
 *
 * 使い方: npx tsx scripts/career-presentation-qa-final-review-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── localStorage stub（storage helper を実行するため import より前に置く）──
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}
const memory = new MemoryStorage();
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = memory;

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  appendPresentationResult,
  loadPresentationResults,
  updatePresentationResult,
  savePresentationResults,
} = require('@/app/career/presentation/presentationStorage') as typeof import('@/app/career/presentation/presentationStorage');
/* eslint-enable @typescript-eslint/no-require-imports */

import {
  CAREER_PRESENTATION_QA_AXES,
  CAREER_PRESENTATION_QA_MAX_TURNS,
  buildQaFinalUserPrompt,
  computePresentationTotalScore,
  countQaAnswers,
  presentationRankFromScore,
} from '@/app/api/career/presentation/presentationPrompt';
import type {
  CareerPresentationQaReview,
  CareerPresentationQaTurn,
  CareerPresentationResult,
} from '@/types/careerPresentation';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};
const section = (t: string) => console.log(`\n── ${t} ──`);

const routeSrc = read('app/api/career/presentation/qa/route.ts');
const pageSrc = read('app/career/presentation/result/page.tsx');

const LAST_ANSWER = '直近の四半期で問い合わせ対応を週12時間から4時間に短縮しました。';

// Q1..Q4 / A1..A4 の完全な質疑応答（最後の回答は LAST_ANSWER）。
function buildTurns(answers: number): CareerPresentationQaTurn[] {
  const turns: CareerPresentationQaTurn[] = [];
  for (let i = 1; i <= answers; i++) {
    turns.push({ role: 'question', content: `質問${i}: その根拠を教えてください。` });
    turns.push({
      role: 'answer',
      content: i === answers ? LAST_ANSWER : `回答${i}です。`,
    });
  }
  return turns;
}

// ════════════════════════════════════════════════════════════════════
section('A. 終了条件（途中回答 → 次質問 / 上限到達 → done → 最終評価）');

// route の実際の分岐述語をそのまま使う（client 側の想定と同じ契約であることを固定する）。
const midTurns = buildTurns(1);
check(
  countQaAnswers(midTurns) < CAREER_PRESENTATION_QA_MAX_TURNS,
  `途中回答（1件）は上限未満 → 次質問へ進む（最終評価はまだ生成されない）`,
);

const finalTurns = buildTurns(CAREER_PRESENTATION_QA_MAX_TURNS);
check(
  countQaAnswers(finalTurns) >= CAREER_PRESENTATION_QA_MAX_TURNS,
  `最後の回答（${CAREER_PRESENTATION_QA_MAX_TURNS}件）で上限到達 → route は done を返す`,
);

// route: mode:'final' は done の早期 return を **通り抜ける**（通り抜けないと評価が永久に出ない）。
check(
  /const isFinal = str\(b\.mode\) === 'final';/.test(routeSrc),
  'route: mode:"final" を認識する',
);
check(
  /if \(isFinal\) \{[\s\S]{0,400}?\} else if \(countQaAnswers\(turns\) >= CAREER_PRESENTATION_QA_MAX_TURNS\)/.test(
    routeSrc,
  ),
  'route: final のときは done 早期 return をスキップする（else if 構造）',
);
check(
  /if \(countQaAnswers\(turns\) === 0\) \{[\s\S]{0,200}?status: 409/.test(routeSrc),
  'route: 回答 0 件の final は 409（評価対象が無い）',
);
check(
  /buildQaFinalUserPrompt\(\{ theme, transcript, turns, config \}\)/.test(routeSrc),
  'route: final は Q&A 全ターンを prompt へ渡す',
);
check(
  /return Response\.json\(\{ done: true, review \}\);/.test(routeSrc),
  'route: final は review を返す',
);

// ════════════════════════════════════════════════════════════════════
section('B. 最終評価 input に「最後のユーザー回答」が含まれる');

const finalPrompt = buildQaFinalUserPrompt({
  theme: '自分の強みを3分で',
  transcript: 'まず結論から申し上げます。私の強みは業務改善です。',
  turns: finalTurns,
  config: { jobType: '営業' },
});

check(finalPrompt.includes(LAST_ANSWER), '★ 最後のユーザー回答が prompt に含まれる');
check(finalPrompt.includes('回答1です。'), '途中の回答も prompt に含まれる（全記録が対象）');
check(finalPrompt.includes('質問4: その根拠を教えてください。'), '最後の質問も prompt に含まれる');
check(
  finalPrompt.includes('まず結論から申し上げます。私の強みは業務改善です。'),
  '発表本編の文字起こしが prompt に含まれる（本編との一貫性を見るため）',
);
check(finalPrompt.includes('自分の強みを3分で'), 'お題が prompt に含まれる');
check(
  CAREER_PRESENTATION_QA_AXES.every((a) => finalPrompt.includes(a.key)),
  '4 軸すべての key が出力スキーマに含まれる',
);
check(
  finalPrompt.includes('総合点（totalScore）とランク（rank）は出力しないでください'),
  'AI に totalScore / rank を出力させない（authority 分離）',
);

// 1 問だけで終わった Q&A も評価対象として成立する。
const onePair = buildTurns(1);
const onePrompt = buildQaFinalUserPrompt({
  theme: 'お題',
  transcript: '発表本文',
  turns: onePair,
});
check(onePrompt.includes(LAST_ANSWER), '1問1答でも最後の回答が prompt に含まれる');

// ════════════════════════════════════════════════════════════════════
section('C. 総合点 / ランクは server が軸から導出する');

const axes = CAREER_PRESENTATION_QA_AXES.map((a, i) => ({
  key: a.key,
  label: a.label,
  score: [80, 70, 60, 50][i],
  comment: '',
}));
const total = computePresentationTotalScore(axes);
check(total === 65, `4 軸平均が総合点になる（80/70/60/50 → ${total}）`);
check(presentationRankFromScore(total) === 'B', '総合点からランクが決まる（65 → B）');
check(
  /const review = normalizeQaReview\(JSON\.parse\(extractJson\(raw\)\)\);/.test(routeSrc),
  'route: AI 出力は normalizeQaReview を通す',
);
check(
  /const totalScore = computePresentationTotalScore\(axes\);\n\s+return \{\n\s+totalScore,\n\s+rank: presentationRankFromScore\(totalScore\),/.test(
    routeSrc,
  ),
  'route: totalScore / rank は軸から算出（AI 申告値を読まない）',
);

// ════════════════════════════════════════════════════════════════════
section('D. 最終評価の永続化（リロード復元 / 過去結果表示）');

memory.clear();
savePresentationResults([]);

const baseResult: CareerPresentationResult = {
  id: 'pres-1',
  createdAt: '2026-08-23T00:00:00.000Z',
  presentationType: 'real',
  mode: 'text',
  config: { companyName: 'テスト株式会社' },
  theme: '自分の強みを3分で',
  timeLimitSec: 180,
  durationSec: 0,
  transcript: 'まず結論から申し上げます。',
  result: {
    totalScore: 72,
    rank: 'B',
    overallComment: '本編の総評',
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
  },
};
appendPresentationResult(baseResult);

const review: CareerPresentationQaReview = {
  totalScore: 65,
  rank: 'B',
  overallComment: '質疑応答の総評',
  axes,
  goodPoints: ['結論から答えられている'],
  improvements: ['数字の根拠が弱い'],
  nextPractice: ['想定質問への数字を用意する'],
};

// client の persistQa(turns, review) 相当。
updatePresentationResult({ ...baseResult, qa: finalTurns, qaReview: review });

// ★ リロード相当（state を捨てて localStorage から読み直す）。
const reloaded = loadPresentationResults()[0];
check(reloaded.qaReview?.totalScore === 65, 'リロード後も最終評価が復元される');
check(reloaded.qaReview?.rank === 'B', 'リロード後もランクが復元される');
check(reloaded.qaReview?.axes.length === 4, 'リロード後も 4 軸が復元される');
check(
  reloaded.qaReview?.improvements[0] === '数字の根拠が弱い',
  'リロード後も改善点が復元される',
);
check(reloaded.qa?.length === finalTurns.length, '回答履歴も同時に保存されている');
check(
  reloaded.qa?.[reloaded.qa.length - 1].content === LAST_ANSWER,
  '★ 保存された履歴の末尾は最後のユーザー回答',
);
check(reloaded.result.overallComment === '本編の総評', '本編の評価を壊していない');
check(loadPresentationResults().length === 1, '同 id 置換で履歴が増殖しない');

// やり直し: review 無しで persist すると前回の最終評価は残らない。
updatePresentationResult({ ...baseResult, qa: [] });
check(
  loadPresentationResults()[0].qaReview === undefined,
  'やり直し時は前回の最終評価が残らない（stale 表示の防止）',
);

// 旧ログ（qaReview を持たない）も欠損のまま扱える。
check(
  loadPresentationResults()[0].result.totalScore === 72,
  '旧ログ互換: qaReview 欠損でも result は読める',
);

// ════════════════════════════════════════════════════════════════════
section('E. client 実装契約（done → 最終評価 / 確定配列 / 描画 / 二重実行ガード）');

check(
  /await runFinalReview\(withAnswer\);/.test(pageSrc),
  '★ done 受信時に最終評価を呼ぶ（「終了しました」で終わらせない）',
);
check(
  !/runFinalReview\(qaTurns\)[\s\S]{0,80}?persistQa\(withAnswer\)/.test(pageSrc) &&
    /persistQa\(withAnswer\);\n\s+await runFinalReview\(withAnswer\);/.test(pageSrc),
  '★ 最終評価には qaTurns(state) ではなく withAnswer(確定配列) を渡す（stale state 事故の防止）',
);
check(
  /callQa\(turns, 'final'\)/.test(pageSrc),
  'client: mode:"final" で最終評価 API を呼ぶ',
);
check(
  /setQaReview\(data\.review\);\n\s+persistQa\(turns, data\.review\);/.test(pageSrc),
  'client: 最終評価を state と localStorage の両方へ入れる',
);
check(
  /\{displayedReview && <QaReviewView review=\{displayedReview\} \/>\}/.test(pageSrc),
  'client: 最終評価を描画する',
);
check(
  /const displayedReview = isLiveQa \? qaReview : selected\?\.qaReview \?\? null;/.test(pageSrc),
  'client: 過去結果では保存済みの最終評価を表示する',
);
check(
  /if \(finalizingRef\.current\) return;\n\s+finalizingRef\.current = true;/.test(pageSrc),
  'client: 最終評価の二重実行ガード',
);
check(
  /if \(qaPhase !== 'answering' \|\| submittingRef\.current\) return;/.test(pageSrc),
  'client: 回答送信の二重実行ガード',
);
check(
  /qaPhase === 'finalizing'/.test(pageSrc),
  'client: 最終評価の生成中 loading を出す',
);
check(
  /qaPhase === 'final_error'/.test(pageSrc) && /最終評価をもう一度生成する/.test(pageSrc),
  'client: 最終評価だけ失敗したときは再試行できる（回答履歴は消さない）',
);
check(
  !/persistQa\(withAnswer\);\s*\n\s*setQaPhase\('done'\);/.test(pageSrc),
  '★ 旧バグが残っていない（最後の回答を保存して即 done 表示し、評価を出さない経路）',
);

// ════════════════════════════════════════════════════════════════════
console.log(`\n${fails === 0 ? '✅ ALL PASS' : `❌ ${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);

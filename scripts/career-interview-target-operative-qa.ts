/*
 * scripts/career-interview-target-operative-qa.ts
 *
 * PASSAI CAREER — 面接 target の operative-prompt 到達 QA（dev-only 常設・決定的）。
 *
 * 目的:
 *   「より精度を上げたい人向け」カード（target）の情報が、system の背景ブロックだけでなく、
 *   質問生成の operative prompt（buildSeedUserPrompt / buildFollowupUserPrompt）へ到達し、
 *   ユーザーが面接中に体感できる差分を生むことをセンチネル方式で機械的に保証する。
 *   併せて「target 未入力時は operative prompt が byte 不変」「評価側は不変」「system と user の
 *   責務分担」を回帰ガードする。外部 AI 非実行・実データ非参照・DB/Supabase 非接続。
 *
 * 使い方: npx tsx scripts/career-interview-target-operative-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import {
  buildSeedUserPrompt,
  buildFollowupUserPrompt,
  buildFinalUserPrompt,
  buildFinalFeedbackInstruction,
} from '@/app/api/career/interview/interviewPrompt';
import { normalizeInterviewTarget } from '@/app/career/interview/interviewModes';
import type { CareerInterviewTurn } from '@/types/careerInterview';

// フィールドごとに固有センチネル（到達を出現回数で機械判定する）。
const S = {
  company: 'テスト株式会社',
  job: 'JOBSENT法人営業',
  memo: 'MEMOSENT_顧客課題を構造的に整理し社内外を巻き込む人材を重視',
  focus: 'FOCUSSENT_ガクチカの再現性と法人営業で成果を出せる根拠を練習したい',
};

const count = (hay: string, needle: string) =>
  needle === '' ? 0 : hay.split(needle).length - 1;

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};

// 決定的な会話履歴（中盤・長尺）。
const TURNS: CareerInterviewTurn[] = [
  { role: 'question', content: '学生時代に力を入れたことを教えてください。' },
  { role: 'answer', content: 'サークルの新歓活動でリーダーを務め参加者を増やしました。' },
];
const LONG_TURNS: CareerInterviewTurn[] = [
  ...TURNS,
  { role: 'question', content: '最も苦労した点は何ですか。' },
  { role: 'answer', content: '意見の対立をまとめる調整に苦労しました。' },
  { role: 'question', content: 'どう乗り越えましたか。' },
  { role: 'answer', content: '個別に要望を聞き共通目標を再設定しました。' },
];

const MODE = 'real' as const;

// ── ケースA: target 未入力 → operative prompt が byte 不変（null/undefined/無効すべて） ──
console.log('\n# A. target 未入力（完全互換）');
const seedBase = buildSeedUserPrompt(MODE);
const followBase = buildFollowupUserPrompt(TURNS, MODE);
check(buildSeedUserPrompt(MODE, null) === seedBase, 'seed: null は無引数と byte 一致');
check(buildSeedUserPrompt(MODE, undefined) === seedBase, 'seed: undefined は無引数と byte 一致');
check(
  buildSeedUserPrompt(MODE, normalizeInterviewTarget({ companyName: '   ' })) === seedBase,
  'seed: 無効 target（空 companyName→null）は byte 一致',
);
check(buildFollowupUserPrompt(TURNS, MODE, null) === followBase, 'followup: null は byte 一致');
check(
  buildFollowupUserPrompt(TURNS, MODE, undefined) === followBase,
  'followup: undefined は byte 一致',
);
check(
  count(seedBase, S.focus) === 0 && count(followBase, S.job) === 0,
  'target 未入力: センチネルが operative prompt に一切出ない',
);

// ── ケースB: focusPoint のみ実質有効 ──
console.log('\n# B. focusPoint のみ');
const tB = normalizeInterviewTarget({ companyName: S.company, focusPoint: S.focus })!;
const seedB = buildSeedUserPrompt(MODE, tB);
const followB = buildFollowupUserPrompt(TURNS, MODE, tB);
check(count(seedB, S.focus) === 1, 'seed: focusPoint 由来指示が到達（1回・復唱過剰なし）');
check(count(followB, S.focus) === 1, 'followup: focusPoint 由来の優先ルールが到達（1回）');
check(followB.includes('最優先'), 'followup: focusPoint が「最優先」として明示される');
check(seedB !== seedBase && followB !== followBase, 'target 未入力との byte 差分が発生');
check(count(seedB, S.job) === 0 && count(followB, S.job) === 0, '未入力の jobType 指示は出ない');
check(
  followB.includes('無理に聞かない') && followB.includes('繰り返さない'),
  'followup: 復唱・重複・不自然な転換の抑止が入る',
);

// ── ケースC: jobType あり ──
console.log('\n# C. jobType あり');
const tC = normalizeInterviewTarget({ companyName: S.company, jobType: S.job })!;
const seedC = buildSeedUserPrompt(MODE, tC);
const followC = buildFollowupUserPrompt(TURNS, MODE, tC);
check(count(seedC, S.job) === 1, 'seed: 職種に接続しやすい入口の指示が到達');
check(count(followC, S.job) === 1, 'followup: 職種能力を確認する指示が到達');
check(followC.includes('捏造しない'), 'followup: 企業固有基準の捏造禁止ガードが入る');
check(count(seedC, S.focus) === 0, '未入力の focusPoint 指示は出ない');

// ── ケースD: 全入力（system と user の責務分担 + memo 非復唱） ──
console.log('\n# D. 全入力');
const tD = normalizeInterviewTarget({
  companyName: S.company,
  industry: 'IT・SaaS',
  jobType: S.job,
  selectionType: 'main',
  interviewPhase: 'final',
  companyMemo: S.memo,
  focusPoint: S.focus,
})!;
const seedD = buildSeedUserPrompt(MODE, tD);
const followD = buildFollowupUserPrompt(TURNS, MODE, tD);
check(count(seedD, S.focus) === 1 && count(seedD, S.job) === 1, 'seed: focus/job が user に到達');
check(
  count(followD, S.focus) === 1 && count(followD, S.job) === 1,
  'followup: focus/job が user に到達',
);
// companyMemo は system 側の責務。user operative prompt には原文を復唱しない（肥大化防止）。
check(
  count(seedD, S.memo) === 0 && count(followD, S.memo) === 0,
  'companyMemo 原文は operative prompt に復唱されない（system 側の責務）',
);
check(
  seedD.includes('企業固有の事実は断定しない') && followD.includes('外部事実として断定しない'),
  'companyMemo は前提扱い・断定禁止で参照される',
);

// ── ケースE: 長い面接履歴でも focusPoint 優先と復唱回避が維持 ──
console.log('\n# E. 長い面接履歴');
const followE = buildFollowupUserPrompt(LONG_TURNS, MODE, tD);
check(count(followE, S.focus) === 1, 'long: focusPoint は毎回そのまま復唱せず 1 回参照');
check(followE.includes('最優先'), 'long: focusPoint 優先ルールが維持');
check(followE.includes('自然に統合した1問'), 'long: 直前回答との自然な統合指示が維持');
check(
  followE.includes('学生時代に力を入れたこと') && followE.includes('意見の対立をまとめる調整'),
  'long: 既存の transcript（直前回答含む）が維持される',
);

// ── 評価側が不変であることの確認（target あり complete は既存仕様のまま） ──
console.log('\n# 評価側の不変確認');
const finalUser = buildFinalUserPrompt(TURNS);
check(count(finalUser, S.focus) === 0, 'final user prompt は target 非依存（従来どおり）');
const feedbackInstr = buildFinalFeedbackInstruction(MODE, false, tD);
check(
  feedbackInstr.includes('targetFeedback') && feedbackInstr.includes('weakPointsForThisTarget'),
  '評価 instruction は既存の targetFeedback スキーマを維持',
);

console.log('');
console.log(fails === 0 ? 'ALL_PASS' : `FAIL: ${fails}`);
process.exit(fails === 0 ? 0 : 1);

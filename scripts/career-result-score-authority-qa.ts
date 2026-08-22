/*
 * scripts/career-result-score-authority-qa.ts
 *
 * PASSAI CAREER — 結果出力の「スコア authority」QA（dev-only 常設・決定的）。
 *
 * 目的:
 *   4 機能の結果出力について、**評価軸そのものは各機能固有のまま**、
 *   「総合点を誰が決めるか」という技術原則だけが一貫していることを機械的に固定する。
 *
 *     ES          … AI 6 軸 → server 平均                 （本 QA では非変更を確認するだけ）
 *     面接         … AI criterion → mode 別 rubric → server 加重平均
 *     プレゼン      … AI 8 軸 → server 平均 → server rank
 *     GD solo     … AI 6 軸（solo 固有）→ solo 固有 weight → server
 *     GD multi    … AI 6 軸（multi 固有）→ multi 固有 weight → server
 *
 *   ★ 本 QA が禁止したい退行（= LLM に総合点を決めさせる実装への逆戻り）:
 *     - AI の自己申告 totalScore / overallScore / rank が採用される。
 *     - 面接の数値評価が消える / rubric ウェイトが総合点に効かなくなる。
 *     - 評価対象外（weight='none'）の観点が 0 点として平均に混ざる。
 *     - GD solo / multi の評価軸が「一貫性のため」に統合される。
 *
 * 厳守:
 *   production の純関数・純データを読むだけ。外部 AI 非実行・実データ非参照・DB/Supabase 非接続。
 *
 * 使い方: npx tsx scripts/career-result-score-authority-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getInterviewModeConfig,
  computeInterviewOverallScore,
  normalizeInterviewCriterionScores,
  scoredInterviewCriteria,
  CAREER_INTERVIEW_MODE_ORDER,
  CAREER_INTERVIEW_RUBRIC_CRITERION_KEYS,
  CAREER_INTERVIEW_RUBRIC_WEIGHT_VALUES,
  type CareerInterviewCriterionScores,
} from '@/app/career/interview/interviewModes';
import { buildFinalFeedbackInstruction } from '@/app/api/career/interview/interviewPrompt';
import {
  CAREER_PRESENTATION_AXES,
  computePresentationTotalScore,
  presentationRankFromScore,
} from '@/app/api/career/presentation/presentationPrompt';
import type { CareerInterviewType } from '@/types/careerInterview';

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
// 「〜しない」と *説明している* コメント行を誤検知しないよう、実コードだけを見る。
const codeOnly = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

const LIVE_MODES = CAREER_INTERVIEW_MODE_ORDER;

// ════════════════════════════════════════════════════════════════════
// A. 面接 — schema / sanitize
// ════════════════════════════════════════════════════════════════════
console.log('\n# A. 面接 criterionScores の schema / sanitize');

for (const mode of LIVE_MODES) {
  const config = getInterviewModeConfig(mode);
  const scored = scoredInterviewCriteria(config);

  // A-1 採点対象は「weight !== 'none'」と厳密に一致する。
  const expected = CAREER_INTERVIEW_RUBRIC_CRITERION_KEYS.filter(
    (k) => config.rubric[k] !== 'none',
  );
  check(
    scored.length === expected.length && scored.every((k, i) => k === expected[i]),
    `A-1 ${mode}: 採点対象 criterion が weight!=='none' と一致（${scored.length} 軸）`,
  );

  // A-2 0〜100 に clamp・整数化される。
  const clamped = normalizeInterviewCriterionScores(config, {
    [scored[0]]: 150,
    [scored[1]]: -20,
    [scored[2]]: 61.7,
  });
  check(
    clamped[scored[0]] === 100 && clamped[scored[1]] === 0 && clamped[scored[2]] === 62,
    `A-2 ${mode}: criterionScores が 0〜100 の整数へ clamp される`,
  );

  // A-3 未知 criterion は破棄される（AI が勝手に足しても入らない）。
  const withUnknown = normalizeInterviewCriterionScores(config, {
    [scored[0]]: 80,
    totallyUnknownCriterion: 100,
    overallScore: 99,
  });
  check(
    !('totallyUnknownCriterion' in withUnknown) && !('overallScore' in withUnknown),
    `A-3 ${mode}: 未知 key / overallScore が criterionScores へ混入しない`,
  );

  // A-4 weight 'none' の criterion は受け取らない。
  const noneKeys = CAREER_INTERVIEW_RUBRIC_CRITERION_KEYS.filter(
    (k) => config.rubric[k] === 'none',
  );
  if (noneKeys.length > 0) {
    const withNone = normalizeInterviewCriterionScores(
      config,
      Object.fromEntries(noneKeys.map((k) => [k, 100])),
    );
    check(
      Object.keys(withNone).length === 0,
      `A-4 ${mode}: 評価対象外（none）の criterion が sanitize で破棄される`,
    );
  }

  // A-5 スコア欠損でも壊れない（null か 0〜100 しか返さない）。
  const missing = computeInterviewOverallScore(config, {});
  check(missing === null, `A-5 ${mode}: criterionScores が空なら overallScore=null（0 点にしない）`);
  check(
    computeInterviewOverallScore(config, null) === null &&
      computeInterviewOverallScore(config, undefined) === null,
    `A-5b ${mode}: null / undefined でも throw せず null`,
  );
}

// A-6 ★ 'none' criterion は「値があっても」加重平均に入らない（0 点で引きずり下ろさない）。
{
  const mode: CareerInterviewType = 'self_analysis';
  const config = getInterviewModeConfig(mode);
  const scored = scoredInterviewCriteria(config);
  const noneKeys = CAREER_INTERVIEW_RUBRIC_CRITERION_KEYS.filter(
    (k) => config.rubric[k] === 'none',
  );
  const allEighty: CareerInterviewCriterionScores = Object.fromEntries(
    scored.map((k) => [k, 80]),
  );
  const withNoneZero: CareerInterviewCriterionScores = {
    ...allEighty,
    ...Object.fromEntries(noneKeys.map((k) => [k, 0])),
  };
  const a = computeInterviewOverallScore(config, allEighty);
  const b = computeInterviewOverallScore(config, withNoneZero);
  check(a === 80, `A-6 ${mode}: 採点対象が全部 80 なら overallScore=80（実測 ${a}）`);
  check(
    a === b,
    `A-6b ${mode}: none criterion に 0 を入れても overallScore が変わらない（${a} vs ${b}）`,
  );
}

// ════════════════════════════════════════════════════════════════════
// B. 面接 — mode 別 rubric ウェイトが overallScore に効く
// ════════════════════════════════════════════════════════════════════
console.log('\n# B. 面接 mode 別 rubric → overallScore 差');

// 全 criterion に「同じ」スコアを与えても、モードごとに重視軸が違えば総合点は変わる、
// という差を作るための fixture。片方の軸群を高く、もう片方を低くする。
const SELF_HEAVY: CareerInterviewCriterionScores = {
  selfUnderstanding: 90,
  experienceSpecificity: 90,
  reproducibility: 90,
  logic: 40,
  consistency: 40,
  communication: 40,
  motivationDepth: 20,
  companyFit: 20,
  industryUnderstanding: 20,
  roleFit: 20,
  pressureHandling: 20,
};

const perMode = LIVE_MODES.map((m) => {
  const config = getInterviewModeConfig(m);
  // そのモードで採点対象の criterion だけを渡す（実運用と同じ経路を通す）。
  const scores = normalizeInterviewCriterionScores(config, SELF_HEAVY);
  return { mode: m, score: computeInterviewOverallScore(config, scores) };
});
perMode.forEach((p) => console.log(`   - ${p.mode}: overallScore=${p.score}`));

// B-1 同一 criterionScores でも 4 モードの overallScore が一律にならない。
const distinctScores = new Set(perMode.map((p) => p.score));
check(
  distinctScores.size >= 3,
  `B-1 ★ 同一 criterionScores でも mode 別ウェイトで overallScore が変わる（${distinctScores.size}/4 種）`,
);

// B-2 自己理解重視の入力では self_analysis > motivation になる（ウェイトの向きが正しい）。
const scoreOf = (m: CareerInterviewType) => perMode.find((p) => p.mode === m)!.score!;
check(
  scoreOf('self_analysis') > scoreOf('motivation'),
  `B-2 自己理解が高い回答は 自己分析モード(${scoreOf('self_analysis')}) > 企業理解モード(${scoreOf('motivation')})`,
);

// B-3 逆向きの fixture（企業理解重視）では順序が反転する＝ウェイトが実際に効いている証拠。
const COMPANY_HEAVY: CareerInterviewCriterionScores = Object.fromEntries(
  CAREER_INTERVIEW_RUBRIC_CRITERION_KEYS.map((k) => [
    k,
    ['motivationDepth', 'companyFit', 'industryUnderstanding', 'roleFit'].includes(k) ? 90 : 30,
  ]),
);
const selfOnCompanyHeavy = computeInterviewOverallScore(
  getInterviewModeConfig('self_analysis'),
  normalizeInterviewCriterionScores(getInterviewModeConfig('self_analysis'), COMPANY_HEAVY),
)!;
const motivationOnCompanyHeavy = computeInterviewOverallScore(
  getInterviewModeConfig('motivation'),
  normalizeInterviewCriterionScores(getInterviewModeConfig('motivation'), COMPANY_HEAVY),
)!;
check(
  motivationOnCompanyHeavy > selfOnCompanyHeavy,
  `B-3 ★ 企業理解が高い回答では順序が反転する 企業理解(${motivationOnCompanyHeavy}) > 自己分析(${selfOnCompanyHeavy})`,
);

// B-4 weight 数値対応が単調（none=0 < low < medium < high < veryHigh）。
const W = CAREER_INTERVIEW_RUBRIC_WEIGHT_VALUES;
check(
  W.none === 0 && W.low < W.medium && W.medium < W.high && W.high < W.veryHigh,
  `B-4 rubric ウェイトの数値対応が単調（none=0 < low < medium < high < veryHigh）`,
);

// ════════════════════════════════════════════════════════════════════
// C. 面接 — prompt が「AI に総合点を決めさせない」
// ════════════════════════════════════════════════════════════════════
console.log('\n# C. 面接 prompt の authority 契約');

for (const mode of LIVE_MODES) {
  const instruction = buildFinalFeedbackInstruction(mode, false, null);
  const scored = scoredInterviewCriteria(getInterviewModeConfig(mode));
  const noneKeys = CAREER_INTERVIEW_RUBRIC_CRITERION_KEYS.filter(
    (k) => getInterviewModeConfig(mode).rubric[k] === 'none',
  );

  // C-1 出力スキーマに criterionScores が出る。
  check(
    instruction.includes('"criterionScores"'),
    `C-1 ${mode}: 最終評価 prompt が criterionScores を要求する`,
  );
  // C-2 採点対象の criterion key がすべてスキーマに列挙される。
  check(
    scored.every((k) => instruction.includes(`"${k}"`)),
    `C-2 ${mode}: 採点対象 ${scored.length} 軸すべてが出力スキーマに列挙される`,
  );
  // C-3 ★ 評価対象外の criterion key はスキーマに出さない（0 点混入の構造的防止）。
  check(
    noneKeys.every((k) => !instruction.includes(`"${k}": number`)),
    `C-3 ${mode}: 評価対象外（none）の criterion は出力スキーマに含まれない`,
  );
  // C-4 総合点・ランクを AI に出させない旨が明示される。
  check(
    instruction.includes('総合点・ランクは出力しないでください'),
    `C-4 ${mode}: prompt が「総合点・ランクは出力しない」を明示する`,
  );
  // C-5 出力スキーマに totalScore / overallScore / rank の key が無い。
  check(
    !instruction.includes('"overallScore"') &&
      !instruction.includes('"totalScore"') &&
      !instruction.includes('"rank"'),
    `C-5 ${mode}: 出力スキーマに overallScore / totalScore / rank が無い`,
  );
}

// C-6 route が AI の overallScore を読まず、server 算出関数を使っている（静的検査）。
{
  const src = codeOnly(read('app/api/career/interview/complete/route.ts'));
  check(
    src.includes('computeInterviewOverallScore') &&
      src.includes('normalizeInterviewCriterionScores'),
    'C-6 complete route が server 算出（computeInterviewOverallScore）を使う',
  );
  check(
    !/r\.overallScore/.test(src) && !/r\.rank/.test(src),
    'C-6b ★ complete route が AI 出力の overallScore / rank を読まない',
  );
}

// ════════════════════════════════════════════════════════════════════
// D. プレゼン — 8 軸から server が総合点・ランクを導出する
// ════════════════════════════════════════════════════════════════════
console.log('\n# D. プレゼン 8 軸 → server overallScore / rank');

{
  const src = codeOnly(read('app/api/career/presentation/evaluate/route.ts'));

  // D-1 8 軸の定義が変わっていない（評価軸そのものは維持する）。
  const expectedAxes = [
    'structure',
    'clarity',
    'concreteness',
    'logic',
    'persuasion',
    'delivery',
    'timeManagement',
    'connection',
  ];
  check(
    CAREER_PRESENTATION_AXES.length === 8 &&
      CAREER_PRESENTATION_AXES.every((a, i) => a.key === expectedAxes[i]),
    `D-1 プレゼン 8 軸の key / 順序が維持されている`,
  );

  // D-2 ★ AI の自己申告 totalScore を読まない。
  check(
    !/clampScore\(\s*r\.totalScore\s*\)/.test(src) && !/r\.totalScore/.test(src),
    'D-2 ★ evaluate route が AI の totalScore を読まない',
  );
  // D-3 ★ AI の rank を読まない（rank は overallScore からのみ決まる）。
  check(
    !/r\.rank/.test(src) && !/normalizeRank/.test(src),
    'D-3 ★ evaluate route が AI の rank を読まない（normalizeRank は廃止）',
  );
  // D-4 server が axes から総合点を算出している。
  check(
    /computePresentationTotalScore\(axes\)/.test(src) &&
      /presentationRankFromScore\(totalScore\)/.test(src),
    'D-4 totalScore=computePresentationTotalScore(axes) / rank=presentationRankFromScore(totalScore)',
  );

  // D-5 prompt が totalScore / rank を要求しない。
  const promptSrc = read('app/api/career/presentation/presentationPrompt.ts');
  check(
    !promptSrc.includes('"totalScore": 0〜100の整数') &&
      !promptSrc.includes('"rank": "S" | "A" | "B" | "C" | "D"'),
    'D-5 プレゼン prompt の出力スキーマから totalScore / rank が削除されている',
  );
  check(
    promptSrc.includes('総合点（totalScore）とランク（rank）は出力しないでください'),
    'D-5b プレゼン prompt が「総合点・ランクを出力しない」を明示する',
  );

  // D-6 rank 閾値（90/80/65/50）は据え置き＝プレゼン固有の設計を変えていない。
  //   ★ 算出は presentationPrompt.ts へ lift 済み（QA が fixture で直接叩けるようにするため）。
  check(
    presentationRankFromScore(90) === 'S' &&
      presentationRankFromScore(89) === 'A' &&
      presentationRankFromScore(80) === 'A' &&
      presentationRankFromScore(79) === 'B' &&
      presentationRankFromScore(65) === 'B' &&
      presentationRankFromScore(64) === 'C' &&
      presentationRankFromScore(50) === 'C' &&
      presentationRankFromScore(49) === 'D',
    'D-6 プレゼン固有の rank 閾値（90/80/65/50）が変更されていない',
  );

  // ── D-7 ★ 中核 fixture: 8 軸が全部 40 なら総合は 40。AI の 85 は採用されない。
  const allForty = CAREER_PRESENTATION_AXES.map((a) => ({ key: a.key, score: 40 }));
  const forty = computePresentationTotalScore(allForty);
  check(forty === 40, `D-7 ★ axes 全て 40 → overallScore=40（実測 ${forty}）`);
  check(
    presentationRankFromScore(forty) === 'D',
    `D-7b ★ その総合点から rank=D（AI が 'S' を返しても採用されない）`,
  );
  // D-8 端値・混在。
  check(
    computePresentationTotalScore(CAREER_PRESENTATION_AXES.map(() => ({ score: 100 }))) === 100 &&
      computePresentationTotalScore(CAREER_PRESENTATION_AXES.map(() => ({ score: 0 }))) === 0,
    'D-8 全 100 → 100 / 全 0 → 0',
  );
  {
    // 4 軸 100 / 4 軸 20 → 平均 60（= B ではなく C）。
    const mixed = CAREER_PRESENTATION_AXES.map((_, i) => ({ score: i < 4 ? 100 : 20 }));
    const m = computePresentationTotalScore(mixed);
    check(m === 60 && presentationRankFromScore(m) === 'C', `D-8b 混在 → 60 / rank=C（実測 ${m}）`);
  }
  check(computePresentationTotalScore([]) === 0, 'D-8c axes が空でも throw せず 0');
}

// ════════════════════════════════════════════════════════════════════
// E. GD — solo / multi の評価軸が統合されていない
// ════════════════════════════════════════════════════════════════════
console.log('\n# E. GD solo / multi の評価軸分離');

{
  const soloSrc = read('app/api/career/gd/feedback/route.ts');
  const multiSrc = read('app/api/career/gd/room/roomFeedback.ts');

  // E-1 solo 固有 6 軸が維持されている。
  const soloAxes = ['logic', 'cooperation', 'volume', 'roleExecution', 'drive', 'listening'];
  check(
    soloAxes.every((a) => new RegExp(`${a}:\\s*0\\.`).test(soloSrc)),
    'E-1 GD solo 固有 6 軸のウェイトが維持されている',
  );
  // E-2 multi 固有 6 軸が維持されている。
  const multiAxes = [
    'logicalThinking',
    'collaboration',
    'initiative',
    'creativity',
    'persuasiveness',
    'discussionSkill',
  ];
  check(
    multiAxes.every((a) => new RegExp(`${a}:\\s*0?\\.`).test(multiSrc)),
    'E-2 GD multi 固有 6 軸のウェイトが維持されている',
  );
  // E-3 ★ 相互に混ざっていない（統合されていない）。
  check(
    !multiAxes.some((a) => soloSrc.includes(`${a}:`)) &&
      !soloAxes.some((a) => new RegExp(`\\b${a}:\\s*0\\.`).test(multiSrc)),
    'E-3 ★ solo / multi の評価軸が相互に混入していない（統合されていない）',
  );
  // E-4 どちらも server が総合点を決める（AI に決めさせない）。
  check(
    /computeTotal\(/.test(soloSrc) && /toGrade\(/.test(soloSrc),
    'E-4 GD solo: server が totalScore / companyGrade を算出する',
  );
  check(
    /computeOverallScore\(/.test(multiSrc) && /computeCommunicationGrade\(/.test(multiSrc),
    'E-4b GD multi: server が overallScore / grade を算出する',
  );
}

// ════════════════════════════════════════════════════════════════════
// F. ES — 今回変更していないこと（採点ロジックの回帰防止）
// ════════════════════════════════════════════════════════════════════
console.log('\n# F. ES 採点ロジックの非変更');

{
  const src = codeOnly(read('app/api/career/es-review/route.ts'));
  check(
    /const overallScore = Math\.round\(sum \/ BREAKDOWN_KEYS\.length\)/.test(src),
    'F-1 ES overallScore は 6 軸平均のまま（server 算出）',
  );
  check(
    /score >= 90[\s\S]*?'S'/.test(src) && /score >= 60[\s\S]*?'C'/.test(src),
    'F-2 ES 固有の rank 閾値（90/80/70/60）が変更されていない',
  );
  check(
    src.includes("'logic'") &&
      src.includes("'companyFit'") &&
      /BREAKDOWN_KEYS = \[/.test(src),
    'F-3 ES 6 軸の定義が維持されている',
  );
}

console.log(`\n${fails === 0 ? '✅ ALL PASS' : `❌ ${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);

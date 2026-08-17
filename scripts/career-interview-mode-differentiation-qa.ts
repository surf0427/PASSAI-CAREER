/*
 * scripts/career-interview-mode-differentiation-qa.ts
 *
 * PASSAI CAREER — 面接モード差別化 / 面接設定の実質反映 QA（dev-only 常設・決定的）。
 *
 * 目的:
 *   「面接前の設定（企業 / 業界 / 職種 / 選考種別 / 重点対策）」と「4 つの面接モード」が、
 *   ラベル・metadata ではなく **面接の挙動そのもの**（質問生成 / 深掘り / 評価 rubric /
 *   採点難易度 / 改善提案）へ到達していることを機械的に固定する。
 *
 *   ★ 本 QA が禁止したい退行（= fake implementation）:
 *     - 4 モードが同一 rubric / 同一質問プール / 同一深掘り軸になる。
 *     - mode 名を prompt に 1 行足しただけで挙動が同じ。
 *     - 業界 / 選考種別が保存されるだけで prompt では実質使われない（見せかけの配線）。
 *     - 難易度が「厳しく評価して」の一文だけで、到達条件（threshold）が同じ。
 *
 *   仕様対応: A. setup→API / B. 質問生成 / C. 評価 / D. モード差別化 /
 *            E. 難易度差別化 / F. 選考種別 / G. 重点対策。
 *
 * 厳守:
 *   production の純関数・純データを読むだけ。外部 AI 非実行・実データ非参照・DB/Supabase 非接続。
 *
 * 使い方: npx tsx scripts/career-interview-mode-differentiation-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildInterviewBaseSystem,
  buildSeedUserPrompt,
  buildFollowupUserPrompt,
  buildFinalFeedbackInstruction,
} from '@/app/api/career/interview/interviewPrompt';
import {
  getInterviewModeConfig,
  normalizeInterviewTarget,
  buildInterviewRubricLines,
  CAREER_INTERVIEW_MODE_ORDER,
  CAREER_INTERVIEW_DIFFICULTY_ORDER,
  CAREER_INTERVIEW_RUBRIC_CRITERIA,
  type CareerInterviewRubricCriterionKey,
} from '@/app/career/interview/interviewModes';
import type { CareerInterviewTurn, CareerInterviewType } from '@/types/careerInterview';

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

// ── 決定的な入力 ──────────────────────────────────────────────────────
// フィールドごとに固有センチネル（到達を機械判定する）。
const S = {
  company: 'MODESENT株式会社',
  industry: 'INDSENT自動車',
  job: 'JOBSENT総合職',
  focus: 'FOCUSSENT志望動機を深掘りされると弱い',
};

const TARGET_MAIN = normalizeInterviewTarget({
  companyName: S.company,
  industry: S.industry,
  jobType: S.job,
  selectionType: 'main',
  focusPoint: S.focus,
})!;
const TARGET_INTERN = normalizeInterviewTarget({
  ...TARGET_MAIN,
  selectionType: 'internship',
})!;

const TURNS: CareerInterviewTurn[] = [
  { role: 'question', content: '学生時代に力を入れたことを教えてください。' },
  { role: 'answer', content: 'サークルの新歓活動でリーダーを務め参加者を増やしました。' },
  { role: 'question', content: '志望動機を教えてください。' },
  { role: 'answer', content: '御社の理念に共感しました。' },
];

const LIVE_MODES = CAREER_INTERVIEW_MODE_ORDER;
const ALL_MODES: CareerInterviewType[] = [
  ...LIVE_MODES,
  'gakuchika',
  'self_pr',
];

const systemOf = (m: CareerInterviewType, target = TARGET_MAIN) =>
  buildInterviewBaseSystem({ target, interviewType: m });
const seedOf = (m: CareerInterviewType, target = TARGET_MAIN) =>
  buildSeedUserPrompt(m, target);
const followOf = (m: CareerInterviewType, target = TARGET_MAIN) =>
  buildFollowupUserPrompt(TURNS, m, target);
const finalOf = (m: CareerInterviewType, target = TARGET_MAIN) =>
  buildFinalFeedbackInstruction(m, false, target);

// 値（文字列 / 文字列配列）を等値比較するためのキー。
const key = (v: unknown) => JSON.stringify(v);

// 与えた値がモード間で相互に異なるか（同一値のペアが 1 つも無いか）。
function pairwiseDistinct<T>(
  modes: CareerInterviewType[],
  pick: (m: CareerInterviewType) => T,
): { ok: boolean; dup: string } {
  for (let i = 0; i < modes.length; i++) {
    for (let j = i + 1; j < modes.length; j++) {
      if (key(pick(modes[i])) === key(pick(modes[j]))) {
        return { ok: false, dup: `${modes[i]} == ${modes[j]}` };
      }
    }
  }
  return { ok: true, dup: '' };
}

// ─────────────────────────────────────────────────────────────────────
// A. setup → API: 設定値が request / config に到達する配線
// ─────────────────────────────────────────────────────────────────────
console.log('\n# A. setup → API（設定値が request / config へ到達する）');
{
  const targetPage = codeOnly(read('app/career/interview/target/page.tsx'));
  const setupPage = codeOnly(read('app/career/interview/setup/page.tsx'));
  const sessionPage = codeOnly(read('app/career/interview/session/page.tsx'));
  const startRoute = codeOnly(read('app/api/career/interview/start/route.ts'));
  const turnRoute = codeOnly(read('app/api/career/interview/turn/route.ts'));
  const completeRoute = codeOnly(read('app/api/career/interview/complete/route.ts'));

  check(
    ['companyName', 'industry', 'jobType', 'selectionType', 'focusPoint'].every((f) =>
      targetPage.includes(f),
    ),
    'A-1 基本情報フォームが 企業名/業界/職種/選考種別/重点対策 を収集する',
  );
  check(
    /body:\s*JSON.stringify\(\{\s*\.\.\.payload,\s*interviewType,\s*target\s*\}\)/.test(
      setupPage,
    ),
    'A-2 setup が interviewType と target を start API へ送る',
  );
  check(
    /interviewType:\s*session\.interviewType/.test(sessionPage) &&
      /target:\s*session\.target/.test(sessionPage),
    'A-3 session が turn / complete へ同じ interviewType・target を送る（面接中に設定が落ちない）',
  );
  check(
    [startRoute, turnRoute, completeRoute].every(
      (r) =>
        r.includes('resolveInterviewType(b.interviewType)') &&
        r.includes('normalizeInterviewTarget(b.target)'),
    ),
    'A-4 start / turn / complete の 3 route すべてが interviewType・target を正規化して使う',
  );
  check(
    [startRoute, turnRoute, completeRoute].every((r) =>
      /target,\s*\n\s*interviewType,/.test(r),
    ),
    'A-5 3 route すべてが target・interviewType を prompt builder へ渡す',
  );
  // 設定が session に保存され、結果ログへ引き継がれる（履歴の後方互換の起点）。
  check(
    /\.\.\.\(target \? \{ target \} : \{\}\)/.test(setupPage) &&
      /\.\.\.\(session\.target \? \{ target: session\.target \} : \{\}\)/.test(sessionPage),
    'A-6 target は session → 結果ログへ引き継がれる（欠損時は付けない＝旧ログ互換）',
  );
}

// ─────────────────────────────────────────────────────────────────────
// B. question generation: 設定値が質問生成 context に使われる
// ─────────────────────────────────────────────────────────────────────
console.log('\n# B. 質問生成 context への到達');
for (const m of LIVE_MODES) {
  const sys = systemOf(m);
  check(
    sys.includes(S.company) && sys.includes(S.industry) && sys.includes(S.job),
    `B-1 ${m}: 企業 / 業界 / 職種 が質問生成 system へ到達`,
  );
  check(
    sys.includes('本選考') && sys.includes(S.focus),
    `B-2 ${m}: 選考種別 / 重点対策 が質問生成 system へ到達`,
  );
  const gen = `${seedOf(m)}\n${followOf(m)}`;
  check(
    gen.includes(S.focus) && gen.includes(S.job),
    `B-3 ${m}: 重点対策 / 職種 が operative な質問選択指示（seed / followup）へ到達`,
  );
}
// 業界・選考種別は「自己分析モードでは重心を変えない」ことが仕様。
for (const m of ['motivation', 'real', 'pressure'] as const) {
  const gen = `${seedOf(m)}\n${followOf(m)}`;
  check(
    gen.includes(S.industry) && /本選考/.test(gen),
    `B-4 ${m}: 業界 / 選考種別 が operative な質問選択指示へ到達（表示専用になっていない）`,
  );
}
check(
  !followOf('self_analysis').includes(
    `志望業界「${S.industry}」について、「なぜこの業界か」`,
  ),
  'B-5 自己分析モードは業界理解の深掘り優先度を上げない（モード責務の分離）',
);

// ─────────────────────────────────────────────────────────────────────
// C. evaluation: 設定値が評価 context に使われる
// ─────────────────────────────────────────────────────────────────────
console.log('\n# C. 評価 context への到達');
for (const m of LIVE_MODES) {
  const fin = finalOf(m);
  check(
    fin.includes(S.company) &&
      fin.includes(S.industry) &&
      fin.includes(S.job) &&
      fin.includes(S.focus),
    `C-1 ${m}: 企業 / 業界 / 職種 / 重点対策 が評価 instruction へ到達`,
  );
  check(
    fin.includes('selectionTypeComment') && fin.includes('入社意思'),
    `C-2 ${m}: 選考種別（本選考）が評価観点として到達`,
  );
}
// 質問生成と評価で同じ設定を使う（片方だけ設定が落ちる状態を禁止）。
for (const m of LIVE_MODES) {
  for (const [name, sentinel] of Object.entries(S)) {
    const inGen = systemOf(m).includes(sentinel);
    const inEval = finalOf(m).includes(sentinel) || systemOf(m).includes(sentinel);
    check(inGen && inEval, `C-3 ${m}: ${name} が質問生成と評価の両方で使われる`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// D. mode differentiation: 4 モードが同一 rubric / 同一挙動になっていない
// ─────────────────────────────────────────────────────────────────────
console.log('\n# D. 4 モードの差別化');
{
  const CRITERIA = Object.keys(
    CAREER_INTERVIEW_RUBRIC_CRITERIA,
  ) as CareerInterviewRubricCriterionKey[];

  // rubric は全 criterion を明示する（欠損＝暗黙の共通配点に戻ることを防ぐ）。
  check(
    ALL_MODES.every((m) => {
      const r = getInterviewModeConfig(m).rubric;
      return CRITERIA.every((c) => typeof r[c] === 'string' && r[c].length > 0);
    }),
    'D-1 旧モードを含む全 config が rubric の全観点を明示している',
  );

  // ★ 中核: 4 モードの評価ウェイト vector が相互に異なる（= 単一共通 rubric ではない）。
  const rubricVec = (m: CareerInterviewType) =>
    CRITERIA.map((c) => getInterviewModeConfig(m).rubric[c]);
  const rubricDistinct = pairwiseDistinct(LIVE_MODES, rubricVec);
  check(rubricDistinct.ok, `D-2 ★ 4 モードの評価ウェイトが相互に異なる${rubricDistinct.dup && ` (${rubricDistinct.dup})`}`);

  // 質問の種類・配分・深掘り方法もモードごとに違う。
  const CONFIG_FIELDS: Array<[string, (m: CareerInterviewType) => string | string[]]> = [
    ['topicPool（質問領域）', (m) => getInterviewModeConfig(m).topicPool],
    ['deepDiveAxes（深掘り軸）', (m) => getInterviewModeConfig(m).deepDiveAxes],
    ['followupIntensity（深掘り強度）', (m) => getInterviewModeConfig(m).followupIntensity],
    ['contextUsage（利用する Data Spine）', (m) => getInterviewModeConfig(m).contextUsage],
    ['improvementFocus（改善提案の重心）', (m) => getInterviewModeConfig(m).improvementFocus],
    ['persona（面接官の挙動）', (m) => getInterviewModeConfig(m).persona],
  ];
  for (const [field, pick] of CONFIG_FIELDS) {
    const r = pairwiseDistinct(LIVE_MODES, pick);
    check(r.ok, `D-3 ${field} が 4 モードで相互に異なる${r.dup && ` (${r.dup})`}`);
  }

  // 生成される実プロンプトのレベルでも差が出る（config だけ違って prompt が同じ、を防ぐ）。
  for (const [stage, pick] of [
    ['base system', systemOf],
    ['seed（1問目）', seedOf],
    ['followup（深掘り）', followOf],
    ['最終評価 instruction', finalOf],
  ] as const) {
    const r = pairwiseDistinct(LIVE_MODES, (m) => pick(m));
    check(r.ok, `D-4 ★ ${stage} prompt が 4 モードで相互に異なる${r.dup && ` (${r.dup})`}`);
  }

  // rubric block が実際に評価 prompt へ描画されている（config が dead data でない）。
  for (const m of LIVE_MODES) {
    const lines = buildInterviewRubricLines(getInterviewModeConfig(m));
    check(
      lines.length === CRITERIA.length && lines.every((l) => finalOf(m).includes(l)),
      `D-5 ${m}: 評価ウェイトの全行が最終評価 prompt に描画される`,
    );
  }
  // 質問領域プール・深掘り軸も dead data でない。
  for (const m of LIVE_MODES) {
    const cfg = getInterviewModeConfig(m);
    check(
      cfg.topicPool.every((t) => systemOf(m).includes(t)),
      `D-6 ${m}: モード固有の質問領域プールが system prompt に描画される`,
    );
    check(
      cfg.deepDiveAxes.every((a) => followOf(m).includes(a)) &&
        followOf(m).includes(cfg.followupIntensity),
      `D-7 ${m}: モード固有の深掘り軸・追及強度が followup prompt に描画される`,
    );
  }

  // 面接中の矛盾チェックは本番 / 圧迫のみ。かつ発言の捏造を禁止している。
  check(
    !followOf('self_analysis').includes('これまでの回答との整合性') &&
      !followOf('motivation').includes('これまでの回答との整合性') &&
      followOf('real').includes('これまでの回答との整合性') &&
      followOf('pressure').includes('これまでの回答との整合性'),
    'D-8 過去回答との矛盾チェックは本番 / 圧迫モードでのみ有効',
  );
  check(
    ['real', 'pressure'].every((m) =>
      followOf(m as CareerInterviewType).includes(
        '言っていない内容を「先ほど〇〇と言っていましたが」と作り出すことは絶対に禁止',
      ),
    ),
    'D-9 ★ 矛盾チェックは「学生が発言していない内容の捏造」を明示的に禁止する',
  );

  // 圧迫モードのハラスメント guardrail（厳しさ = 質問・反論・追及の強さに限定）。
  const pressureAll = `${systemOf('pressure')}\n${followOf('pressure')}\n${finalOf('pressure')}`;
  check(
    pressureAll.includes('人格否定') &&
      pressureAll.includes('罵倒') &&
      pressureAll.includes('差別'),
    'D-10 ★ 圧迫モードは人格否定・罵倒・差別を明示的に禁止する',
  );
}

// ─────────────────────────────────────────────────────────────────────
// E. difficulty differentiation: 採点 threshold がモードで異なる
// ─────────────────────────────────────────────────────────────────────
console.log('\n# E. 採点難易度の差別化');
{
  check(
    CAREER_INTERVIEW_DIFFICULTY_ORDER.join(',') ===
      'self_analysis,motivation,real,pressure',
    'E-1 難易度の昇順は 自己分析 < 企業理解 < 本番 < 圧迫面接',
  );
  const ranks = CAREER_INTERVIEW_DIFFICULTY_ORDER.map(
    (m) => getInterviewModeConfig(m).difficultyRank,
  );
  check(
    ranks.every((r, i) => i === 0 || r > ranks[i - 1]),
    `E-2 ★ difficultyRank が狭義単調増加（実測: ${ranks.join(' < ')}）`,
  );
  // 「厳しく評価して」の一文だけにしない = 到達条件（threshold）そのものが違う。
  const standardDistinct = pairwiseDistinct(
    LIVE_MODES,
    (m) => getInterviewModeConfig(m).scoringStandard,
  );
  check(
    standardDistinct.ok,
    `E-3 ★ 高評価の到達条件（scoringStandard）が 4 モードで相互に異なる${standardDistinct.dup && ` (${standardDistinct.dup})`}`,
  );
  for (const m of LIVE_MODES) {
    const cfg = getInterviewModeConfig(m);
    const fin = finalOf(m);
    check(
      fin.includes(`難易度 ${cfg.difficultyRank}/4`) && fin.includes(cfg.scoringStandard),
      `E-4 ${m}: 難易度と到達条件が最終評価 prompt に描画される`,
    );
  }
  // 不自然な固定減点の禁止も明示されている（難易度＝threshold 変更であることの担保）。
  check(
    LIVE_MODES.every((m) => finalOf(m).includes('一律に点を引くような不自然な減点はしない')),
    'E-5 難易度は threshold の変更であり、一律減点ではないことを明示する',
  );
  // 本番 / 圧迫は「それっぽい回答」に高得点を出さない要求水準を持つ。
  check(
    finalOf('real').includes('「それっぽく聞こえる回答」に高得点を出さない') &&
      finalOf('pressure').includes('本番モードの到達条件をすべて満たしたうえで'),
    'E-6 本番は「それっぽい回答」を弾き、圧迫は本番の水準を上回る要求をする',
  );
}

// ─────────────────────────────────────────────────────────────────────
// F. selection type: 本選考 / インターンで評価観点が変わる
// ─────────────────────────────────────────────────────────────────────
console.log('\n# F. 本選考 / インターンの分離');
for (const m of ['motivation', 'real', 'pressure'] as const) {
  check(
    systemOf(m, TARGET_MAIN) !== systemOf(m, TARGET_INTERN),
    `F-1 ${m}: 選考種別で質問生成 system が変わる`,
  );
  check(
    followOf(m, TARGET_MAIN) !== followOf(m, TARGET_INTERN),
    `F-2 ${m}: 選考種別で深掘り優先度が変わる`,
  );
  check(
    finalOf(m, TARGET_MAIN) !== finalOf(m, TARGET_INTERN),
    `F-3 ${m}: 選考種別で評価 instruction が変わる`,
  );
}
{
  const mainEval = finalOf('real', TARGET_MAIN);
  const internEval = finalOf('real', TARGET_INTERN);
  check(
    mainEval.includes('入社意思') &&
      mainEval.includes('なぜ競合ではなくこの企業か') &&
      !mainEval.includes('学習意欲・好奇心・成長可能性'),
    'F-4 本選考の評価: 入社意思・志望度・企業固有性を重視する',
  );
  check(
    internEval.includes('学習意欲・好奇心・成長可能性') &&
      internEval.includes('検証したい仮説') &&
      internEval.includes('入社意思の強さ・入社後の貢献可能性の比重は下げて'),
    'F-5 インターンの評価: 学習意欲・成長可能性を重視し、入社意思の比重を下げる',
  );
  // 単なる表示ではなく、rubric のウェイトを上書きする指示になっている。
  check(
    mainEval.includes('一段上げて採点する') && internEval.includes('一段上げ'),
    'F-6 ★ 選考種別は評価ウェイトそのものを動かす（表示項目ではない）',
  );
}

// ─────────────────────────────────────────────────────────────────────
// G. focus: 重点対策が 質問 / 深掘り / 評価 へ到達する
// ─────────────────────────────────────────────────────────────────────
console.log('\n# G. 重点対策（特に対策したいこと）');
for (const m of LIVE_MODES) {
  check(seedOf(m).includes(S.focus), `G-1 ${m}: 重点対策が 1 問目の入口選択へ到達`);
  check(
    followOf(m).includes(S.focus) && followOf(m).includes('最優先'),
    `G-2 ${m}: 重点対策が深掘りの最優先ルールへ到達`,
  );
  check(finalOf(m).includes(S.focus), `G-3 ${m}: 重点対策が評価 instruction へ到達`);
}
check(
  followOf('real').includes('一段深い層（主張 → なぜそう言えるか → 判断の根拠 → 本人の経験との接続）'),
  'G-4 重点対策は連鎖的に掘る（1 回の確認で終わらせない）',
);
check(
  systemOf('real').includes('全質問をこのテーマだけにしないでください'),
  'G-5 ★ 重点対策は「通常面接 + 重点対策」であり全質問を占有しない',
);
check(
  finalOf('real').includes('重点対策として指定された') &&
    finalOf('real').includes('材料が無いまま評価を捏造しない'),
  'G-6 評価は重点対策に明示的に言及する（材料が無ければ捏造せずその旨を書く）',
);

// ─────────────────────────────────────────────────────────────────────
// H. 後方互換: target 無し（旧セッション）・旧モードでも壊れない
// ─────────────────────────────────────────────────────────────────────
console.log('\n# H. 過去ログ互換');
for (const m of ALL_MODES) {
  const sys = buildInterviewBaseSystem({ interviewType: m });
  const seed = buildSeedUserPrompt(m);
  const follow = buildFollowupUserPrompt(TURNS, m);
  const fin = buildFinalFeedbackInstruction(m);
  check(
    [sys, seed, follow, fin].every((s) => s.length > 0) &&
      ![sys, seed, follow, fin].some((s) =>
        Object.values(S).some((sentinel) => s.includes(sentinel)),
      ),
    `H-1 ${m}: target 無しでも全 stage の prompt が成立し、設定値は一切漏れない`,
  );
  check(
    fin.includes(`難易度 ${getInterviewModeConfig(m).difficultyRank}/4`),
    `H-2 ${m}: 旧モードを含め難易度が解決できる（過去ログの再評価が壊れない）`,
  );
}
check(
  getInterviewModeConfig('unknown-legacy-mode').type === 'real',
  'H-3 未知 / 未指定の interviewType は本番モードへ安全に倒れる',
);
// 結果画面は target を持たない過去ログでも面接条件（モード）を出せる。
{
  const resultPage = codeOnly(read('app/career/interview/result/page.tsx'));
  check(
    resultPage.includes('今回の面接条件') &&
      /selected\.target \?/.test(resultPage) &&
      resultPage.includes('重点対策:'),
    'H-4 結果画面が「今回の面接条件」（企業/業界/職種/選考種別/モード/重点対策）を表示する',
  );
}

console.log('');
console.log(fails === 0 ? 'ALL_PASS' : `FAIL: ${fails}`);
process.exit(fails === 0 ? 0 : 1);

// PASSAI 就活版 — 自己分析「深掘り壁打ち」共通プロンプト組み立て
//
// 役割: /api/career/self-analysis/question（会話型の深掘り質問生成）が利用する。
//   - 受験版（/api/analysis・/api/analysis/additional・/api/summarize）には一切依存しない。
//   - 質問は「1問→回答→回答に応じた次の1問」の自然な会話（壁打ち）。面接官ではなく、
//     本人の言語化を助ける自己分析コーチのトーン。
//   - プロンプト土台は就活版共通基盤（@/lib/careerAi）からのみ組み立てる
//     （プロフィール＋活動整理＋就活軸を context として共有）。
//   - 引き出す情報は ES・面接・マッチング・企業分析AI で再利用できる粒度を狙う。
// 本ファイルは route ではない（route.ts 以外なのでエンドポイント化されない）。共有モジュール。

import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisTurn } from '@/types/careerSelfAnalysis';
import {
  buildCoverageInventory,
  formatCoverageForPrompt,
  formatPastSummariesForPrompt,
  type SelfAnalysisPastSummary,
} from '@/lib/careerSelfAnalysis/pastLogSummary';

// 機能キー（就活版共通基盤の出し分け。自己分析の機能別指示を流用する）。
const FEATURE_KEY = 'career-self-analysis' as const;

// 受験版自己分析と同系の Sonnet を使用（課金/usage には接続しない）。
export const CAREER_SELF_ANALYSIS_MODEL = 'claude-sonnet-4-6';

// 深掘り質問の上限。面接（5問）より少し多めにし、自己分析の深さを確保する。
export const CAREER_SELF_ANALYSIS_MAX_TURNS = 6;

// 壁打ちパートナーの人格・話し方（全ターン共通）。
const COACH_PERSONA = [
  'あなたは、日本の大学生・大学院生の新卒就活を支援する「自己分析の壁打ちパートナー」です。',
  '面接官ではありません。学生本人が、自分の経験・強み・価値観を自分の言葉で language 化できるよう、',
  '対話を通じて優しく深掘りしていきます。',
  '',
  '【話し方・進め方】',
  '- 落ち着いて親しみやすく、安心して話せる雰囲気にする。詰問・尋問にしない。',
  '- 質問は必ず1つだけ。毎回同じ言い回し・定型文を避け、表現を変える。',
  '- 箇条書き・番号・記号の多用・長すぎる発話は禁止（自然な口語）。',
  '- 学生の実体験・具体的なエピソードに即して深掘りする（一般論で埋めない）。',
  '- 抽象的すぎる質問・Yes/Noで終わる質問・既出の繰り返し・答えにくい質問・説教めいた質問は避け、',
  '  答えやすく具体的で開かれた問いにする。',
  '- 1回の対話で全てを掘り切ろうとしない。自己分析は複数回でだんだん深まる前提なので、',
  '  今回は活動・価値観を「幅広く・浅〜中程度に」横断して確認することを優先する。',
  '- 1つの活動・1つの価値観だけを連続で深掘りしすぎない。観点や対象を切り替えながら全体像を作る。',
  '- 深掘りの狙いは「多く質問すること」ではなく、ES・面接・企業選びで再利用できる具体情報',
  '  （行動の理由や判断基準・数字や変化・再現性・価値観・力を発揮できる/避けたい環境・キャリアや就活軸との接続）を、',
  '  自然な会話で1つずつ引き出すこと。',
  '- 事実確認が必要な情報（企業の事業内容・待遇・選考フロー等）は断定しない。',
].join('\n');

// 深掘りで扱うテーマ（観点を変えながら掘り下げるためのプール）。
const CAREER_SELF_ANALYSIS_TOPICS = [
  '学生時代に力を入れた経験（ガクチカ）',
  '自己PR・強みが発揮された具体的な場面と役割',
  '困難・挫折と、その乗り越え方（思考プロセス）',
  '成果の具体化（数字・Before/After・周囲への影響）',
  '経験から育まれた価値観・大切にしたいこと',
  'モチベーションの源泉／力を発揮できる環境・避けたい環境',
  '強みの再現性（他の場面でも発揮できそうか）',
  '興味のある業界・職種や就活軸との接続',
];

// 深掘りで引き出したい観点（ES・面接・マッチング・企業分析AI で再利用できる粒度）。
// followup の質問は毎回この中から「その回答で最も価値が高く、まだ十分に聞けていない1点」を選んで掘る。
const CAREER_DEEP_DIVE_AXES = [
  '行動の理由・判断基準（なぜそれを選んだか／他に選択肢はあったか／何を基準に決めたか）',
  '発揮した能力・担った役割（具体的に何をしたか）',
  '定量的な成果・変化（数字／Before・After／改善の度合い／周囲への影響）',
  '一番苦労した点・悩んだ点と、その乗り越え方（思考プロセス）',
  '周囲からの評価・周囲との関わり方',
  '強みの再現性（他の場面でも同じ強みを発揮できそうか、なぜそう思うか）',
  '価値観・モチベーションの源泉（その経験から大切にするようになったこと）',
  '力を発揮できる環境／ストレスを感じる・避けたい環境',
  '興味のある業界・職種や就活軸との接続（この経験はどんな仕事で活きそうか）',
];

// 会話履歴を transcript テキストに整形する。
export function buildTranscript(turns: CareerSelfAnalysisTurn[]): string {
  return turns
    .map((t) => (t.role === 'question' ? `壁打ち相手: ${t.content}` : `あなた: ${t.content}`))
    .join('\n');
}

// 回答済み件数（= 回答ターン数）。
export function countAnswers(turns: CareerSelfAnalysisTurn[]): number {
  return turns.filter((t) => t.role === 'answer').length;
}

export type CareerSelfAnalysisDeepDiveInput = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  // 過去の自己分析ログの軽量サマリ（最新→過去・最大3件）。繰り返し回避・次テーマ選定に使う。
  pastSummaries?: SelfAnalysisPastSummary[] | null;
};

// 深掘り壁打ちの土台 system prompt を組む。
// 就活版共通基盤（プロフィール＋活動＋就活軸）+ コーチ人格 + カバレッジ棚卸し +
// 過去ログサマリ（あれば）+ 深掘りテーマを 1 つにまとめる。
export function buildDeepDiveBaseSystem(input: CareerSelfAnalysisDeepDiveInput): string {
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile: input.profile ?? null,
    activity: input.activity ?? null,
    values: input.values ?? null,
    userInput: '',
  });
  // P3-E: base system prompt を Context Orchestrator（purpose=self_analysis_deep_dive）経由で取得する。
  //   委譲のため出力は現行と同一。coverage/pastLog/topics/幅優先ローテ/最大ターンは builder 側で不変。
  const orchestrated = buildCareerContextForPurpose('self_analysis_deep_dive', context);

  // 入力済みの活動・就活軸の棚卸し（活動/価値観の偏りを防ぎ、幅広い横断を促す）。
  const coverageBlock = formatCoverageForPrompt(
    buildCoverageInventory(input.activity ?? null, input.values ?? null),
  );
  // 過去ログサマリ（無ければ空文字＝ブロックごと出さない）。
  const pastBlock = formatPastSummariesForPrompt(input.pastSummaries ?? null);

  return [
    COACH_PERSONA,
    // 機能別指示は orchestrated.systemPrompt（buildCareerSystemPrompt 内）に既に1回含まれる。
    orchestrated.systemPrompt,
    coverageBlock,
    pastBlock,
    `# 深掘りで扱うテーマ（観点を変えて掘り下げる）\n${CAREER_SELF_ANALYSIS_TOPICS.map((t) => `- ${t}`).join('\n')}`,
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}

// 質問番号ごとの「今回の狙い」。1つの観点への偏りを防ぐため、序盤で観点・対象を計画的にずらす。
// 1問目=seed / 2問目以降=followup。上限を超えた分は未確認テーマの補完に回す。
export function focusForQuestion(questionNumber: number): string {
  switch (questionNumber) {
    case 1:
      return '活動整理の中から代表的な活動を1つ選び、経験の全体像を話してもらう';
    case 2:
      return '1問目とは別の活動・役割に切り替える（同じ活動を続けて掘らない）';
    case 3:
      return '就活軸・価値観（大切にしたいこと／働き方の希望／避けたい環境）に触れる';
    case 4:
      return '活動経験と価値観のつながり（なぜその価値観になったか／経験と就活軸の整合）を確認する';
    case 5:
      return '強み・向いている環境の仮説を、本人の言葉で確認する';
    default:
      return 'まだ質問で扱えていない活動・価値観・弱み・ストレス要因・就活軸を優先して補完する';
  }
}

// seed（1問目）生成の user プロンプト。
export function buildSeedUserPrompt(): string {
  return [
    '自己分析の深掘り（壁打ち）を始めます。',
    `全${CAREER_SELF_ANALYSIS_MAX_TURNS}問程度で、活動・価値観を幅広く横断しながら、後で具体を掘り下げられるように対話していきます。`,
    `今回の狙い（1問目）: ${focusForQuestion(1)}。`,
    '「入力済みの活動・就活軸」に挙がっている活動の中から代表的なものを1つ取り上げ、',
    '後から行動・成果・学びを深掘りしやすい「具体的な経験」を1つ話してもらえるような、答えやすく開かれた質問を1つだけ出してください。',
    'いきなり数字や細部を問い詰めず、まずは経験の全体像を話しやすい入口にしてください。',
    '（過去の自己分析がある場合）前回までと同じ切り口の繰り返しは避け、まだ触れていない活動を優先してください。',
    '出力は質問文そのものだけ（前置き・説明・記号・引用符は付けない）。',
  ].join('\n');
}

// followup（回答を踏まえた次質問）生成の user プロンプト。JSON {reaction, question} を要求する。
export function buildFollowupUserPrompt(turns: CareerSelfAnalysisTurn[]): string {
  const questionNumber = Math.min(countAnswers(turns) + 1, CAREER_SELF_ANALYSIS_MAX_TURNS);
  return [
    'これまでのやり取り:',
    buildTranscript(turns),
    '',
    `これは${questionNumber}問目（全${CAREER_SELF_ANALYSIS_MAX_TURNS}問程度）です。`,
    `今回の狙い: ${focusForQuestion(questionNumber)}。`,
    '学生の直前の回答に対して、まず一言リアクション（最大1文・共感的に。褒めすぎない）をし、',
    'それを自然に踏まえて、次の質問を1つだけ作ってください。',
    '',
    '質問設計の方針（重要・幅優先）:',
    '- 上記「今回の狙い」に沿って、観点や対象を計画的に切り替える。直前の回答だけに引っ張られすぎない。',
    '- 会話全体と「入力済みの活動・就活軸」を俯瞰し、まだ質問で扱っていない活動・価値観・就活軸を優先する。',
    '- 同じ1つの活動を連続で深掘りしすぎない（原則、同一の活動・エピソードへの深掘りは連続2問まで。3問目は別の対象へ移る）。',
    '- 活動整理と就活軸整理を横断して聞く（活動だけ／価値観だけに偏らない）。',
    '- 1回の自己分析では「深く掘り切る」より「広く見る」ことを優先する（全ての観点を今回で終える必要はない）。',
    '- 選んだ1テーマの中では、文脈に合う次の観点から「最も価値が高い1点」だけを自然に引き出す（一度に複数を問い詰めない）:',
    ...CAREER_DEEP_DIVE_AXES.map((axis) => `  ・${axis}`),
    '- （過去の自己分析がある場合）前回までと同じ質問・切り口を避け、未確認の観点や、前回の結論をさらに具体化する問いを選ぶ。',
    '- 既に聞いた論点・聞き方は繰り返さない。抽象的すぎる質問・Yes/Noで終わる質問・答えにくい質問・説教めいた質問は避ける。',
    '- 目的は「多く質問すること」ではなく、ES・面接・マッチングで再利用できる具体的な情報を、幅広い観点から引き出すこと。',
    '',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '{ "reaction": string, "question": string }',
  ].join('\n');
}

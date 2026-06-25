// PASSAI 就活版 — 面接AI 共通プロンプト組み立て（start / turn / complete 3 route 共有）
//
// 受験版 lib/interviewAi/questionGen.ts / finalFeedback.ts の「構造」を踏襲しつつ、
// 脳みそ（役割・観点・評価軸）を新卒就活専用に差し替える。
//   - 役割: 新卒就活専門の面接官（大学入試・AO/推薦・大学評価軸は一切持ち込まない）。
//   - プロンプト土台は就活版共通基盤（@/lib/careerAi）からのみ組み立てる。
// 本ファイルは route ではない（route.ts 以外なのでエンドポイント化されない）。共有モジュール。

import {
  buildCareerAiContext,
  buildCareerSystemPrompt,
  buildCareerFeatureInstruction,
} from '@/lib/careerAi';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerInterviewTurn } from '@/types/careerInterview';

// 機能キー（就活版共通基盤の出し分け）。
const FEATURE_KEY = 'career-interview' as const;

// 受験版面接AIと同系の Sonnet を使用（課金/usage には接続しない）。
export const CAREER_INTERVIEW_MODEL = 'claude-sonnet-4-6';

// 回答ターン上限（受験版 INTERVIEW_AI_MAX_ANSWER_TURNS=5 を踏襲）。
export const CAREER_INTERVIEW_MAX_TURNS = 5;

// 面接で扱う質問テーマ（新卒就活）。観点を変えながら深掘りするためのプール。
const CAREER_INTERVIEW_TOPICS = [
  'ガクチカ（学生時代に力を入れたこと）',
  '自己PR・強み',
  '志望動機',
  'ES に書いた内容の深掘り',
  '強み・弱み',
  'チームでの役割・協働経験',
  '困難・挫折経験とその乗り越え方',
  'キャリア観・将来像',
  '業界理解',
  '企業理解',
];

// 面接官の人格・話し方（全モード共通）。TTS 読み上げ前提で自然な口語にする。
const INTERVIEWER_PERSONA = [
  'あなたは新卒就活の面接官です。大学生・大学院生の新卒採用面接を担当します。',
  '大学受験（総合型選抜・学校推薦型選抜・一般入試）の文脈や、大学の評価軸は一切持ち込みません。',
  '',
  '【面接官の人格・話し方】',
  '- 落ち着いて丁寧、かつ実際の面接らしい程よい緊張感を保つ。フレンドリーすぎず、雑談化させない。',
  '- 出力は面接官が声に出して話す自然な日本語にする（音声読み上げ前提）。',
  '- 質問は必ず1つだけ。毎回同じ言い回し・定型文を避け、表現を変える。',
  '- 箇条書き・番号・記号の多用・長すぎる発話は禁止。',
  '- 学生の実体験・具体的なエピソードに即して深掘りする（一般論で埋めない）。',
  '- 事実確認が必要な情報（企業の事業内容・待遇・選考フロー等）は断定しない。',
  '- 人格否定・侮辱・嘲笑・脅しは絶対に禁止（指摘は回答内容にのみ向ける）。',
].join('\n');

// 直近の自己分析結果を可読テキストに整形（未提供なら空文字）。
function renderSelfAnalysis(result: CareerSelfAnalysisResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  const push = (label: string, value: string) => {
    if (value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  const pushList = (label: string, values: string[]) => {
    if (values.length > 0) lines.push(`- ${label}: ${values.join('、')}`);
  };
  push('全体所感', result.summary);
  pushList('強み', result.strengths);
  pushList('弱み', result.weaknesses);
  pushList('ガクチカ候補', result.gakuchikaIdeas);
  pushList('自己PR候補', result.selfPrIdeas);
  return lines.join('\n');
}

// 直近の ES 結果を可読テキストに整形（未提供なら空文字）。
function renderEs(result: CareerEsResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  const push = (label: string, value: string) => {
    if (value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  push('キャッチコピー', result.headline);
  push('ガクチカ', result.gakuchika);
  push('自己PR', result.selfPr);
  push('志望動機', result.motivation);
  return lines.join('\n');
}

export type CareerInterviewContextInput = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  selfAnalysis?: CareerSelfAnalysisResult | null;
  es?: CareerEsResult | null;
  userInput?: string;
};

// 面接AIの土台 system prompt を組む。
// 就活版共通基盤（プロフィール+活動）+ 自己分析 + ES + 面接官人格を 1 つにまとめる。
export function buildInterviewBaseSystem(input: CareerInterviewContextInput): string {
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile: input.profile ?? null,
    activity: input.activity ?? null,
    values: input.values ?? null,
    userInput: input.userInput ?? '',
  });

  const selfAnalysisBlock = renderSelfAnalysis(input.selfAnalysis);
  const esBlock = renderEs(input.es);

  return [
    INTERVIEWER_PERSONA,
    buildCareerSystemPrompt(context),
    buildCareerFeatureInstruction(FEATURE_KEY),
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    esBlock ? `# 直近の ES ドラフト\n${esBlock}` : '',
    `# 面接で扱うテーマ（観点を変えて深掘りする）\n${CAREER_INTERVIEW_TOPICS.map((t) => `- ${t}`).join('\n')}`,
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}

// 会話履歴を transcript テキストに整形（受験版 buildTranscript 同形）。
export function buildTranscript(turns: CareerInterviewTurn[]): string {
  return turns
    .map((t) => (t.role === 'question' ? `面接官: ${t.content}` : `学生: ${t.content}`))
    .join('\n');
}

// 既出質問数（= 回答済みの質問数 ≒ answer 件数）。
export function countAnswers(turns: CareerInterviewTurn[]): number {
  return turns.filter((t) => t.role === 'answer').length;
}

// seed（1問目）生成の user プロンプト。
export function buildSeedUserPrompt(): string {
  return [
    '新卒就活の面接を始めます。',
    `全${CAREER_INTERVIEW_MAX_TURNS}問程度で、上記テーマの観点を変えながら深掘りしていきます。`,
    'まずは1問目として、ガクチカ・自己PR・志望動機のいずれかを切り口に、面接の最初の質問を1つだけ出してください。',
    '出力は質問文そのものだけ（前置き・説明・記号・引用符は付けない）。',
  ].join('\n');
}

// followup（回答を踏まえた次質問）生成の user プロンプト。JSON {reaction, question} を要求する。
export function buildFollowupUserPrompt(turns: CareerInterviewTurn[]): string {
  const questionNumber = Math.min(countAnswers(turns) + 1, CAREER_INTERVIEW_MAX_TURNS);
  return [
    'これまでのやり取り:',
    buildTranscript(turns),
    '',
    `これは${questionNumber}問目（全${CAREER_INTERVIEW_MAX_TURNS}問程度）です。`,
    '学生の直前の回答に対して、まず一言リアクション（最大1文・褒めすぎない）をし、',
    'それを自然に踏まえて、まだ十分に聞けていない観点で次の質問を1つだけ作ってください。',
    '既に聞いた論点・聞き方は繰り返さないでください。',
    '',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '{ "reaction": string, "question": string }',
  ].join('\n');
}

// 最終評価 system prompt（JSON 出力スキーマを明示）。
export const FINAL_FEEDBACK_INSTRUCTION = [
  '# 最終フィードバック（出力形式・厳守）',
  'これまでの面接のやり取り全体をもとに、新卒就活の観点で最終フィードバックを作成してください。',
  '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
  '各配列は2〜4個入れ、空配列にしない。実際の回答内容に即した具体的な指摘にし、テンプレ文を避ける。',
  '事実確認が必要な企業・業界情報は断定しない。',
  '',
  '{',
  '  "overallComment": string,      // 全体評価の総括（数文）',
  '  "strengths": string[],         // 良かった点・強み',
  '  "improvements": string[],      // 改善点',
  '  "sampleAnswers": string[],     // より良い回答の例（具体的に）',
  '  "deepDiveTopics": string[],    // さらに深掘りされそうな論点',
  '  "nextActions": string[]        // 本番までに次にやるべきこと',
  '}',
].join('\n');

// 最終評価 user プロンプト。
export function buildFinalUserPrompt(turns: CareerInterviewTurn[]): string {
  return [
    '面接のやり取り:',
    buildTranscript(turns),
    '',
    '上記をもとに、最終フィードバック JSON を出力してください。',
  ].join('\n');
}

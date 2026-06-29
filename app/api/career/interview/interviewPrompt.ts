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
import type {
  CareerInterviewTurn,
  CareerInterviewType,
} from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import {
  getInterviewModeConfig,
  SHARED_INTERVIEWER_RULES,
} from '@/app/career/interview/interviewModes';

// 機能キー（就活版共通基盤の出し分け）。
const FEATURE_KEY = 'career-interview' as const;

// 受験版面接AIと同系の Sonnet を使用（課金/usage には接続しない）。
export const CAREER_INTERVIEW_MODEL = 'claude-sonnet-4-6';

// 回答ターン上限（受験版 INTERVIEW_AI_MAX_ANSWER_TURNS=5 を踏襲）。
export const CAREER_INTERVIEW_MAX_TURNS = 5;

// 面接で扱う質問テーマ（新卒就活）。観点を変えながら深掘りするためのプール。
// 単なる「頑張ったこと」で終わらせず、就活で評価される情報まで自然に掘り下げる狙い。
const CAREER_INTERVIEW_TOPICS = [
  'ガクチカ（学生時代に力を入れたこと）と、その行動を選んだ理由・判断基準',
  '自己PR・強みと、それが発揮された具体的な場面・担った役割',
  '困難・挫折経験と、どう乗り越えたか（思考プロセス）',
  '成果の具体化（数字・Before/After・改善・周囲への影響）',
  'チームでの役割・協働経験と、周囲からの評価',
  '強みの再現性（他の場面でも同じ強みを発揮できそうか、なぜそう思うか）',
  '経験から育まれた価値観・大切にしたいこと',
  '力を発揮できる環境／避けたい環境',
  '志望動機・キャリア観と、興味のある業界・職種との接続',
  '就活軸との共通点',
];

// 深掘りで引き出したい観点（ES・面接・マッチング・企業分析AI で再利用できる粒度）。
// followup の質問は毎回この中から「その回答で最も価値が高く、まだ十分に聞けていない1点」を選んで掘る。
const CAREER_DEEP_DIVE_AXES = [
  '行動の理由・判断基準（なぜそれを選んだか／他に選択肢はあったか／何を基準に決めたか）',
  '発揮した能力・担った役割（具体的に何をしたか）',
  '定量的な成果・変化（数字／Before・After／改善の度合い／周囲への影響）',
  '一番苦労した点・悩んだ点と、その乗り越え方（思考プロセス）',
  '周囲からの評価（チーム・上長・顧客などの反応）',
  '強みの再現性（他の場面でも同じ強みを発揮できそうか、なぜそう思うか）',
  '価値観（その経験から大切にするようになったこと）',
  '力を発揮できる環境／避けたい環境',
  '興味のある業界・職種や就活軸との接続（この経験はどんな仕事で活きそうか）',
];

// 面接官の人格・話し方を、面接の種類（interviewType）に応じて組み立てる。
// 「新卒就活の面接官」という土台 + モード固有の人格 + 全モード共通ルールをまとめる。
function buildPersonaBlock(interviewType: CareerInterviewType | undefined): string {
  const config = getInterviewModeConfig(interviewType);
  return [
    'あなたは新卒就活の面接官です。大学生・大学院生の新卒採用面接を担当します。',
    '大学受験（総合型選抜・学校推薦型選抜・一般入試）の文脈や、大学の評価軸は一切持ち込みません。',
    '',
    `【今回の面接】${config.label}（担当: ${config.interviewerRole}）`,
    config.persona,
    '',
    SHARED_INTERVIEWER_RULES,
  ].join('\n');
}

// 直近の自己分析結果を可読テキストに整形（未提供なら空文字）。
function renderSelfAnalysis(result: CareerSelfAnalysisResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  // v2 フィールドは旧ログで undefined になり得るため、空・非配列は無視して防御する。
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  const pushList = (label: string, values: string[] | undefined) => {
    if (values && values.length > 0) lines.push(`- ${label}: ${values.join('、')}`);
  };
  push('全体所感', result.summary);
  push('キャリアの方向性', result.careerDirection);
  pushList('強み', result.strengths);
  pushList('弱み', result.weaknesses);
  pushList('今後伸ばすべき点', result.developmentPoints);
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

// 就活マッチング結果を可読テキストに整形（未提供なら空文字）。
// 「想定企業との相性」を語るための材料として参照する（断定はしない）。
function renderMatching(result: CareerMatchEngineResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  const pushList = (label: string, values: string[] | undefined, max: number) => {
    if (values && values.length > 0) {
      lines.push(`- ${label}: ${values.slice(0, max).join('、')}`);
    }
  };
  push('適性タイプ', result.careerType);
  pushList('相性の良い業界', result.recommendedIndustries, 5);
  pushList('相性の良い職種', result.recommendedJobs, 5);
  pushList('今後の伸ばしどころ', result.developmentAreas, 4);
  return lines.join('\n');
}

// 相談AIでの最近の気づきを可読テキストに整形（参考程度・未提供なら空文字）。
function renderConsultationInsights(insights: string[] | null | undefined): string {
  if (!insights || insights.length === 0) return '';
  return insights
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .slice(0, 5)
    .map((s) => `- ${s}`)
    .join('\n');
}

export type CareerInterviewContextInput = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  selfAnalysis?: CareerSelfAnalysisResult | null;
  es?: CareerEsResult | null;
  // 任意の参考データ（存在しなくても落ちない／プロンプトに出さないだけ）。
  matching?: CareerMatchEngineResult | null;
  consultationInsights?: string[] | null;
  interviewType?: CareerInterviewType;
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

  const config = getInterviewModeConfig(input.interviewType);
  const selfAnalysisBlock = renderSelfAnalysis(input.selfAnalysis);
  const esBlock = renderEs(input.es);
  const matchingBlock = renderMatching(input.matching);
  const consultationBlock = renderConsultationInsights(input.consultationInsights);

  return [
    buildPersonaBlock(input.interviewType),
    buildCareerSystemPrompt(context),
    buildCareerFeatureInstruction(FEATURE_KEY),
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    esBlock ? `# 直近の ES ドラフト\n${esBlock}` : '',
    matchingBlock ? `# 就活マッチング結果（参考・断定しない）\n${matchingBlock}` : '',
    consultationBlock ? `# 相談AIでの最近の気づき（参考程度）\n${consultationBlock}` : '',
    `# この面接の狙い（${config.label}）\n${config.guidance}`,
    `# 深掘りで扱える観点（毎回この中から最も価値が高い1点を選ぶ）\n${CAREER_INTERVIEW_TOPICS.map((t) => `- ${t}`).join('\n')}`,
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

// seed（1問目）生成の user プロンプト。面接の種類に応じて切り口を変える。
export function buildSeedUserPrompt(interviewType?: CareerInterviewType): string {
  const config = getInterviewModeConfig(interviewType);
  return [
    `新卒就活の面接（${config.label}）を始めます。`,
    `全${CAREER_INTERVIEW_MAX_TURNS}問程度で、後から具体を掘り下げられるように深掘りしていきます。`,
    `1問目の切り口: ${config.seedFocus}`,
    'いきなり数字や細部を問い詰めず、まずは経験の全体像を話しやすい入口にしてください。',
    '出力は質問文そのものだけ（前置き・説明・記号・引用符は付けない）。',
  ].join('\n');
}

// followup（回答を踏まえた次質問）生成の user プロンプト。JSON {reaction, question} を要求する。
export function buildFollowupUserPrompt(
  turns: CareerInterviewTurn[],
  interviewType?: CareerInterviewType,
): string {
  const config = getInterviewModeConfig(interviewType);
  const questionNumber = Math.min(countAnswers(turns) + 1, CAREER_INTERVIEW_MAX_TURNS);
  return [
    'これまでのやり取り:',
    buildTranscript(turns),
    '',
    `これは${questionNumber}問目（全${CAREER_INTERVIEW_MAX_TURNS}問程度）です。面接の種類は「${config.label}」です。`,
    `学生の直前の回答に対して、まず一言リアクション（最大1文・${config.reactionTone}）をし、`,
    'それを自然に踏まえて、次の質問を1つだけ作ってください。',
    '',
    `この面接の狙い: ${config.guidance}`,
    '',
    '深掘りの方針（重要）:',
    '- 直前の回答内容に合わせて、次の観点のうち「最も価値が高く、まだ十分に聞けていない1点」だけを選び、自然な会話の流れで1問だけ掘り下げる。',
    ...CAREER_DEEP_DIVE_AXES.map((axis) => `  ・${axis}`),
    '- 回答が抽象的・一般論なら具体例を求め、盛りすぎ・嘘っぽさを感じたら現実性（数字・事実・再現性）をやんわり確認する。',
    '- 文脈に合えば、STAR（状況・課題・行動・結果）・数字・Before/After・判断理由・学び・再現性まで自然に引き出す（ただし一度に複数を問い詰めず、尋問にしない）。',
    '- 既に聞いた論点・聞き方は繰り返さない。Yes/Noで終わる質問・答えにくい質問・説教めいた質問は避ける。',
    '- 目的は「多く質問すること」ではなく、ES・面接・マッチングで再利用できる具体的な情報を引き出すこと。',
    '',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '{ "reaction": string, "question": string }',
  ].join('\n');
}

// 最終評価 system prompt（JSON 出力スキーマを明示）。面接の種類に応じて重視点を足す。
export function buildFinalFeedbackInstruction(
  interviewType?: CareerInterviewType,
): string {
  const config = getInterviewModeConfig(interviewType);
  return [
    '# 最終フィードバック（出力形式・厳守）',
    `これまでの面接（${config.label}）のやり取り全体をもとに、新卒就活の観点で最終フィードバックを作成してください。`,
    '評価は「優しいが甘すぎない」面接官として、STAR（状況・課題・行動・結果）・結論ファースト・成果の具体性・強みの再現性・志望動機との一貫性を見て行ってください。',
    `この面接の種類で特に重視する観点: ${config.feedbackEmphasis}`,
    config.pressure
      ? '圧迫面接の評価でも、指摘は厳しくてよいが、フィードバック自体は学生が次に改善できるよう建設的にすること（人格否定は禁止）。'
      : '指摘は率直にしつつ、学生が次に改善できるよう建設的にすること。',
    '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
    '各配列は2〜4個入れ、空配列にしない。実際の回答内容に即した具体的な指摘にし、テンプレ文を避ける。',
    '事実確認が必要な企業・業界情報は断定しない。companyFit は志望業界・職種・就活軸（あれば志望企業）との相性・接続を、回答内容に即して2〜4文で述べる。',
    '',
    '{',
    '  "overallComment": string,      // 全体評価の総括（数文）',
    '  "strengths": string[],         // 良かった点・強み',
    '  "improvements": string[],      // 改善点',
    '  "sampleAnswers": string[],     // より良い回答の例（具体的に）',
    '  "deepDiveTopics": string[],    // さらに深掘りされそうな論点',
    '  "nextActions": string[],       // 本番までに次にやるべきこと',
    '  "companyFit": string           // 志望業界・職種・就活軸との相性・接続についての所見',
    '}',
  ].join('\n');
}

// 最終評価 user プロンプト。
export function buildFinalUserPrompt(turns: CareerInterviewTurn[]): string {
  return [
    '面接のやり取り:',
    buildTranscript(turns),
    '',
    '上記をもとに、最終フィードバック JSON を出力してください。',
  ].join('\n');
}

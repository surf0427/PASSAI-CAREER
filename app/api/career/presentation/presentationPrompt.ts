// PASSAI 就活版 — プレゼン対策AI 共通プロンプト組み立て（theme / evaluate / qa 3 route 共有）。
//
// 受験版プレゼン機能の「テーマ→文字起こし→AI評価→発表後Q&A」思想を踏襲しつつ、
// 評価軸・役割・表現を新卒就活／ビジネス文脈へ全面的に差し替える。
//   - 大学受験・AO/推薦・志望校評価軸・「合格可能性」表現は一切持ち込まない。
//   - プロンプト土台は就活版共通基盤（@/lib/careerAi）からのみ組み立てる。
// 本ファイルは route ではない（共有モジュール）。

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
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import type {
  CareerPresentationType,
  CareerPresentationQaTurn,
} from '@/types/careerPresentation';
import { getPresentationModeConfig } from '@/app/career/presentation/presentationModes';

const FEATURE_KEY = 'career-presentation' as const;

export const CAREER_PRESENTATION_MODEL = 'claude-sonnet-4-6';

// 評価軸（就活・ビジネス文脈）。key は安定識別子、label は表示名。
// AI には全軸を 0〜100 で採点させ、UI でこの並びで表示する。
export const CAREER_PRESENTATION_AXES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'conclusionFirst', label: '結論ファースト', hint: '最初に結論・主張が提示されているか' },
  { key: 'logic', label: '論理構成', hint: '主張→根拠→具体の順序が筋道立っているか' },
  { key: 'concreteness', label: '根拠の具体性', hint: '数字・役割・行動・成果など具体に裏づけられているか' },
  { key: 'businessUnderstanding', label: '企業・業界・職種理解', hint: '志望先や仕事への理解の解像度' },
  { key: 'consistency', label: '自己PR/ガクチカ/志望動機との一貫性', hint: '他の就活材料と矛盾しないか' },
  { key: 'reproducibility', label: '入社後の再現性・ビジネス視点', hint: '仕事で再現できるか、ビジネスとして妥当か' },
  { key: 'delivery', label: '伝わりやすさ・話し方', hint: '聞き手に分かりやすい構成・言葉か' },
  { key: 'timeManagement', label: '時間配分', hint: '制限時間に対して過不足ないか' },
];

// 面接官・採用担当としての評価者人格（全種類共通の土台）。
function buildEvaluatorPersona(presentationType: CareerPresentationType | undefined): string {
  const config = getPresentationModeConfig(presentationType);
  return [
    'あなたは新卒採用の選考でプレゼンを評価する、企業の採用担当（人事・現場社員・役員クラス）です。',
    '大学受験（総合型選抜・学校推薦型選抜・一般入試）の文脈や、大学の評価軸・「合格可能性」という表現は一切使いません。',
    '評価は新卒就活・ビジネスの観点で行います。',
    '',
    `【今回のプレゼン】${config.label}`,
    config.guidance,
    '',
    '【評価者としての姿勢】',
    '- 「優しいが甘すぎない」。良い点は具体的に認め、課題は率直に、しかし建設的に伝える。',
    '- 抽象的な発表には具体例・数字・役割・成果を求める。盛りすぎ・嘘っぽい内容には現実性を確認する。',
    '- 採用担当として「この人を採用したい理由」が伝わるか、話の順番・結論・根拠・再現性を重視する。',
    '- ケース課題ではビジネス妥当性・実行可能性・顧客視点を見る。',
    '- 人格否定・侮辱・脅しは禁止（指摘は発表内容にのみ向ける）。不安を煽りすぎず、次に何を直せばよいかを明確にする。',
    '- 事実確認が必要な企業・業界情報は断定しない。',
  ].join('\n');
}

function renderSelfAnalysis(result: CareerSelfAnalysisResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
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
  pushList('ガクチカ候補', result.gakuchikaIdeas);
  pushList('自己PR候補', result.selfPrIdeas);
  return lines.join('\n');
}

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

function renderInterview(result: CareerInterviewFinalResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  if (result.overallComment?.trim()) lines.push(`- 面接の総評: ${result.overallComment.trim()}`);
  if (result.strengths?.length) lines.push(`- 面接での良かった点: ${result.strengths.join('、')}`);
  if (result.improvements?.length) lines.push(`- 面接での改善点: ${result.improvements.join('、')}`);
  return lines.join('\n');
}

function renderMatching(result: CareerMatchEngineResult | null | undefined): string {
  if (!result) return '';
  const lines: string[] = [];
  if (result.careerType?.trim()) lines.push(`- 適性タイプ: ${result.careerType.trim()}`);
  if (result.recommendedIndustries?.length)
    lines.push(`- 相性の良い業界: ${result.recommendedIndustries.slice(0, 5).join('、')}`);
  if (result.recommendedJobs?.length)
    lines.push(`- 相性の良い職種: ${result.recommendedJobs.slice(0, 5).join('、')}`);
  return lines.join('\n');
}

function renderConsultationInsights(insights: string[] | null | undefined): string {
  if (!insights || insights.length === 0) return '';
  return insights
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .slice(0, 5)
    .map((s) => `- ${s}`)
    .join('\n');
}

export type CareerPresentationContextInput = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  selfAnalysis?: CareerSelfAnalysisResult | null;
  es?: CareerEsResult | null;
  interview?: CareerInterviewFinalResult | null;
  matching?: CareerMatchEngineResult | null;
  consultationInsights?: string[] | null;
  presentationType?: CareerPresentationType;
  userInput?: string;
};

// プレゼンAIの土台 system prompt を組む。
export function buildPresentationBaseSystem(input: CareerPresentationContextInput): string {
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile: input.profile ?? null,
    activity: input.activity ?? null,
    values: input.values ?? null,
    userInput: input.userInput ?? '',
  });

  const selfAnalysisBlock = renderSelfAnalysis(input.selfAnalysis);
  const esBlock = renderEs(input.es);
  const interviewBlock = renderInterview(input.interview);
  const matchingBlock = renderMatching(input.matching);
  const consultationBlock = renderConsultationInsights(input.consultationInsights);

  return [
    buildEvaluatorPersona(input.presentationType),
    buildCareerSystemPrompt(context),
    buildCareerFeatureInstruction(FEATURE_KEY),
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    esBlock ? `# 直近の ES ドラフト\n${esBlock}` : '',
    interviewBlock ? `# 直近のAI面接フィードバック（参考）\n${interviewBlock}` : '',
    matchingBlock ? `# 就活マッチング結果（参考・断定しない）\n${matchingBlock}` : '',
    consultationBlock ? `# 相談AIでの最近の気づき（参考程度）\n${consultationBlock}` : '',
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}

// AI即興テーマ生成の user プロンプト。
export function buildThemeUserPrompt(presentationType?: CareerPresentationType): string {
  const config = getPresentationModeConfig(presentationType);
  return [
    `新卒就活の「${config.label}」の練習用に、本番でありそうなプレゼンのテーマ（お題）を1つだけ提案してください。`,
    `テーマの狙い: ${config.themeFocus}`,
    '学生のプロフィール・活動・就活軸に自然に接続でき、数分で発表できる粒度にしてください。',
    '出力はテーマ文そのものだけ（前置き・説明・記号・引用符・コードブロックは付けない）。',
  ].join('\n');
}

// 評価対象（発表内容）を整形した user プロンプト。
export function buildEvaluateUserPrompt(params: {
  theme: string;
  timeLimitSec: number;
  durationSec: number;
  transcript: string;
}): string {
  const { theme, timeLimitSec, durationSec, transcript } = params;
  const fmt = (sec: number) => (sec > 0 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : '未設定');
  return [
    '# 評価対象のプレゼン',
    `テーマ: ${theme || '（未入力）'}`,
    `制限時間: ${fmt(timeLimitSec)} / 実際の発表時間: ${fmt(durationSec)}`,
    '',
    '発表の文字起こし（または発表原稿）:',
    transcript || '（発表内容が空です）',
    '',
    '上記の発表を評価し、最終レポート JSON を出力してください。',
    '時間配分（timeManagement）は、制限時間と実際の発表時間の差をもとに判定してください。',
  ].join('\n');
}

// 評価レポートの出力スキーマ・採点基準（種類別の重視点を足す）。
export function buildEvaluateInstruction(presentationType?: CareerPresentationType): string {
  const config = getPresentationModeConfig(presentationType);
  const axisList = CAREER_PRESENTATION_AXES.map(
    (a) => `    { "key": "${a.key}", "label": "${a.label}", "score": 0〜100の整数, "comment": "${a.hint}に関する具体的な所見" }`,
  ).join(',\n');
  return [
    '# 最終レポート（出力形式・厳守）',
    'これまでの発表内容をもとに、新卒就活・ビジネスの観点で最終評価レポートを作成してください。',
    `この種類で特に重視する観点: ${config.evaluationEmphasis}`,
    '評価軸（axes）は以下の8軸すべてを、それぞれ 0〜100 の整数で採点し、key/label は指定どおりにしてください。',
    'totalScore は8軸を踏まえた総合点（0〜100の整数）。rank は totalScore に応じて S(90+)/A(80-89)/B(65-79)/C(50-64)/D(0-49) とする。',
    'improvedStructure は「改善版の構成例（話す順番のアウトライン）」であり、発表の完成原稿を代筆してはいけません（箇条書きの構成のみ）。',
    'passLikelihood は選考通過可能性についての所見を、断定せず根拠とともに2〜4文で述べる（「合格可能性」という受験表現は使わない）。',
    'companyFit は志望業界・職種・就活軸（あれば志望企業）との相性・接続を2〜4文で述べる。',
    'interviewerConcerns は採用担当・面接官に突っ込まれそうな点を2〜4個挙げる。',
    '各配列は2〜4個入れ、空配列にしない。発表内容に即した具体的な指摘にし、テンプレ文を避ける。事実確認が必要な企業情報は断定しない。',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '',
    '{',
    '  "totalScore": 0〜100の整数,',
    '  "rank": "S" | "A" | "B" | "C" | "D",',
    '  "overallComment": string,',
    '  "axes": [',
    axisList,
    '  ],',
    '  "goodPoints": string[],',
    '  "improvements": string[],',
    '  "priorityImprovements": string[],',
    '  "nextPractice": string[],',
    '  "expectedQuestions": string[],',
    '  "improvedStructure": string[],',
    '  "passLikelihood": string,',
    '  "companyFit": string,',
    '  "interviewerConcerns": string[]',
    '}',
  ].join('\n');
}

// 発表後Q&A（ターン制）の transcript 整形。
function buildQaTranscript(turns: CareerPresentationQaTurn[]): string {
  return turns
    .map((t) => (t.role === 'question' ? `面接官: ${t.content}` : `学生: ${t.content}`))
    .join('\n');
}

export function countQaAnswers(turns: CareerPresentationQaTurn[]): number {
  return turns.filter((t) => t.role === 'answer').length;
}

export const CAREER_PRESENTATION_QA_MAX_TURNS = 4;

// Q&A の質問生成 user プロンプト（kickoff / followup 兼用）。JSON {reaction, question} を要求。
export function buildQaUserPrompt(params: {
  theme: string;
  transcript: string;
  turns: CareerPresentationQaTurn[];
  presentationType?: CareerPresentationType;
}): string {
  const { theme, transcript, turns, presentationType } = params;
  const config = getPresentationModeConfig(presentationType);
  const isKickoff = turns.length === 0;
  const lines: string[] = [
    `これは「${config.label}」の発表後の質疑応答（想定: 採用担当からの質問）です。`,
    `発表テーマ: ${theme || '（未入力）'}`,
    '',
    '発表の文字起こし:',
    transcript || '（発表内容が空です）',
  ];
  if (!isKickoff) {
    lines.push('', 'これまでの質疑応答:', buildQaTranscript(turns));
  }
  lines.push(
    '',
    isKickoff
      ? '発表内容に対して、採用担当が実際に聞きそうな鋭い質問を1つだけ作ってください。最初の reaction は空文字で構いません。'
      : '学生の直前の回答に対して、まず一言リアクション（最大1文・甘すぎない）をし、それを踏まえて次の質問を1つだけ作ってください。',
    '抽象的な回答には具体例・数字・根拠を求める質問にし、発表の弱点や一貫性を確認する。Yes/Noで終わる質問・人格否定は避ける。',
    '出力は次の JSON オブジェクトのみ（前後に説明文やコードブロック記号を付けない）:',
    '{ "reaction": string, "question": string }',
  );
  return lines.join('\n');
}

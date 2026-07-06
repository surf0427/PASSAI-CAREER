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
  CareerPresentationConfig,
} from '@/types/careerPresentation';
import {
  getScenarioConfig,
  getFormatLabel,
  getSelectionTypeLabel,
  evalFocusLabels,
  resolveDifficulty,
  CAREER_PRESENTATION_DIFFICULTIES,
} from '@/app/career/presentation/presentationModes';

const FEATURE_KEY = 'career-presentation' as const;

export const CAREER_PRESENTATION_MODEL = 'claude-sonnet-4-6';

// 評価軸（就活・選考プレゼン文脈・お題ベース）。key は安定識別子、label は表示名。
// AI には全軸を 0〜100 で採点させ、UI でこの並びで表示する。
// 旧履歴の axes は各要素が自前の label を保持するため、ここを変えても既存表示は壊れない。
export const CAREER_PRESENTATION_AXES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'structure', label: '構成の分かりやすさ', hint: '話の順番・骨子が整理され、聞き手が追いやすいか' },
  { key: 'clarity', label: '主張の明確さ・結論ファースト', hint: '最初に結論・主張が明確に提示されているか' },
  { key: 'concreteness', label: '根拠の具体性', hint: '数字・役割・行動・成果など具体に裏づけられているか' },
  { key: 'logic', label: '論理の一貫性', hint: '主張→根拠→具体の筋が通り、矛盾がないか' },
  { key: 'persuasion', label: '説得力・聞き手意識', hint: '聞き手に響く説得力があり、相手目線で語れているか' },
  { key: 'delivery', label: '話し方・伝わりやすさ', hint: '言葉選び・テンポ・分かりやすい表現になっているか' },
  { key: 'timeManagement', label: '発表時間への収まり', hint: '発表時間に対して情報量が過不足ないか' },
  { key: 'connection', label: 'お題・企業・職種との接続／独自性', hint: 'お題や志望先・職種に接続し、自分ならではの視点があるか' },
];

// お題ベースプレゼンの評価コンテキスト（persona / prompt が共有）。
export type CareerPresentationPromptContext = {
  theme?: string;
  config?: CareerPresentationConfig | null;
  // 後方互換: 旧 presentationType（新規フローでは未使用でも良い）。
  presentationType?: CareerPresentationType;
};

// お題・想定シーン・企業/業界/職種・発表形式・評価観点・補足メモを条件ブロックに整形する。
function buildConditionLines(ctx: CareerPresentationPromptContext): string[] {
  const cfg = ctx.config ?? undefined;
  const scenarioCfg = getScenarioConfig(cfg?.scenario);
  const lines: string[] = [];
  lines.push(`【お題】${(ctx.theme ?? '').trim() || '（未入力）'}`);
  lines.push(`【想定シーン】${scenarioCfg.label}`);
  lines.push(scenarioCfg.guidance);

  const conds: string[] = [];
  if (cfg?.companyName?.trim()) conds.push(`企業名: ${cfg.companyName.trim()}`);
  if (cfg?.industry?.trim()) conds.push(`業界: ${cfg.industry.trim()}`);
  if (cfg?.jobType?.trim()) conds.push(`職種: ${cfg.jobType.trim()}`);
  const selectionLabel = getSelectionTypeLabel(cfg?.selectionType);
  if (selectionLabel) conds.push(`選考種別: ${selectionLabel}`);
  const formatLabel = getFormatLabel(cfg?.format);
  if (formatLabel) conds.push(`発表形式: ${formatLabel}`);
  if (conds.length > 0) {
    lines.push('', '【発表条件】' + conds.join(' / '));
  }

  if (cfg?.companyMemo?.trim()) {
    lines.push(
      `【企業について分かっていること（ユーザー提供）】${cfg.companyMemo.trim()}`,
      '※企業情報はこのメモを最優先の根拠にする。メモに無い事業内容・課題を断定・捏造しない。',
    );
  }
  if (cfg?.focusPoint?.trim()) {
    lines.push(`【特に練習したいこと】${cfg.focusPoint.trim()}`);
  }

  const focus = evalFocusLabels(cfg?.evaluationFocus);
  if (focus.length > 0) {
    lines.push(`【特に評価してほしい観点】${focus.join('・')}（この観点を重点的に見る）`);
  }
  if (cfg?.note?.trim()) {
    lines.push(`【補足メモ】${cfg.note.trim()}`);
  }
  return lines;
}

// このシーンで特に重視する観点（instruction 用）。
function scenarioEmphasis(ctx: CareerPresentationPromptContext): string {
  return getScenarioConfig(ctx.config?.scenario).evaluationEmphasis;
}

// 面接官・採用担当としての評価者人格（お題ベース・全シーン共通の土台）。
function buildEvaluatorPersona(ctx: CareerPresentationPromptContext): string {
  return [
    'あなたは新卒採用の選考でプレゼンを評価する、企業の採用担当（人事・現場社員・役員クラス）です。',
    'ユーザーが設定した「お題」に対する就活・選考プレゼンを評価します。',
    '大学受験（総合型選抜・学校推薦型選抜・一般入試）の文脈や、大学の評価軸・「合格可能性」という表現は一切使いません。',
    '評価は新卒就活・ビジネスの観点で行います。',
    '',
    ...buildConditionLines(ctx),
    '',
    '【評価者としての姿勢】',
    '- 「優しいが甘すぎない」。良い点は具体的に認め、課題は率直に、しかし建設的に伝える。',
    '- 抽象的な発表には具体例・数字・役割・成果を求める。盛りすぎ・嘘っぽい内容には現実性を確認する。',
    '- お題に対して「何を主張し、どんな根拠で、どう伝えたか」を軸に、結論・論理・具体性・説得力・聞き手意識・時間配分を見る。',
    '- ケース課題・企業課題提案ではビジネス妥当性・実行可能性・顧客視点・リスク認識を見る。',
    '- 人格否定・侮辱・脅しは禁止（指摘は発表内容にのみ向ける）。不安を煽りすぎず、次に何を直せばよいかを明確にする。',
    '- 事実確認が必要な企業・業界情報は断定しない。企業名だけを根拠に具体的な事業内容・課題を捏造しない（不足時は一般的な業界課題・仮説として扱う）。',
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
  // お題ベースプレゼンの条件（想定シーン・企業名・観点など）。
  config?: CareerPresentationConfig | null;
  // お題（発表テーマ）。
  theme?: string;
  // 後方互換のため残す（新規フローでは未使用）。
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

  const ctx: CareerPresentationPromptContext = {
    theme: input.theme,
    config: input.config ?? undefined,
    presentationType: input.presentationType,
  };

  return [
    buildEvaluatorPersona(ctx),
    buildCareerSystemPrompt(context),
    buildCareerFeatureInstruction(FEATURE_KEY),
    // 他機能のデータは「参考程度」に留める（主役はお題への発表）。
    selfAnalysisBlock ? `# 参考: 直近の自己分析結果（発表の主役ではない）\n${selfAnalysisBlock}` : '',
    esBlock ? `# 参考: 直近の ES ドラフト（発表の主役ではない）\n${esBlock}` : '',
    interviewBlock ? `# 参考: 直近のAI面接フィードバック\n${interviewBlock}` : '',
    matchingBlock ? `# 参考: 就活マッチング結果（断定しない）\n${matchingBlock}` : '',
    consultationBlock ? `# 参考: 相談AIでの最近の気づき\n${consultationBlock}` : '',
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}

// AIお題生成の user プロンプト（想定シーン・企業/業界/職種・発表時間・難易度・補足メモを考慮）。
export function buildThemeUserPrompt(params: {
  config?: CareerPresentationConfig | null;
  timeLimitSec?: number;
  difficulty?: unknown;
}): string {
  const cfg = params.config ?? undefined;
  const scenarioCfg = getScenarioConfig(cfg?.scenario);
  const difficulty = resolveDifficulty(params.difficulty);
  const diffCfg = CAREER_PRESENTATION_DIFFICULTIES.find((d) => d.key === difficulty);
  const timeLimitSec = typeof params.timeLimitSec === 'number' ? params.timeLimitSec : 0;
  const fmtTime = timeLimitSec > 0 ? `${Math.floor(timeLimitSec / 60)}分` : '指定なし';

  const selectionLabel = getSelectionTypeLabel(cfg?.selectionType);

  const conds: string[] = [];
  if (cfg?.companyName?.trim()) conds.push(`企業名: ${cfg.companyName.trim()}`);
  if (cfg?.industry?.trim()) conds.push(`業界: ${cfg.industry.trim()}`);
  if (cfg?.jobType?.trim()) conds.push(`職種: ${cfg.jobType.trim()}`);
  if (selectionLabel) conds.push(`選考種別: ${selectionLabel}`);
  if (cfg?.focusPoint?.trim()) conds.push(`特に練習したいこと: ${cfg.focusPoint.trim()}`);

  return [
    '新卒就活の選考プレゼン練習用に、本番でありそうな「お題（プレゼンテーマ）」を1つだけ提案してください。',
    `想定シーン: ${scenarioCfg.label} — ${scenarioCfg.themeFocus}`,
    `発表時間: ${fmtTime}（この時間で発表しきれる粒度にする）`,
    `難易度: ${diffCfg?.label ?? '標準'}（${diffCfg?.hint ?? ''}）`,
    conds.length > 0 ? `考慮する条件: ${conds.join(' / ')}` : '',
    cfg?.companyName?.trim()
      ? 'この企業を受ける想定のお題にする。ただし企業の事業内容・制度・課題を断定・捏造しない。'
      : '',
    cfg?.industry?.trim() && !cfg?.companyName?.trim()
      ? 'その業界で出やすいテーマに寄せる。特定企業の事実は出さない。'
      : '',
    cfg?.companyMemo?.trim()
      ? `企業情報は次のユーザー提供メモを最優先の根拠にする（メモに無い事実は断定しない）: ${cfg.companyMemo.trim()}`
      : '企業メモが無い場合は、一般的な業界課題・職種理解・選考文脈として扱う。',
    '出力はお題の文そのものだけ（前置き・説明・記号・引用符・コードブロックは付けない）。',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

// 評価対象（発表内容）を整形した user プロンプト（お題・条件を含む）。
export function buildEvaluateUserPrompt(params: {
  theme: string;
  timeLimitSec: number;
  durationSec: number;
  transcript: string;
  config?: CareerPresentationConfig | null;
}): string {
  const { theme, timeLimitSec, durationSec, transcript, config } = params;
  const fmt = (sec: number) => (sec > 0 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : '未設定');
  return [
    '# 評価対象のプレゼン',
    ...buildConditionLines({ theme, config }),
    '',
    `発表時間: 制限 ${fmt(timeLimitSec)} / 実測 ${fmt(durationSec)}`,
    '',
    '発表の文字起こし（または発表原稿）:',
    transcript || '（発表内容が空です）',
    '',
    'このお題に対する発表を評価し、最終レポート JSON を出力してください。',
    '時間配分（timeManagement）は、制限時間と実際の発表時間の差をもとに判定してください（制限時間が「未設定」の場合は情報量の過不足で判断する）。',
  ].join('\n');
}

// 評価レポートの出力スキーマ・採点基準（想定シーン別の重視点を足す）。
export function buildEvaluateInstruction(ctx: CareerPresentationPromptContext): string {
  const axisList = CAREER_PRESENTATION_AXES.map(
    (a) => `    { "key": "${a.key}", "label": "${a.label}", "score": 0〜100の整数, "comment": "${a.hint}に関する具体的な所見" }`,
  ).join(',\n');
  return [
    '# 最終レポート（出力形式・厳守）',
    'このお題に対する発表を、新卒就活・選考プレゼンの観点で評価し、最終レポートを作成してください。',
    `今回の想定シーンで特に重視する観点: ${scenarioEmphasis(ctx)}`,
    '評価軸（axes）は以下の8軸すべてを、それぞれ 0〜100 の整数で採点し、key/label は指定どおりにしてください。',
    'totalScore は8軸を踏まえた総合点（0〜100の整数）。rank は totalScore に応じて S(90+)/A(80-89)/B(65-79)/C(50-64)/D(0-49) とする。',
    'structureFeedback は構成（話す順番・骨子）への、persuasionFeedback は説得力への、deliveryFeedback は話し方・伝え方への、それぞれ2〜3文の個別フィードバック。',
    'improvedStructure は「改善版の構成例（話す順番のアウトライン）」であり、発表の完成原稿を代筆してはいけません（箇条書きの構成のみ）。',
    'passLikelihood は選考通過可能性についての所見を、断定せず根拠とともに2〜4文で述べる（「合格可能性」という受験表現は使わない）。',
    'companyFit は志望業界・職種（あれば志望企業）との相性・接続を2〜4文で述べる。企業条件が未設定なら一般的なビジネス視点で述べる。',
    'expectedQuestions と interviewerConcerns では、この発表に対して想定される追加質問・深掘り質問・突っ込まれそうな点を挙げる。',
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
    '  "structureFeedback": string,',
    '  "persuasionFeedback": string,',
    '  "deliveryFeedback": string,',
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
  config?: CareerPresentationConfig | null;
}): string {
  const { theme, transcript, turns, config } = params;
  const scenarioCfg = getScenarioConfig(config?.scenario);
  const isKickoff = turns.length === 0;
  const lines: string[] = [
    `これは「${scenarioCfg.label}」のプレゼン発表後の質疑応答（想定: 採用担当からの質問）です。`,
    `お題: ${theme || '（未入力）'}`,
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

// 自己分析まとめ生成 — prompt 構築 + 出力正規化の共有モジュール。
//
// 目的: 既存 route（legacy 同期経路）と job background attempt（Step2）で
//   **byte-identical** な system/user prompt と result 正規化を共有する。
//   ここに集約する前と生成挙動が変わらないことを最優先にする（内部 refactor）。
//
// DB / Supabase / job には依存しない純粋モジュール。

import {
  buildCareerAiContext,
  buildCareerFeatureInstruction,
} from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type {
  CareerSelfAnalysisResult,
  CareerSelfAnalysisTurn,
} from '@/types/careerSelfAnalysis';
import {
  buildCoverageInventory,
  formatCoverageForPrompt,
  formatPastSummariesForPrompt,
  type SelfAnalysisPastSummary,
} from '@/lib/careerSelfAnalysis/pastLogSummary';

// careerAi 側の機能キー（job の feature 'self_analysis' とは別レイヤ）。
export const CAREER_SELF_ANALYSIS_FEATURE_KEY = 'career-self-analysis' as const;

// v2 でフィールドが増えたため余裕を持たせる（途中切れ＝truncation を避ける）。
export const SELF_ANALYSIS_MAX_TOKENS = 4000;

// 期待する出力 JSON スキーマを明示する指示（system prompt へ追記）。
export const OUTPUT_FORMAT_INSTRUCTION = [
  '# 分析の観点（就活向け）',
  '与えられた「基本情報」「活動・経験」「就活軸」を総合し、次の観点を明確にしてください。',
  '- どんな業界・職種に向いているか（活動・強み・就活軸から根拠づける）',
  '- どんな企業文化・組織に合うか / どんな働き方が合うか',
  '- どんな環境だと力を発揮しやすいか / どんな環境は避けた方がよいか',
  '- ESで押し出すべき強み、面接で深掘りされやすい弱み',
  '- 就活軸との整合性（重視/回避したい条件と本人の特性が噛み合うか）',
  '- ガクチカ化できる経験、自己PR化できる経験',
  '一般論で埋めず、必ず本人の活動・経験・就活軸に紐づけて具体的に述べてください。',
  '- 活動整理・就活軸整理に複数の項目がある場合は、1つに偏らず複数を横断して分析する。',
  '- 今回の対話・入力で扱えた活動や価値観が限られている場合は断定しすぎず、「仮説」として述べる。',
  '',
  '# 出力形式（厳守）',
  '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
  '各フィールドは日本語で、活動・経験に即して具体的に記述してください。',
  // ── 出力量の予算（latency の実効レバー）───────────────────────────
  // 生成レイテンシはほぼ全量が出力トークン生成時間（実測 約50 tok/s・入力側は寄与ほぼ0）。
  // したがって「出力量を絞る指示」だけが実効的な短縮手段であり、同時に max_tokens=4000 への
  // 到達（stop_reason='max_tokens' → OUTPUT_TRUNCATED＝非 retryable な terminal 失敗）を防ぐ。
  // CAP（最大3個・1文60字）と FLOOR（材料が乏しくても仮説で埋める）を対で置く:
  // CAP だけだと薄いユーザーで空フィールドが増え、FLOOR だけだと出力量が膨らむ。
  '材料が乏しいフィールドも、入力から言える範囲で「仮説」として1〜2項目は必ず埋めてください。',
  '根拠が全く無い場合のみ空配列 [] / 空文字 "" とします（キーは必ず全て含める）。',
  '配列フィールドは最大3個（多く挙げるより、根拠の強い順に絞る）。',
  '各要素は1文・60字以内を目安にし、「なぜそう言えるか」の根拠を必ず1つ含めてください。',
  // nextActions は CAP を緩める。blind A/B 評価で、一律 60 字にすると actionability だけが
  // 有意に落ちた（実行手順が「何をするか」で終わり「どうやるか」が消えるため）。
  // ここだけ字数を倍にしても出力全体では +100 字程度＝latency 影響はほぼ無い。
  'ただし nextActions は実行可能性を優先し、「何を・どうやって」まで書いてください（各1〜2文・120字以内）。',
  'valueKeywords / strengthKeywords は単語または短い語句のみ（各最大5個・文にしない）。',
  '冗長な言い換え・前置き・一般論の反復を避け、情報密度を優先してください。',
  '同じ内容を複数のフィールドで言い換えて重複させないでください。',
  '',
  '{',
  '  "summary": string,            // 就活視点での自己分析の全体所感（2〜4文）',
  '  "strengths": string[],       // 強み（根拠となる経験に触れる）',
  '  "weaknesses": string[],      // 弱み・伸びしろ',
  '  "gakuchikaIdeas": string[],  // ガクチカ候補（学生時代に力を入れたこと）',
  '  "selfPrIdeas": string[],     // 自己PR候補',
  '  "esAngles": string[],        // ESで使える経験の切り口',
  '  "interviewQuestions": string[], // 面接で深掘りされそうな想定質問',
  '  "nextActions": string[],     // 次にやるべきこと。うち1つ以上は「次回の自己分析で深掘りすべき観点」（今回まだ十分に語られていない活動・価値観・弱み・ストレス要因など）にする',
  '  "careerDirection": string,   // キャリアの方向性・志望の核（1〜3文。志望動機の軸）',
  '  "recommendedIndustries": string[], // 向いている業界候補（根拠を短く）',
  '  "recommendedJobs": string[],       // 向いている職種候補（根拠を短く）',
  '  "suitableEnvironment": string[],   // 向いている働き方・職場環境・組織文化',
  '  "valueKeywords": string[],         // 価値観キーワード（短い語句）',
  '  "strengthKeywords": string[],      // 強みキーワード（短い語句）',
  '  "motivationSources": string[],     // モチベーションの源泉',
  '  "stressFactors": string[],         // ストレス要因・避けた方がよい環境',
  '  "companySelectionCriteria": string[], // 企業選びで重視すべき条件',
  '  "developmentPoints": string[]      // 今後伸ばすべき点',
  '}',
].join('\n');

// 複数回利用を前提にした分析方針。初回は広い仮説、2回目以降は具体化。
export const GENERATION_GUIDANCE = [
  '# 分析の進め方（複数回利用を前提に）',
  '自己分析は1回で完成させるものではなく、ユーザーが複数回使うことで少しずつ深まる設計です。',
  '- 初回（過去の自己分析が無い）場合は、活動・価値観を幅広く捉えた「広い仮説」として述べ、断定しすぎない。',
  '- 2回目以降（過去の自己分析がある）場合は、過去の結論を踏まえてさらに具体化し、',
  '  ES・面接で使えるエピソード化、志望業界・職種との接続、矛盾点・意思決定基準の精密化に踏み込む。',
  '- 今回まだ十分に確認できていない観点（未確認の活動・価値観・弱み・ストレス要因）は無理に断定せず、',
  '  nextActions に「次回の自己分析で深掘りすべきテーマ」として具体的に1つ以上含める。',
].join('\n');

/** 任意の値を string に丸める。 */
export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 任意の値を string[] に丸める（非配列・空要素を除去）。 */
export function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
}

/** 深掘り壁打ちの会話（任意）を正規化する。壊れた要素は捨てる。 */
export function normalizeConversation(value: unknown): CareerSelfAnalysisTurn[] {
  if (!Array.isArray(value)) return [];
  const out: CareerSelfAnalysisTurn[] = [];
  for (const t of value) {
    if (!t || typeof t !== 'object') continue;
    const role = (t as { role?: unknown }).role;
    const content = str((t as { content?: unknown }).content);
    if ((role === 'question' || role === 'answer') && content) {
      out.push({ role, content });
    }
  }
  return out;
}

/** 会話を system prompt 用の可読ブロックに整形する。空なら null。 */
export function renderConversation(turns: CareerSelfAnalysisTurn[]): string | null {
  if (turns.length === 0) return null;
  const lines = turns.map((t) =>
    t.role === 'question' ? `Q: ${t.content}` : `A: ${t.content}`,
  );
  return [
    '# 深掘り対話（本人との壁打ち）',
    '以下は本人との深掘り対話です。本人が自分の言葉で語った内容なので、',
    '自己分析の最優先の根拠として活用し、各フィールドに具体的に反映してください。',
    ...lines,
  ].join('\n');
}

/** AI 出力（パース済み unknown）を CareerSelfAnalysisResult 形状に正規化する。 */
export function normalizeResult(raw: unknown): CareerSelfAnalysisResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    summary: str(r.summary),
    strengths: strArray(r.strengths),
    weaknesses: strArray(r.weaknesses),
    gakuchikaIdeas: strArray(r.gakuchikaIdeas),
    selfPrIdeas: strArray(r.selfPrIdeas),
    esAngles: strArray(r.esAngles),
    interviewQuestions: strArray(r.interviewQuestions),
    nextActions: strArray(r.nextActions),
    careerDirection: str(r.careerDirection),
    recommendedIndustries: strArray(r.recommendedIndustries),
    recommendedJobs: strArray(r.recommendedJobs),
    suitableEnvironment: strArray(r.suitableEnvironment),
    valueKeywords: strArray(r.valueKeywords),
    strengthKeywords: strArray(r.strengthKeywords),
    motivationSources: strArray(r.motivationSources),
    stressFactors: strArray(r.stressFactors),
    companySelectionCriteria: strArray(r.companySelectionCriteria),
    developmentPoints: strArray(r.developmentPoints),
  };
}

/**
 * 空同然の出力を弾く schema validation。
 * 正規化後に summary も全配列も空なら「意味のある自己分析ではない」と判定する。
 */
export function hasMeaningfulResult(result: CareerSelfAnalysisResult): boolean {
  if (result.summary.trim() !== '') return true;
  const arrays: string[][] = [
    result.strengths, result.weaknesses, result.gakuchikaIdeas, result.selfPrIdeas,
    result.esAngles, result.interviewQuestions, result.nextActions,
    result.recommendedIndustries, result.recommendedJobs, result.suitableEnvironment,
    result.valueKeywords, result.strengthKeywords, result.motivationSources,
    result.stressFactors, result.companySelectionCriteria, result.developmentPoints,
  ];
  if (arrays.some((a) => a.length > 0)) return true;
  return result.careerDirection.trim() !== '';
}

/** まとめ生成の入力（legacy と job attempt で共有）。 */
export interface SelfAnalysisSummaryInput {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  userInput: string;
  conversation: CareerSelfAnalysisTurn[];
  pastSummaries: SelfAnalysisPastSummary[];
}

/** 少なくとも基本情報か活動があるか（材料の有無）。 */
export function hasUsableInput(
  profile: CareerProfileInput | null,
  activity: CareerActivityInput | null,
): boolean {
  const hasProfile = !!profile && Object.keys(profile).length > 0;
  const hasActivity = !!activity && Object.keys(activity).length > 0;
  return hasProfile || hasActivity;
}

/**
 * system / user メッセージを組み立てる（legacy route と byte-identical）。
 */
export function buildSelfAnalysisMessages(
  input: SelfAnalysisSummaryInput,
): { system: string; user: string } {
  const context = buildCareerAiContext({
    featureKey: CAREER_SELF_ANALYSIS_FEATURE_KEY,
    profile: input.profile,
    activity: input.activity,
    values: input.values,
    userInput: input.userInput,
  });
  const orchestrated = buildCareerContextForPurpose('self_analysis', context);

  const coverageBlock = formatCoverageForPrompt(
    buildCoverageInventory(input.activity, input.values),
  );
  const pastBlock = formatPastSummariesForPrompt(input.pastSummaries);
  const conversationBlock = renderConversation(input.conversation);

  const system = [
    orchestrated.systemPrompt,
    coverageBlock,
    conversationBlock,
    pastBlock,
    GENERATION_GUIDANCE,
    OUTPUT_FORMAT_INSTRUCTION,
  ]
    .filter((s): s is string => !!s)
    .join('\n\n');

  const user = [
    buildCareerFeatureInstruction(CAREER_SELF_ANALYSIS_FEATURE_KEY),
    '',
    '以上を踏まえ、指定の JSON 形式で自己分析の結果のみを出力してください。',
  ].join('\n');

  return { system, user };
}

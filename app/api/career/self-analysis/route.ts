// PASSAI 就活版 — 自己分析AI API（最小版）
//
// 役割: /career/self-analysis/run から呼ばれ、就活向けの自己分析を JSON で返すだけ。
//
// 重要（受験版からの分離方針）:
//   - 受験版 /api/summarize の「構成」は参考にするが、受験版依存は一切持ち込まない。
//   - 課金 / quota（ensurePlanQuota）・usage 記録（recordUsage / logAiUsage）・
//     DB / Supabase / Stripe には接続しない。本フェーズは「動く最小実装」に徹する。
//   - プロンプトは就活版共通基盤（@/lib/careerAi）からのみ組み立てる。
//   - 利用する共通ユーティリティは AI 呼び出し系の純粋なものに限定する:
//       @/lib/ai        … Anthropic クライアント singleton + extractJson（DB 非依存）
//       @/lib/aiTimeout … AbortSignal timeout helper（純粋・DB 非依存）

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
import type {
  CareerSelfAnalysisResult,
  CareerSelfAnalysisTurn,
} from '@/types/careerSelfAnalysis';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';

// 本ルートの機能キーは自己分析に固定する。
const FEATURE_KEY = 'career-self-analysis' as const;

// 受験版各ルートと同系の Sonnet を使用（課金/usage には接続しない）。
const MODEL = 'claude-sonnet-4-6';

// Vercel 実行時間上限。AI timeout（60s）+ 余裕。runtime は既定 nodejs。
export const maxDuration = 80;

// 期待する出力 JSON スキーマを明示する指示。system prompt（共通基盤）に追記する。
// v2: ES・面接・マッチング・企業分析が再利用しやすい構造化フィールドを追加。
const OUTPUT_FORMAT_INSTRUCTION = [
  '# 分析の観点（就活向け）',
  '与えられた「基本情報」「活動・経験」「就活軸」を総合し、次の観点を明確にしてください。',
  '- どんな業界・職種に向いているか（活動・強み・就活軸から根拠づける）',
  '- どんな企業文化・組織に合うか / どんな働き方が合うか',
  '- どんな環境だと力を発揮しやすいか / どんな環境は避けた方がよいか',
  '- ESで押し出すべき強み、面接で深掘りされやすい弱み',
  '- 就活軸との整合性（重視/回避したい条件と本人の特性が噛み合うか）',
  '- ガクチカ化できる経験、自己PR化できる経験',
  '一般論で埋めず、必ず本人の活動・経験・就活軸に紐づけて具体的に述べてください。',
  '',
  '# 出力形式（厳守）',
  '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
  '各フィールドは日本語で、活動・経験に即して具体的に記述してください。',
  '該当が無いフィールドは空配列 [] または空文字 "" にしてください（キーは必ず全て含める）。',
  '配列フィールドは原則2〜5個。可能なら各要素に「なぜそう言えるか」の根拠を短く添えてください。',
  '',
  '{',
  '  "summary": string,            // 就活視点での自己分析の全体所感（2〜4文）',
  '  "strengths": string[],       // 強み（根拠となる経験に触れる）',
  '  "weaknesses": string[],      // 弱み・伸びしろ',
  '  "gakuchikaIdeas": string[],  // ガクチカ候補（学生時代に力を入れたこと）',
  '  "selfPrIdeas": string[],     // 自己PR候補',
  '  "esAngles": string[],        // ESで使える経験の切り口',
  '  "interviewQuestions": string[], // 面接で深掘りされそうな想定質問',
  '  "nextActions": string[],     // 次にやるべきこと',
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

// 任意の値を string に丸める。
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 任意の値を string[] に丸める（非配列・空要素を除去）。
function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
}

// 深掘り壁打ちの会話（任意）を正規化する。壊れた要素は捨てる。
function normalizeConversation(value: unknown): CareerSelfAnalysisTurn[] {
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

// 会話を system prompt 用の可読ブロックに整形する。空なら null（ブロック自体を出さない）。
// 未入力ユーザー（単発生成）では prompt が従来と完全一致し、AI 挙動に影響しない。
function renderConversation(turns: CareerSelfAnalysisTurn[]): string | null {
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

// AI 出力（パース済み unknown）を CareerSelfAnalysisResult 形状に正規化する。
// キー過不足・型ゆれに強くするための防御。
function normalizeResult(raw: unknown): CareerSelfAnalysisResult {
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
    // v2 構造化フィールド（キー欠落・型ゆれに強い防御は既存と同方針）。
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

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'リクエストボディが不正です。' }, { status: 400 });
  }

  const b = (body && typeof body === 'object' ? body : {}) as {
    profile?: CareerProfileInput | null;
    activity?: CareerActivityInput | null;
    values?: CareerValuesInput | null;
    conversation?: unknown;
    userInput?: string;
  };

  const profile = b.profile ?? null;
  const activity = b.activity ?? null;
  const values = b.values ?? null;
  const conversation = normalizeConversation(b.conversation);
  const userInput = typeof b.userInput === 'string' ? b.userInput : '';

  // プロフィールも活動も無ければ自己分析の材料が無いので弾く。
  const hasProfile = !!profile && Object.keys(profile).length > 0;
  const hasActivity = !!activity && Object.keys(activity).length > 0;
  if (!hasProfile && !hasActivity) {
    return Response.json(
      { error: '基本情報または活動整理のいずれかを入力してください。' },
      { status: 400 },
    );
  }

  // 就活版共通基盤でコンテキスト → system prompt を組み立てる。
  const context = buildCareerAiContext({
    featureKey: FEATURE_KEY,
    profile,
    activity,
    values,
    userInput,
  });

  // 深掘り対話があれば、共通基盤プロンプトと出力形式の間に挟む（未入力なら従来と完全一致）。
  const conversationBlock = renderConversation(conversation);
  const systemPrompt = [
    buildCareerSystemPrompt(context),
    conversationBlock,
    OUTPUT_FORMAT_INSTRUCTION,
  ]
    .filter((s): s is string => !!s)
    .join('\n\n');

  // user メッセージは実行トリガ。機能別指示を再掲して JSON 出力を促す。
  const userMessage = [
    buildCareerFeatureInstruction(FEATURE_KEY),
    '',
    '以上を踏まえ、指定の JSON 形式で自己分析の結果のみを出力してください。',
  ].join('\n');

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する（受験版 summarize と同方針）。
    let result: CareerSelfAnalysisResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: MODEL,
          // v2 でフィールドが増えたため余裕を持たせる（途中切れ＝502 を避ける）。
          max_tokens: 4000,
          temperature: attempt === 2 ? 0 : 0.5,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: createTimeoutSignal() },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      // max_tokens 到達の途中切れは長さ起因なので retry せず明示エラーで返す。
      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_SELF_ANALYSIS_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        result = normalizeResult(JSON.parse(extractJson(raw)));
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_SELF_ANALYSIS_PARSE_FAILED', detail: 'AI応答をJSONとして解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    if (!result) {
      return Response.json(
        { error: 'AI_SELF_ANALYSIS_PARSE_FAILED', detail: 'AI応答をJSONとして解釈できませんでした。' },
        { status: 502 },
      );
    }

    return Response.json({ result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career self-analysis API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '自己分析の生成に失敗しました。' },
      { status: 500 },
    );
  }
}

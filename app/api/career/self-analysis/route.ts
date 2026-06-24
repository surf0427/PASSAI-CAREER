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
import type { CareerProfileInput, CareerActivityInput } from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';

// 本ルートの機能キーは自己分析に固定する。
const FEATURE_KEY = 'career-self-analysis' as const;

// 受験版各ルートと同系の Sonnet を使用（課金/usage には接続しない）。
const MODEL = 'claude-sonnet-4-6';

// Vercel 実行時間上限。AI timeout（60s）+ 余裕。runtime は既定 nodejs。
export const maxDuration = 80;

// 期待する出力 JSON スキーマを明示する指示。system prompt（共通基盤）に追記する。
const OUTPUT_FORMAT_INSTRUCTION = [
  '# 出力形式（厳守）',
  '上記のプロフィールと活動・経験をもとに、新卒就活向けの自己分析を行ってください。',
  '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
  '各フィールドは日本語で、活動・経験に即して具体的に記述してください。',
  '該当が無いフィールドは空配列 [] または空文字 "" にしてください（キーは省略しない）。',
  '',
  '{',
  '  "summary": string,            // 就活視点での自己分析の全体所感（2〜4文）',
  '  "strengths": string[],       // 強み（根拠となる経験に触れる）',
  '  "weaknesses": string[],      // 弱み・伸びしろ',
  '  "gakuchikaIdeas": string[],  // ガクチカ候補（学生時代に力を入れたこと）',
  '  "selfPrIdeas": string[],     // 自己PR候補',
  '  "esAngles": string[],        // ESで使える経験の切り口',
  '  "interviewQuestions": string[], // 面接で深掘りされそうな想定質問',
  '  "nextActions": string[]      // 次にやるべきこと',
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
    userInput?: string;
  };

  const profile = b.profile ?? null;
  const activity = b.activity ?? null;
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
    userInput,
  });

  const systemPrompt = `${buildCareerSystemPrompt(context)}\n\n${OUTPUT_FORMAT_INSTRUCTION}`;

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
          max_tokens: 2000,
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

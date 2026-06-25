// PASSAI 就活版 — ES（エントリーシート）作成AI API（最小版）
//
// 役割: /career/es/run から呼ばれ、就活向けの ES ドラフトを JSON で返すだけ。
//
// 重要（受験版からの分離方針）:
//   - 受験版 app/statement / /api/statement-review の「構成」は参考にするが、受験版依存は
//     一切持ち込まない（AO・推薦・大学受験の文脈・プロンプト・型を使わない）。
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
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';

// 本ルートの機能キーは ES に固定する。
const FEATURE_KEY = 'career-es' as const;

// 受験版各ルートと同系の Sonnet を使用（課金/usage には接続しない）。
const MODEL = 'claude-sonnet-4-6';

// Vercel 実行時間上限。AI timeout（60s）+ 余裕。runtime は既定 nodejs。
export const maxDuration = 80;

// 期待する出力 JSON スキーマを明示する指示。system prompt（共通基盤）に追記する。
const OUTPUT_FORMAT_INSTRUCTION = [
  '# 出力形式（厳守）',
  '上記のプロフィール・活動・自己分析をもとに、新卒就活向けの ES ドラフトを作成してください。',
  '出力は次の JSON オブジェクトのみとし、前後に説明文やコードブロック記号を付けないでください。',
  '各フィールドは日本語で、本人の経験に即して具体的に記述してください。',
  '盛りすぎ・テンプレ化を避け、本人が自分の言葉で語れる自然な表現にしてください。',
  '該当が無いフィールドは空配列 [] または空文字 "" にしてください（キーは省略しない）。',
  '',
  '{',
  '  "gakuchika": string,         // ガクチカ本文ドラフト（結論→具体→学び）',
  '  "selfPr": string,            // 自己PR本文ドラフト',
  '  "motivation": string,        // 志望動機本文ドラフト',
  '  "headline": string,          // キャッチコピー（自分を一言で表す見出し）',
  '  "appealPoints": string[],    // 企業へのアピールポイント',
  '  "interviewQuestions": string[], // 面接で深掘りされそうな想定質問',
  '  "improvements": string[]     // さらに良くするための改善点',
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

// AI 出力（パース済み unknown）を CareerEsResult 形状に正規化する。
function normalizeResult(raw: unknown): CareerEsResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    gakuchika: str(r.gakuchika),
    selfPr: str(r.selfPr),
    motivation: str(r.motivation),
    headline: str(r.headline),
    appealPoints: strArray(r.appealPoints),
    interviewQuestions: strArray(r.interviewQuestions),
    improvements: strArray(r.improvements),
  };
}

// 直近の自己分析結果を system prompt 用の可読テキストに整形する。
// 未提供（自己分析未実行）なら空文字を返し、prompt 側で section を出さない。
function renderSelfAnalysis(result: CareerSelfAnalysisResult | null): string {
  if (!result) return '';
  const lines: string[] = [];
  // v2 フィールドは旧ログで undefined になり得るため、空・非文字列は無視して防御する。
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim() !== '') lines.push(`- ${label}: ${value.trim()}`);
  };
  const pushList = (label: string, values: string[] | undefined) => {
    if (values && values.length > 0) lines.push(`- ${label}: ${values.join('、')}`);
  };
  push('全体所感', result.summary);
  push('キャリアの方向性', result.careerDirection);
  pushList('強み', result.strengths);
  pushList('強みキーワード', result.strengthKeywords);
  pushList('価値観キーワード', result.valueKeywords);
  pushList('弱み', result.weaknesses);
  pushList('ガクチカ候補', result.gakuchikaIdeas);
  pushList('自己PR候補', result.selfPrIdeas);
  pushList('ESで使える切り口', result.esAngles);
  return lines.length > 0 ? lines.join('\n') : '';
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
    selfAnalysis?: CareerSelfAnalysisResult | null;
    userInput?: string;
  };

  const profile = b.profile ?? null;
  const activity = b.activity ?? null;
  const values = b.values ?? null;
  const selfAnalysis = b.selfAnalysis ?? null;
  const userInput = typeof b.userInput === 'string' ? b.userInput : '';

  // 材料が何も無ければ ES を作れないので弾く。
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

  // base（共通基盤）に「直近の自己分析」「出力形式」を追記する。
  const selfAnalysisBlock = renderSelfAnalysis(selfAnalysis);
  const systemPrompt = [
    buildCareerSystemPrompt(context),
    selfAnalysisBlock ? `# 直近の自己分析結果\n${selfAnalysisBlock}` : '',
    OUTPUT_FORMAT_INSTRUCTION,
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  // user メッセージは実行トリガ。機能別指示を再掲して JSON 出力を促す。
  const userMessage = [
    buildCareerFeatureInstruction(FEATURE_KEY),
    '',
    '以上を踏まえ、指定の JSON 形式で ES ドラフトのみを出力してください。',
  ].join('\n');

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する（受験版各ルートと同方針）。
    let result: CareerEsResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: 2500,
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
          { error: 'AI_ES_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        result = normalizeResult(JSON.parse(extractJson(raw)));
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_ES_PARSE_FAILED', detail: 'AI応答をJSONとして解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    if (!result) {
      return Response.json(
        { error: 'AI_ES_PARSE_FAILED', detail: 'AI応答をJSONとして解釈できませんでした。' },
        { status: 502 },
      );
    }

    return Response.json({ result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career ES API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: 'ESの生成に失敗しました。' },
      { status: 500 },
    );
  }
}

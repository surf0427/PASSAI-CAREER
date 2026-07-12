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

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerEsResult, CareerEsSelectionType } from '@/types/careerEs';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import { normalizeCompanyResearchSnapshot } from '@/lib/careerCompanyResearch/context';
import { buildEsGenerationPrompt } from './esPrompt';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';

// 受験版各ルートと同系の Sonnet を使用（課金/usage には接続しない）。
const MODEL = 'claude-sonnet-4-6';

// Vercel 実行時間上限。AI timeout（60s）+ 余裕。runtime は既定 nodejs。
export const maxDuration = 80;

// 任意の値を string に丸める。
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 任意の値を string[] に丸める（非配列・空要素を除去）。
function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
}

// 空の 7 フィールド土台。設問モードでは answer 以外を空で埋める。
function emptyResult(): CareerEsResult {
  return {
    gakuchika: '',
    selfPr: '',
    motivation: '',
    headline: '',
    appealPoints: [],
    interviewQuestions: [],
    improvements: [],
  };
}

// 生成時の応募メタ（企業・選考種別・業界・職種）。両モードで結果へ echo する。
type EsMeta = {
  companyName: string;
  selectionType: CareerEsSelectionType | null;
  industry: string;
  jobType: string;
};

// 応募メタ（企業・選考種別・業界・職種）を結果へ echo する（存在する分だけ）。
function applyMeta(result: CareerEsResult, meta: EsMeta): CareerEsResult {
  if (meta.companyName) result.companyName = meta.companyName;
  if (meta.selectionType) result.selectionType = meta.selectionType;
  if (meta.industry) result.industry = meta.industry;
  if (meta.jobType) result.jobType = meta.jobType;
  return result;
}

// AI 出力（パース済み unknown）を CareerEsResult 形状に正規化する（おまかせ生成モード）。
function normalizeResult(raw: unknown, meta: EsMeta): CareerEsResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return applyMeta(
    {
      gakuchika: str(r.gakuchika),
      selfPr: str(r.selfPr),
      motivation: str(r.motivation),
      headline: str(r.headline),
      appealPoints: strArray(r.appealPoints),
      interviewQuestions: strArray(r.interviewQuestions),
      improvements: strArray(r.improvements),
    },
    meta,
  );
}

// 設問モードの AI 出力を正規化する。answer を取り出し、設問・文字数・応募メタを echo する。
function normalizeAnswerResult(
  raw: unknown,
  meta: EsMeta & { question: string; charLimit: number | null },
): CareerEsResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const result: CareerEsResult = {
    ...emptyResult(),
    answer: str(r.answer),
    question: meta.question,
  };
  if (meta.charLimit) result.charLimit = meta.charLimit;
  return applyMeta(result, meta);
}

// 直近の自己分析結果を system prompt 用の可読テキストに整形する。
// 未提供（自己分析未実行）なら空文字を返し、prompt 側で section を出さない。
// P15-C: 自己分析ブロックの render は Context Orchestrator 経由の canonical renderer
//   （lib/careerMemory/renderers/esGenerationCrossFeature）へ移設。system prompt の組み立ては
//   pure builder（./esPrompt buildEsGenerationPrompt）へ抽出した。route は request 検証・AI 実行・
//   response 正規化に専念する（完成 prompt は移設前と byte 一致）。

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
    question?: string;
    charLimit?: number;
    companyName?: string;
    selectionType?: unknown;
    industry?: string;
    jobType?: string;
    companyResearchContext?: unknown;
  };

  const profile = b.profile ?? null;
  const activity = b.activity ?? null;
  const values = b.values ?? null;
  const selfAnalysis = b.selfAnalysis ?? null;
  const userInput = typeof b.userInput === 'string' ? b.userInput : '';

  // 設問モードの入力。設問が非空なら「設問への回答 1 本」を生成する分岐に入る。
  const question = typeof b.question === 'string' ? b.question.trim() : '';
  const companyName = typeof b.companyName === 'string' ? b.companyName.trim() : '';
  const charLimit =
    typeof b.charLimit === 'number' && Number.isFinite(b.charLimit) && b.charLimit > 0
      ? Math.floor(b.charLimit)
      : null;
  // 応募メタ（このES1本に限った文脈）。未指定は許容する。
  const selectionType: CareerEsSelectionType | null =
    b.selectionType === 'main' || b.selectionType === 'internship'
      ? b.selectionType
      : null;
  const industry = typeof b.industry === 'string' ? b.industry.trim() : '';
  const jobType = typeof b.jobType === 'string' ? b.jobType.trim() : '';
  const meta: EsMeta = { companyName, selectionType, industry, jobType };
  const answerMode = question !== '';

  // 材料が何も無ければ ES を作れないので弾く。
  const hasProfile = !!profile && Object.keys(profile).length > 0;
  const hasActivity = !!activity && Object.keys(activity).length > 0;
  if (!hasProfile && !hasActivity) {
    return Response.json(
      { error: '基本情報または活動整理のいずれかを入力してください。' },
      { status: 400 },
    );
  }

  // 就活版共通基盤でコンテキスト → system / user prompt を組み立てる（pure builder へ委譲）。
  //   P15-C: 自己分析ブロックは orchestrator の crossFeatureContext 経由。完成 prompt は移設前と byte 一致。
  const researchSnapshot = normalizeCompanyResearchSnapshot(b.companyResearchContext);
  const { system: systemPrompt, user: userMessage } = buildEsGenerationPrompt({
    profile,
    activity,
    values,
    selfAnalysis,
    userInput,
    question,
    companyName,
    charLimit,
    selectionType,
    industry,
    jobType,
    researchSnapshot,
  });

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
        const parsed = JSON.parse(extractJson(raw));
        result = answerMode
          ? normalizeAnswerResult(parsed, { ...meta, question, charLimit })
          : normalizeResult(parsed, meta);
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

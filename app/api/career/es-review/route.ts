// PASSAI 就活版 — ES（エントリーシート）添削AI API
//
// 役割: /career/es/[id] エディタの「AI添削」から呼ばれ、就活 ES 回答 1 本を採点・添削して
//       JSON で返すだけ。ES本文はユーザーが書き、AIは添削のみ（本文・完成例は返さない）。
//
// 設計思想（受験版 app/api/essay-review を参考。ただしコードは流用せず就活ES専用に再設計）:
//   - スコアは AI に出させ、ランクは「スコアから決定論で」導出する（AI にランクを決めさせない）。
//   - overallScore も breakdown 6 軸の平均から決定論で導出し、AI の自己申告に依存しない。
//   - AI 出力は defensive に normalize し、余計な文章・JSON 崩れでも壊れないようにする。
//   - 事実を捏造させない（与えられた回答文の範囲だけで判断・書き直す）。
//
// 非接続方針（生成系と同一）:
//   - 課金 / quota・usage 記録・DB / Supabase / Stripe には接続しない。
//   - AI 呼び出し系の純粋ユーティリティ（@/lib/ai / @/lib/aiTimeout）のみ利用する。

import type {
  CareerEsReview,
  CareerEsReviewBreakdown,
  CareerEsRank,
  CareerEsSelectionType,
} from '@/types/careerEs';
import {
  normalizeCompanyResearchSnapshot,
  formatCompanyResearchContextForPrompt,
} from '@/lib/careerCompanyResearch/context';
// prompt は lib へ lift 済み（QA harness から byte 検証するため。route の挙動は不変）。
import {
  ES_REVIEW_SYSTEM_PROMPT,
  buildEsReviewUserMessage,
} from '@/lib/careerEs/reviewPrompt';
import { anthropic, extractJson } from '@/lib/ai';
import {
  AI_BUDGET_PRESET_80S_WALL,
  createAiCallBudget,
  createTimeoutSignal,
} from '@/lib/aiTimeout';

// 生成系と同系の Sonnet を使用（課金/usage には接続しない）。
const MODEL = 'claude-sonnet-4-6';

// Vercel 実行時間上限。AI timeout（60s）+ 余裕。runtime は既定 nodejs。
export const maxDuration = 80;

// 6軸スコア + 各種コメント（良かった点/改善点/不足要素/採用担当視点/優先改善）を収める。
const MAX_TOKENS = 3000;

// 6 軸の固定キー（AI 出力の照合・normalize に使う）。
const BREAKDOWN_KEYS = [
  'logic',
  'specificity',
  'originality',
  'readability',
  'persuasion',
  'companyFit',
] as const;

// ── 小さなヘルパー ───────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 0〜100 の整数へ丸める（範囲外・非数は 0）。
function clampScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function strArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => str(v))
    .filter((v) => v !== '')
    .slice(0, max);
}

// スコアからランクを決定論で導出する（AI には決めさせない）。
function deriveRank(score: number): CareerEsRank {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}

// AI 出力（パース済み unknown）を CareerEsReview 形状に正規化する。
// overallScore / rank は AI の値を使わず、breakdown から決定論で再計算する。
function normalizeReview(raw: unknown): CareerEsReview {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawBreakdown =
    r.breakdown && typeof r.breakdown === 'object'
      ? (r.breakdown as Record<string, unknown>)
      : {};

  const breakdown = BREAKDOWN_KEYS.reduce((acc, key) => {
    acc[key] = clampScore(rawBreakdown[key]);
    return acc;
  }, {} as CareerEsReviewBreakdown);

  // overallScore は 6 軸の平均（決定論）。AI の自己申告 overallScore は採用しない。
  const sum = BREAKDOWN_KEYS.reduce((acc, key) => acc + breakdown[key], 0);
  const overallScore = Math.round(sum / BREAKDOWN_KEYS.length);

  return {
    overallScore,
    rank: deriveRank(overallScore),
    overallComment: str(r.overallComment),
    breakdown,
    strengths: strArray(r.strengths, 5),
    improvements: strArray(r.improvements, 5),
    missingElements: strArray(r.missingElements, 5),
    recruiterComments: strArray(r.recruiterComments, 5),
    priorityActions: strArray(r.priorityActions, 5),
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
    answer?: string;
    question?: string;
    companyName?: string;
    charLimit?: number;
    selectionType?: unknown;
    industry?: string;
    jobType?: string;
    companyResearchContext?: unknown;
  };

  const answer = str(b.answer);
  const question = str(b.question);
  const companyName = str(b.companyName);
  const charLimit =
    typeof b.charLimit === 'number' && Number.isFinite(b.charLimit) && b.charLimit > 0
      ? Math.floor(b.charLimit)
      : null;
  // 応募メタ（添削時の企業適合性・整合性評価の文脈に使う）。
  // 新規作成では必須だが、旧ログ（旧「指定なし」= 欠損）からの再添削もあるため未指定を許容する。
  const selectionType: CareerEsSelectionType | null =
    b.selectionType === 'main' || b.selectionType === 'internship'
      ? b.selectionType
      : null;
  const industry = str(b.industry);
  const jobType = str(b.jobType);
  // 保存済み企業研究（任意・1 件）。あれば回答との整合性評価に使う。
  const researchSnapshot = normalizeCompanyResearchSnapshot(b.companyResearchContext);
  const researchBlock = researchSnapshot
    ? formatCompanyResearchContextForPrompt([researchSnapshot])
    : '';

  // 添削対象が無ければ弾く。
  if (answer === '') {
    return Response.json(
      { error: '添削する本文がありません。' },
      { status: 400 },
    );
  }

  // 保存済み企業研究を使う場合の評価指示（断定を避けた添削者の文体を維持）。
  const researchInstruction = researchBlock
    ? [
        '# 保存済みの企業研究（ユーザー本人が作成・確認したもの）',
        researchBlock,
        '',
        'この企業研究はユーザー自身が確認・保存した一次情報です。添削では次も評価してください:',
        '- 企業研究で注目している点が、回答（特に志望動機）に活かされているか（企業理解の深さ・志望動機の具体性）。',
        '- 企業研究ログで「不足・根拠不足」と指摘された点（競合比較など）が放置されていないか。',
        '- 自己分析 / 活動整理 / 就活軸との接続が取れているか。',
        'コメントは「あなたの企業研究メモを見る限り」「保存済み企業研究によると」という文体にし、',
        '企業情報を断定せず、根拠不足は公式情報・説明会資料での再確認を促してください。',
      ].join('\n')
    : '';

  // user メッセージ: ES 設定（設問 / 文字数 / 企業名 / 業界 / 職種 / 選考種別）を
  // 提出先コンテキスト + 添削基準として積み、最後に添削対象本文を置く。
  // 欠損項目（旧ログ）はブロックごと出さない（AI に埋めさせない）。
  const userMessage = buildEsReviewUserMessage({
    answer,
    question,
    charLimit,
    companyName,
    industry,
    jobType,
    selectionType,
    researchInstruction,
  });

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する（生成系と同方針）。
    let review: CareerEsReview | null = null;
    // AI 合計時間予算（wall 80s の内側に固定）。retry ごとに満額 signal を再発行すると
    // 合計が wall を超えて 504（非JSON）になり、client には汎用エラーしか見えなくなる。
    const aiBudget = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const callTimeoutMs = aiBudget.nextCallTimeoutMs();
      // 残予算が retry に足りない → retry せず打ち切る（wall 超過による 504 を防ぐ）。
      if (callTimeoutMs === null) {
        return Response.json(
          {
            error: 'AI_ES_REVIEW_PARSE_FAILED',
            detail: 'AI応答をJSONとして解釈できませんでした。',
          },
          { status: 502 },
        );
      }
      const message = await anthropic.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: attempt === 2 ? 0 : 0.4,
          system: ES_REVIEW_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      // max_tokens 到達の途中切れは長さ起因なので retry せず明示エラーで返す。
      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_ES_REVIEW_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        review = normalizeReview(JSON.parse(extractJson(raw)));
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          {
            error: 'AI_ES_REVIEW_PARSE_FAILED',
            detail: 'AI応答をJSONとして解釈できませんでした。',
          },
          { status: 502 },
        );
      }
    }

    if (!review) {
      return Response.json(
        {
          error: 'AI_ES_REVIEW_PARSE_FAILED',
          detail: 'AI応答をJSONとして解釈できませんでした。',
        },
        { status: 502 },
      );
    }

    return Response.json({ review });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career ES review API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: 'ESの添削に失敗しました。' },
      { status: 500 },
    );
  }
}

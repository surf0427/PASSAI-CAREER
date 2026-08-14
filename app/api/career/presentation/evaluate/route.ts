// PASSAI 就活版 — プレゼン対策AI evaluate route（最小・ステートレス）。
//
// 役割: 発表の文字起こし＋テーマ＋時間をもとに、就活・ビジネスの観点で最終評価レポート（JSON）を返す。
//   - 受験版 /api/presentation/evaluate の「文字起こし→AI評価」構造を踏襲しつつ、DB 保存・課金・
//     Supabase Storage・usage には接続しない。評価結果はクライアントが localStorage に保存する。
//   - 数値スコア（0〜100）＋ランク（S/A/B/C/D）は就活版の方針として採用する。

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
// P7-F: presentation は ES を presentation-local strict summary で受け取る（full CareerEsResult carry 廃止）。
import type { PresentationEsSummary } from '@/lib/careerMemory/presentationEs';
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import type {
  CareerPresentationConfig,
  CareerPresentationFinalResult,
  CareerPresentationRank,
  CareerPresentationAxisScore,
} from '@/types/careerPresentation';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import {
  CAREER_PRESENTATION_MODEL,
  CAREER_PRESENTATION_AXES,
  buildPresentationBaseSystem,
  buildEvaluateUserPrompt,
  buildEvaluateInstruction,
} from '../presentationPrompt';
import { resolvePresentationContextInputs } from '../resolveContextInputs';

export const maxDuration = 80;

// P0.5 timeout 予算是正:
//   旧実装は per-call 75s の signal を attempt 毎に新規発行していたため、JSON parse retry が走ると
//   75s + 75s = 150s 相当となり maxDuration=80s を超えて 504 になる構造だった。
//   対策として (1) per-call を 60s に下げ、(2) 1回目+2回目の合計 AI 時間 TOTAL_BUDGET_MS を wall(80s)
//   の内側に固定し、(3) 2回目 retry は残予算が足りる時だけ発火する（残予算を signal 上限にも使う）。
const TOTAL_BUDGET_MS = 74_000; // 1回目+2回目の合計 AI 時間の上限（wall 80s に対し余白 6s）
const PER_CALL_TIMEOUT_MS = 60_000; // 1回あたりの AI timeout（旧 75s から短縮）
const MIN_RETRY_BUDGET_MS = 30_000; // 2回目 retry を発火するのに必要な最低残予算

const MAX_TRANSCRIPT_CHARS = 20000;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
}

function clampScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function rankFromScore(score: number): CareerPresentationRank {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

function normalizeRank(value: unknown, score: number): CareerPresentationRank {
  const v = str(value).toUpperCase();
  if (v === 'S' || v === 'A' || v === 'B' || v === 'C' || v === 'D') {
    return v as CareerPresentationRank;
  }
  return rankFromScore(score);
}

// AI が返した axes を CAREER_PRESENTATION_AXES の固定順・固定ラベルに正規化する。
function normalizeAxes(raw: unknown): CareerPresentationAxisScore[] {
  const byKey = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (a && typeof a === 'object') {
        const key = str((a as { key?: unknown }).key);
        if (key) byKey.set(key, a as Record<string, unknown>);
      }
    }
  }
  return CAREER_PRESENTATION_AXES.map((axis) => {
    const found = byKey.get(axis.key);
    return {
      key: axis.key,
      label: axis.label,
      score: clampScore(found?.score),
      comment: str(found?.comment),
    };
  });
}

function normalizeResult(raw: unknown): CareerPresentationFinalResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const totalScore = clampScore(r.totalScore);
  return {
    totalScore,
    rank: normalizeRank(r.rank, totalScore),
    overallComment: str(r.overallComment),
    axes: normalizeAxes(r.axes),
    goodPoints: strArray(r.goodPoints),
    improvements: strArray(r.improvements),
    priorityImprovements: strArray(r.priorityImprovements),
    nextPractice: strArray(r.nextPractice),
    expectedQuestions: strArray(r.expectedQuestions),
    improvedStructure: strArray(r.improvedStructure),
    structureFeedback: str(r.structureFeedback) || undefined,
    persuasionFeedback: str(r.persuasionFeedback) || undefined,
    deliveryFeedback: str(r.deliveryFeedback) || undefined,
    passLikelihood: str(r.passLikelihood),
    companyFit: str(r.companyFit),
    interviewerConcerns: strArray(r.interviewerConcerns),
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
    selfAnalysis?: CareerSelfAnalysisResult | null;
    es?: PresentationEsSummary | null;
    interview?: CareerInterviewFinalResult | null;
    matching?: CareerMatchEngineResult | null;
    consultationInsights?: string[] | null;
    config?: CareerPresentationConfig | null;
    theme?: unknown;
    timeLimitSec?: unknown;
    durationSec?: unknown;
    transcript?: unknown;
  };

  const transcript = str(b.transcript);
  if (!transcript) {
    return Response.json({ error: '発表内容が空です。' }, { status: 400 });
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    return Response.json({ error: '発表内容が長すぎます。' }, { status: 413 });
  }

  const config = b.config ?? null;
  const theme = str(b.theme);
  const timeLimitSec = clampSecond(b.timeLimitSec);
  const durationSec = clampSecond(b.durationSec);

  // Closure Batch（`D-S9`）: base + cross-feature を kind 単位で server / bridge から選ぶ。
  const ctx = await resolvePresentationContextInputs(b, req);
  const system = [
    buildPresentationBaseSystem({
      profile: ctx.profile,
      activity: ctx.activity,
      values: ctx.values,
      selfAnalysis: ctx.selfAnalysis as typeof b.selfAnalysis,
      es: ctx.es as typeof b.es,
      interview: ctx.interview as typeof b.interview,
      matching: ctx.matching as typeof b.matching,
      consultationInsights: ctx.consultationInsights,
      config,
      theme,
    }),
    buildEvaluateInstruction({ theme, config }),
  ].join('\n\n');

  const userPrompt = buildEvaluateUserPrompt({ theme, timeLimitSec, durationSec, transcript, config });

  try {
    let result: CareerPresentationFinalResult | null = null;
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remainingMs = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      // 残予算が 2回目に足りなければ retry せず打ち切る（maxDuration 超過による 504 を防ぐ）。
      if (attempt === 2 && remainingMs < MIN_RETRY_BUDGET_MS) {
        return Response.json(
          { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
      const callTimeoutMs = Math.min(PER_CALL_TIMEOUT_MS, Math.max(0, remainingMs));
      const message = await anthropic.messages.create(
        {
          model: CAREER_PRESENTATION_MODEL,
          max_tokens: 4000,
          temperature: attempt === 2 ? 0 : 0.4,
          system,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const rawText = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_PRESENTATION_TRUNCATED', detail: '評価が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        result = normalizeResult(JSON.parse(extractJson(rawText)));
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    if (!result) {
      return Response.json(
        { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
        { status: 502 },
      );
    }

    return Response.json({ result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career presentation evaluate API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '評価の生成に失敗しました。' },
      { status: 500 },
    );
  }
}

// 秒数の正規化（0〜3600 にクランプ。不正は 0）。
function clampSecond(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(3600, Math.round(n));
}

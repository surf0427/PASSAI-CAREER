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
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import type {
  CareerPresentationType,
  CareerPresentationFinalResult,
  CareerPresentationRank,
  CareerPresentationAxisScore,
} from '@/types/careerPresentation';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import { resolvePresentationType } from '@/app/career/presentation/presentationModes';
import {
  CAREER_PRESENTATION_MODEL,
  CAREER_PRESENTATION_AXES,
  buildPresentationBaseSystem,
  buildEvaluateUserPrompt,
  buildEvaluateInstruction,
} from '../presentationPrompt';

export const maxDuration = 80;

// 評価レポートは出力が大きい（12 項目 + 8 軸）ため、default 60s ではなく長めの timeout を渡す
// （maxDuration=80s 以内）。aiTimeout.ts の「大型 max_tokens の route は個別 ms で延長」方針に従う。
const EVALUATE_TIMEOUT_MS = 75_000;

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
    es?: CareerEsResult | null;
    interview?: CareerInterviewFinalResult | null;
    matching?: CareerMatchEngineResult | null;
    consultationInsights?: string[] | null;
    presentationType?: CareerPresentationType;
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

  const presentationType = resolvePresentationType(b.presentationType);
  const theme = str(b.theme);
  const timeLimitSec = clampSecond(b.timeLimitSec);
  const durationSec = clampSecond(b.durationSec);

  const system = [
    buildPresentationBaseSystem({
      profile: b.profile ?? null,
      activity: b.activity ?? null,
      values: b.values ?? null,
      selfAnalysis: b.selfAnalysis ?? null,
      es: b.es ?? null,
      interview: b.interview ?? null,
      matching: b.matching ?? null,
      consultationInsights: b.consultationInsights ?? null,
      presentationType,
    }),
    buildEvaluateInstruction(presentationType),
  ].join('\n\n');

  const userPrompt = buildEvaluateUserPrompt({ theme, timeLimitSec, durationSec, transcript });

  try {
    let result: CareerPresentationFinalResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: CAREER_PRESENTATION_MODEL,
          max_tokens: 4000,
          temperature: attempt === 2 ? 0 : 0.4,
          system,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { signal: createTimeoutSignal(EVALUATE_TIMEOUT_MS) },
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

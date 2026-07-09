// PASSAI 就活版 — プレゼン対策AI theme route（AI即興テーマ生成・ステートレス）。
//
// 役割: プレゼンの種類とプロフィール等から、本番でありそうな発表テーマ（お題）を1つ生成して返す。
//   - 受験版 /api/presentation/theme の構造を踏襲しつつ、DB・課金・Supabase・usage 非接続。
//   - 大学受験のプレゼン入試テーマではなく、就活のプレゼン選考テーマを生成する。

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
import type { CareerPresentationConfig } from '@/types/careerPresentation';
import { anthropic } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import {
  CAREER_PRESENTATION_MODEL,
  buildPresentationBaseSystem,
  buildThemeUserPrompt,
} from '../presentationPrompt';

export const maxDuration = 80;

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('')
    .trim()
    // 念のため前後の引用符・コードフェンスを除去。
    .replace(/^```[a-zA-Z]*\n?|\n?```$/g, '')
    .replace(/^["「『]|["」』]$/g, '')
    .trim();
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
    timeLimitSec?: unknown;
    difficulty?: unknown;
    excludeThemes?: unknown;
  };

  const config = b.config ?? null;
  const timeLimitSec = typeof b.timeLimitSec === 'number' ? b.timeLimitSec : 0;
  // 直近生成お題（連続生成で似すぎないようにする）。文字列配列のみ・最大5件。
  const excludeThemes = Array.isArray(b.excludeThemes)
    ? b.excludeThemes.filter((t): t is string => typeof t === 'string').slice(0, 5)
    : [];
  const system = buildPresentationBaseSystem({
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    selfAnalysis: b.selfAnalysis ?? null,
    es: b.es ?? null,
    interview: b.interview ?? null,
    matching: b.matching ?? null,
    consultationInsights: b.consultationInsights ?? null,
    config,
  });

  try {
    const message = await anthropic.messages.create(
      {
        model: CAREER_PRESENTATION_MODEL,
        max_tokens: 300,
        temperature: 1,
        system,
        messages: [
          {
            role: 'user',
            content: buildThemeUserPrompt({ config, timeLimitSec, difficulty: b.difficulty, excludeThemes }),
          },
        ],
      },
      { signal: createTimeoutSignal() },
    );

    const theme = extractText(message.content as Array<{ type: string; text?: string }>);
    if (!theme) {
      return Response.json(
        { error: 'AI_PRESENTATION_EMPTY', detail: 'テーマの生成に失敗しました。' },
        { status: 502 },
      );
    }
    return Response.json({ theme });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career presentation theme API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: 'テーマの生成に失敗しました。' },
      { status: 500 },
    );
  }
}

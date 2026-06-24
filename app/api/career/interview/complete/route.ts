// PASSAI 就活版 — 面接AI complete route（最小・ステートレス）
//
// 役割: 面接のやり取り全体を受け取り、新卒就活の観点で最終評価（JSON）を返す。
//   - 受験版 /api/interview-ai/complete（generateFinalFeedback）の構造を踏襲しつつ、DB 保存・
//     課金・usage には接続しない。評価結果はクライアントが localStorage に保存する。

import type { CareerProfileInput, CareerActivityInput } from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type {
  CareerInterviewTurn,
  CareerInterviewFinalResult,
} from '@/types/careerInterview';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import {
  CAREER_INTERVIEW_MODEL,
  buildInterviewBaseSystem,
  buildFinalUserPrompt,
  FINAL_FEEDBACK_INSTRUCTION,
} from '../interviewPrompt';

export const maxDuration = 80;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v) => v !== '');
}

function normalizeTurns(value: unknown): CareerInterviewTurn[] {
  if (!Array.isArray(value)) return [];
  const out: CareerInterviewTurn[] = [];
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

function normalizeResult(raw: unknown): CareerInterviewFinalResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    overallComment: str(r.overallComment),
    strengths: strArray(r.strengths),
    improvements: strArray(r.improvements),
    sampleAnswers: strArray(r.sampleAnswers),
    deepDiveTopics: strArray(r.deepDiveTopics),
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
    selfAnalysis?: CareerSelfAnalysisResult | null;
    es?: CareerEsResult | null;
    userInput?: string;
    turns?: unknown;
  };

  const turns = normalizeTurns(b.turns);
  // 回答が 1 件も無ければ評価対象にしない。
  if (turns.filter((t) => t.role === 'answer').length === 0) {
    return Response.json({ error: '回答がありません。' }, { status: 409 });
  }

  const system = [
    buildInterviewBaseSystem({
      profile: b.profile ?? null,
      activity: b.activity ?? null,
      selfAnalysis: b.selfAnalysis ?? null,
      es: b.es ?? null,
      userInput: typeof b.userInput === 'string' ? b.userInput : '',
    }),
    FINAL_FEEDBACK_INSTRUCTION,
  ].join('\n\n');

  try {
    let result: CareerInterviewFinalResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: CAREER_INTERVIEW_MODEL,
          max_tokens: 4000,
          temperature: attempt === 2 ? 0 : 0.4,
          system,
          messages: [{ role: 'user', content: buildFinalUserPrompt(turns) }],
        },
        { signal: createTimeoutSignal() },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_INTERVIEW_TRUNCATED', detail: '評価が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        result = normalizeResult(JSON.parse(extractJson(raw)));
        break;
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_INTERVIEW_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    if (!result) {
      return Response.json(
        { error: 'AI_INTERVIEW_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
        { status: 502 },
      );
    }

    return Response.json({ result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career interview complete API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '評価の生成に失敗しました。' },
      { status: 500 },
    );
  }
}

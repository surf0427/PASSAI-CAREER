// PASSAI 就活版 — 面接AI turn route（最小・ステートレス）
//
// 役割: 直前の回答を受け取り、一言リアクション + 次の深掘り質問（JSON）を返す。
//   - 受験版 /api/interview-ai/turn(answer→followup) の構造を踏襲しつつ、DB セッション・課金・
//     usage には接続しない。会話状態（turns）はクライアントが送る（ステートレス）。
//   - ターン上限（CAREER_INTERVIEW_MAX_TURNS）に達したら done を返し、followup を生成しない。

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type {
  CareerInterviewTurn,
  CareerInterviewType,
} from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import { resolveInterviewType } from '@/app/career/interview/interviewModes';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import {
  CAREER_INTERVIEW_MODEL,
  CAREER_INTERVIEW_MAX_TURNS,
  buildInterviewBaseSystem,
  buildFollowupUserPrompt,
  countAnswers,
} from '../interviewPrompt';

export const maxDuration = 80;

const MAX_ANSWER_CHARS = 8000;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 受信した turns を {role, content} の交互列に正規化する（壊れた要素は除去）。
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
    matching?: CareerMatchEngineResult | null;
    consultationInsights?: string[] | null;
    interviewType?: CareerInterviewType;
    userInput?: string;
    turns?: unknown;
    answer?: unknown;
  };

  const turns = normalizeTurns(b.turns);
  const answer = str(b.answer);

  if (!answer) {
    return Response.json({ error: '回答が空です。' }, { status: 400 });
  }
  if (answer.length > MAX_ANSWER_CHARS) {
    return Response.json({ error: '回答が長すぎます。' }, { status: 413 });
  }
  // 直前に未回答の質問が必要（末尾が question）。
  const last = turns[turns.length - 1];
  if (!last || last.role !== 'question') {
    return Response.json({ error: '回答対象の質問がありません。' }, { status: 409 });
  }

  // 回答を会話に加えた後の回答数。上限到達なら followup を生成せず done。
  const newAnswerCount = countAnswers(turns) + 1;
  if (newAnswerCount >= CAREER_INTERVIEW_MAX_TURNS) {
    return Response.json({ done: true, reaction: '', question: null });
  }

  const priorTurns: CareerInterviewTurn[] = [
    ...turns,
    { role: 'answer', content: answer },
  ];

  const interviewType = resolveInterviewType(b.interviewType);
  const system = buildInterviewBaseSystem({
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    selfAnalysis: b.selfAnalysis ?? null,
    es: b.es ?? null,
    matching: b.matching ?? null,
    consultationInsights: b.consultationInsights ?? null,
    interviewType,
    userInput: typeof b.userInput === 'string' ? b.userInput : '',
  });

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する。
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: CAREER_INTERVIEW_MODEL,
          max_tokens: 500,
          temperature: attempt === 2 ? 0 : 0.6,
          system,
          messages: [
            { role: 'user', content: buildFollowupUserPrompt(priorTurns, interviewType) },
          ],
        },
        { signal: createTimeoutSignal() },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_INTERVIEW_TRUNCATED', detail: 'AI応答が途中で切れました。' },
          { status: 502 },
        );
      }

      try {
        const parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
        const question = str(parsed.question);
        if (!question) throw new Error('empty-question');
        return Response.json({
          reaction: str(parsed.reaction),
          question,
          done: false,
        });
      } catch {
        if (attempt === 1) continue;
        return Response.json(
          { error: 'AI_INTERVIEW_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    return Response.json(
      { error: 'AI_INTERVIEW_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
      { status: 502 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career interview turn API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '次の質問の生成に失敗しました。' },
      { status: 500 },
    );
  }
}

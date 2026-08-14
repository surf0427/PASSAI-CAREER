// PASSAI 就活版 — プレゼン対策AI qa route（発表後の質疑応答・ターン制・ステートレス）。
//
// 役割: 発表内容に対する採用担当からの質問を、ターン制（kickoff / followup）で生成して返す。
//   - 受験版 /api/presentation/qa の kickoff/answer/followup 思想を踏襲しつつ、DB・課金・usage 非接続。
//   - 会話状態（turns）はクライアントが送る。上限到達で done を返す。

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
  CareerPresentationQaTurn,
} from '@/types/careerPresentation';
import { anthropic, extractJson } from '@/lib/ai';
import {
  AI_BUDGET_PRESET_80S_WALL,
  createAiCallBudget,
  createTimeoutSignal,
} from '@/lib/aiTimeout';
import {
  CAREER_PRESENTATION_MODEL,
  CAREER_PRESENTATION_QA_MAX_TURNS,
  buildPresentationBaseSystem,
  buildQaUserPrompt,
  countQaAnswers,
} from '../presentationPrompt';
import { resolvePresentationContextInputs } from '../resolveContextInputs';

export const maxDuration = 80;

const MAX_ANSWER_CHARS = 8000;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTurns(value: unknown): CareerPresentationQaTurn[] {
  if (!Array.isArray(value)) return [];
  const out: CareerPresentationQaTurn[] = [];
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
    es?: PresentationEsSummary | null;
    interview?: CareerInterviewFinalResult | null;
    matching?: CareerMatchEngineResult | null;
    consultationInsights?: string[] | null;
    config?: CareerPresentationConfig | null;
    theme?: unknown;
    transcript?: unknown;
    turns?: unknown;
  };

  const transcript = str(b.transcript);
  if (!transcript) {
    return Response.json({ error: '発表内容がありません。' }, { status: 400 });
  }

  const turns = normalizeTurns(b.turns);
  // 末尾が answer でその回答が長すぎる場合は弾く（直近回答のバリデーション）。
  const lastTurn = turns[turns.length - 1];
  if (lastTurn && lastTurn.role === 'answer' && lastTurn.content.length > MAX_ANSWER_CHARS) {
    return Response.json({ error: '回答が長すぎます。' }, { status: 413 });
  }

  // 既に上限の質問数に達していれば done（これ以上質問しない）。
  if (countQaAnswers(turns) >= CAREER_PRESENTATION_QA_MAX_TURNS) {
    return Response.json({ done: true, reaction: '', question: null });
  }

  const config = b.config ?? null;
  const theme = str(b.theme);

  // Closure Batch（`D-S9`）: base + cross-feature を kind 単位で server / bridge から選ぶ。
  const ctx = await resolvePresentationContextInputs(b, req);
  const system = buildPresentationBaseSystem({
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
  });

  const userPrompt = buildQaUserPrompt({ theme, transcript, turns, config });

  try {
    // AI 合計時間予算（wall 80s の内側に固定）。retry ごとに満額 signal を再発行すると
    // 合計が wall を超えて 504（非JSON）になり、client には汎用エラーしか見えなくなる。
    const aiBudget = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const callTimeoutMs = aiBudget.nextCallTimeoutMs();
      // 残予算が retry に足りない → retry せず打ち切る（wall 超過による 504 を防ぐ）。
      if (callTimeoutMs === null) {
        return Response.json(
          { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
      const message = await anthropic.messages.create(
        {
          model: CAREER_PRESENTATION_MODEL,
          max_tokens: 500,
          temperature: attempt === 2 ? 0 : 0.6,
          system,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_PRESENTATION_TRUNCATED', detail: 'AI応答が途中で切れました。' },
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
          { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    return Response.json(
      { error: 'AI_PRESENTATION_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
      { status: 502 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career presentation qa API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '質問の生成に失敗しました。' },
      { status: 500 },
    );
  }
}

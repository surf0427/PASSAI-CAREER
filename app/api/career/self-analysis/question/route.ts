// PASSAI 就活版 — 自己分析 深掘り質問 route（最小・ステートレス）
//
// 役割: 自己分析の壁打ち（深掘り）で、次の1問を生成して返す。
//   - turns が空（かつ answer 無し）なら seed（1問目）を生成する。
//   - answer が来たら、それを会話に加えたうえで followup（リアクション＋次の1問）を返す。
//   - 上限（CAREER_SELF_ANALYSIS_MAX_TURNS）に達したら done を返し、followup を生成しない。
//   - 会話状態（turns）はクライアントが送る（ステートレス）。DB / 課金 / usage には接続しない。
//   - 受験版 API（/api/analysis 等）・受験版型・受験版キーには一切依存しない。

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisTurn } from '@/types/careerSelfAnalysis';
import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal } from '@/lib/aiTimeout';
import {
  CAREER_SELF_ANALYSIS_MODEL,
  CAREER_SELF_ANALYSIS_MAX_TURNS,
  buildDeepDiveBaseSystem,
  buildSeedUserPrompt,
  buildFollowupUserPrompt,
  countAnswers,
} from '../deepDivePrompt';

export const maxDuration = 80;

const MAX_ANSWER_CHARS = 8000;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 受信した turns を {role, content} の交互列に正規化する（壊れた要素は除去）。
function normalizeTurns(value: unknown): CareerSelfAnalysisTurn[] {
  if (!Array.isArray(value)) return [];
  const out: CareerSelfAnalysisTurn[] = [];
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

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
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
    turns?: unknown;
    answer?: unknown;
  };

  const turns = normalizeTurns(b.turns);
  const answer = str(b.answer);

  // プロフィールも活動も無ければ深掘りの材料が無いので弾く（単発生成と同基準）。
  const hasProfile = !!b.profile && Object.keys(b.profile).length > 0;
  const hasActivity = !!b.activity && Object.keys(b.activity).length > 0;
  if (!hasProfile && !hasActivity) {
    return Response.json(
      { error: '基本情報または活動整理のいずれかを入力してください。' },
      { status: 400 },
    );
  }

  const system = buildDeepDiveBaseSystem({
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
  });

  // ── seed（1問目）: turns 空かつ answer 無し ──────────────────────
  if (turns.length === 0 && !answer) {
    try {
      const message = await anthropic.messages.create(
        {
          model: CAREER_SELF_ANALYSIS_MODEL,
          max_tokens: 400,
          temperature: 0.6,
          system,
          messages: [{ role: 'user', content: buildSeedUserPrompt() }],
        },
        { signal: createTimeoutSignal() },
      );
      const question = extractText(
        message.content as Array<{ type: string; text?: string }>,
      );
      if (!question) {
        return Response.json(
          { error: 'AI_SELF_ANALYSIS_EMPTY', detail: '質問の生成に失敗しました。' },
          { status: 502 },
        );
      }
      return Response.json({ reaction: '', question, done: false });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Career self-analysis question(seed) API error:', msg);
      return Response.json(
        { error: 'AI_REQUEST_FAILED', detail: '深掘りの開始に失敗しました。' },
        { status: 500 },
      );
    }
  }

  // ── followup（回答を踏まえた次の1問）─────────────────────────────
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
  if (newAnswerCount >= CAREER_SELF_ANALYSIS_MAX_TURNS) {
    return Response.json({ done: true, reaction: '', question: null });
  }

  const priorTurns: CareerSelfAnalysisTurn[] = [
    ...turns,
    { role: 'answer', content: answer },
  ];

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する。
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: CAREER_SELF_ANALYSIS_MODEL,
          max_tokens: 500,
          temperature: attempt === 2 ? 0 : 0.6,
          system,
          messages: [{ role: 'user', content: buildFollowupUserPrompt(priorTurns) }],
        },
        { signal: createTimeoutSignal() },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        return Response.json(
          { error: 'AI_SELF_ANALYSIS_TRUNCATED', detail: 'AI応答が途中で切れました。' },
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
          { error: 'AI_SELF_ANALYSIS_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
          { status: 502 },
        );
      }
    }

    return Response.json(
      { error: 'AI_SELF_ANALYSIS_PARSE_FAILED', detail: 'AI応答を解釈できませんでした。' },
      { status: 502 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Career self-analysis question(followup) API error:', msg);
    return Response.json(
      { error: 'AI_REQUEST_FAILED', detail: '次の質問の生成に失敗しました。' },
      { status: 500 },
    );
  }
}

// PASSAI 就活版 — ES「深掘りしながら書く」材料整理メモ route
//
// 役割: 深掘りQ&A（設問への本人の回答）から「材料メモ」を JSON で返すだけ。
//   本文は書かない（ai_policy）。完成文・例文は返さない。
//   DB / 課金 / usage には接続しない。AI 呼び出し系の純粋ユーティリティのみ利用する。

import { anthropic, extractJson } from '@/lib/ai';
import { createTimeoutSignal, isAbortError } from '@/lib/aiTimeout';
import {
  CAREER_ES_ORGANIZE_MODEL,
  ES_ORGANIZE_SYSTEM_PROMPT,
  buildEsOrganizeUserMessage,
  type EsOrganizeTurn,
} from '@/lib/careerEs/organizePrompt';

export const maxDuration = 80;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function jsonError(code: string, status: number, detail: string) {
  return Response.json({ error: code, code, detail }, { status });
}

function normalizeTurns(value: unknown): EsOrganizeTurn[] {
  if (!Array.isArray(value)) return [];
  const out: EsOrganizeTurn[] = [];
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

function normalizeMemo(raw: unknown): string[] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(r.memo)) return [];
  return r.memo
    .map((m) => str(m))
    .filter((m) => m !== '')
    .slice(0, 8);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('BAD_REQUEST', 400, 'リクエストの形式が不正です。');
  }

  const b = (body && typeof body === 'object' ? body : {}) as {
    question?: unknown;
    turns?: unknown;
  };

  const question = str(b.question);
  const turns = normalizeTurns(b.turns);
  if (!question) {
    return jsonError('INPUT_REQUIRED', 400, 'ES設問が指定されていません。');
  }
  if (turns.length === 0) {
    return jsonError('INPUT_REQUIRED', 400, '整理する回答がありません。');
  }

  const userMessage = buildEsOrganizeUserMessage(question, turns);

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する（他 route と同方針）。
    for (let attempt = 1; attempt <= 2; attempt++) {
      const message = await anthropic.messages.create(
        {
          model: CAREER_ES_ORGANIZE_MODEL,
          max_tokens: 800,
          temperature: attempt === 2 ? 0 : 0.3,
          system: [
            {
              type: 'text',
              text: ES_ORGANIZE_SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: createTimeoutSignal() },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';
      if (message.stop_reason === 'max_tokens') {
        return jsonError('AI_ES_ORGANIZE_TRUNCATED', 502, 'AIの応答が途中で切れました。もう一度お試しください。');
      }

      try {
        const memo = normalizeMemo(JSON.parse(extractJson(raw)));
        return Response.json({ memo });
      } catch {
        if (attempt === 1) continue;
        return jsonError('AI_ES_ORGANIZE_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
      }
    }

    return jsonError('AI_ES_ORGANIZE_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
  } catch (error) {
    if (isAbortError(error)) {
      return jsonError('AI_TIMEOUT', 503, 'AIの応答に時間がかかっています。少し時間を置いてもう一度お試しください。');
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[career/es/organize]', msg.slice(0, 200));
    return jsonError('AI_REQUEST_FAILED', 500, '材料整理に失敗しました。もう一度お試しください。');
  }
}

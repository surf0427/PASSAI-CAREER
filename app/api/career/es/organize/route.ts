// PASSAI 就活版 — ES「深掘りしながら書く」材料整理メモ route
//
// 役割: 深掘りQ&A（設問への本人の回答）から「材料メモ」を JSON で返すだけ。
//   本文は書かない（ai_policy）。完成文・例文は返さない。
//   DB / 課金 / usage には接続しない。AI 呼び出し系の純粋ユーティリティのみ利用する。

import { anthropic, extractJson } from '@/lib/ai';
import {
  AI_BUDGET_PRESET_80S_WALL,
  createAiCallBudget,
  createTimeoutSignal,
  isAbortError,
} from '@/lib/aiTimeout';
import {
  CAREER_ES_ORGANIZE_MODEL,
  ES_ORGANIZE_SYSTEM_PROMPT,
  buildEsOrganizeUserMessage,
  type EsOrganizeTurn,
} from '@/lib/careerEs/organizePrompt';
import {
  ES_KNOWN_FACTS_MAX_LINES,
  ES_KNOWN_FACTS_MAX_LINE_CHARS,
} from '@/lib/careerEs/deepDivePrompt';
// Data Spine: 選択材料と **併用**する背景 context（選択の有無で見出し・ルールが変わる）。
//   ★ Organize に企業公式情報は載せない（Q&A を本人の言葉で構造化するのが目的のため）。
import { resolveEsFallbackContextBlock } from '../resolveFallbackContext';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';

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

// 既知事実（選択材料）の防御正規化。件数・長さを bound し、prompt 肥大を防ぐ。
function normalizeKnownFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const line = item.trim().slice(0, ES_KNOWN_FACTS_MAX_LINE_CHARS);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= ES_KNOWN_FACTS_MAX_LINES) break;
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
    knownFacts?: unknown;
    // User Data Spine bridge（背景 context 用。未指定なら背景ブロックは出ない）。
    profile?: CareerProfileInput | null;
    activity?: CareerActivityInput | null;
    values?: CareerValuesInput | null;
    selfAnalysis?: CareerSelfAnalysisResult | null;
  };

  const question = str(b.question);
  const turns = normalizeTurns(b.turns);
  // 選択材料の既知事実（client が選択済み材料からのみ作る）。未指定なら従来どおり。
  const knownFacts = normalizeKnownFacts(b.knownFacts);
  if (!question) {
    return jsonError('INPUT_REQUIRED', 400, 'ES設問が指定されていません。');
  }
  if (turns.length === 0) {
    return jsonError('INPUT_REQUIRED', 400, '整理する回答がありません。');
  }

  const userMessage = buildEsOrganizeUserMessage(question, turns, knownFacts);
  // 選択材料の有無に関わらず背景 context を足す（有無で見出し・取り扱いルールが変わる）。
  const fallbackBlock = await resolveEsFallbackContextBlock(knownFacts.length > 0, b, req);

  try {
    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する（他 route と同方針）。
    // AI 合計時間予算（wall 80s の内側に固定）。retry ごとに満額 signal を再発行すると
    // 合計が wall を超えて 504（非JSON）になり、client には汎用エラーしか見えなくなる。
    const aiBudget = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const callTimeoutMs = aiBudget.nextCallTimeoutMs();
      // 残予算が retry に足りない → retry せず打ち切る（wall 超過による 504 を防ぐ）。
      if (callTimeoutMs === null) {
        return jsonError('AI_ES_ORGANIZE_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
      }
      const message = await anthropic.messages.create(
        {
          model: CAREER_ES_ORGANIZE_MODEL,
          max_tokens: 800,
          temperature: attempt === 2 ? 0 : 0.3,
          // ★ 静的 prefix（ES_ORGANIZE_SYSTEM_PROMPT）は cache_control 付きのまま **先頭に固定**し、
          //   ユーザーごとに変わる背景 context は **その後ろの別 block** に置く。
          //   逆順・同一 block にすると prompt cache のヒット率が毎リクエスト壊れる。
          system: [
            {
              type: 'text' as const,
              text: ES_ORGANIZE_SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' as const },
            },
            ...(fallbackBlock ? [{ type: 'text' as const, text: fallbackBlock }] : []),
          ],
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
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

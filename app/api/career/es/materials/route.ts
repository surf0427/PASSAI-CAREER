// PASSAI 就活版 — ES 深掘りの「材料候補 × 設問」関連判定 route（最小・ステートレス）。
//
// 役割: ES 設問と候補ラベル（client が localStorage canonical から決定論で作ったもの）を受け取り、
//   「この設問に使えそうな候補」を関連度付きで返す。
//   - 候補の列挙そのものは client（lib/careerEs/materialCandidates.ts の純関数）が行う。
//   - 本 route は **関連度の順位付けのみ**。FULL/PARTIAL/NONE の判定は client 側の
//     決定論関数（deriveEsMaterialCoverage）が行う（AI に coverage を決めさせない）。
//   - AI が返した未知 id は破棄する（幻覚した候補を UI に出さない）。
//   - 会話状態を持たない。DB / Supabase / Layer 1 server read / 課金 / usage には接続しない。
//   - AI は本文を書かない（ai_policy）。

import { anthropic, extractJson } from '@/lib/ai';
import { createAiCallBudget, createTimeoutSignal, isAbortError } from '@/lib/aiTimeout';
import { classifyEsQuestionType, type EsQuestionType } from '@/lib/careerEs/deepDivePrompt';
import {
  CAREER_ES_MATERIALS_MODEL,
  ES_MATERIALS_SYSTEM_PROMPT,
  buildEsMaterialsUserMessage,
  normalizeEsMaterialSelections,
  type EsMaterialPromptCandidate,
} from '@/lib/careerEs/materialPrompt';
import {
  ES_MATERIAL_CANDIDATE_LIMIT,
  ES_MATERIAL_LABEL_MAX_CHARS,
} from '@/lib/careerEs/materialCandidates';

export const maxDuration = 80;

// 関連判定は軽い（候補ラベルのみ・max_tokens 小）。深掘り質問と同じ budget 方針に揃える。
const MATERIALS_AI_TIMEOUT_MS = 30_000;
const MATERIALS_AI_TOTAL_BUDGET_MS = 45_000;
const MATERIALS_AI_MIN_RETRY_BUDGET_MS = 12_000;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function jsonError(code: string, status: number, detail: string) {
  return Response.json({ error: code, code, detail }, { status });
}

// client が送った候補を正規化する（id + label のみ採用。件数・長さを bound する）。
function normalizeCandidates(value: unknown): EsMaterialPromptCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: EsMaterialPromptCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const id = str((raw as { id?: unknown }).id);
    const label = str((raw as { label?: unknown }).label);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: label.slice(0, ES_MATERIAL_LABEL_MAX_CHARS) });
    if (out.length >= ES_MATERIAL_CANDIDATE_LIMIT) break;
  }
  return out;
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
    questionType?: unknown;
    candidates?: unknown;
  };

  const question = str(b.question);
  if (!question) {
    return jsonError('INPUT_REQUIRED', 400, 'ES設問が指定されていません。');
  }

  const questionType: EsQuestionType =
    b.questionType === 'gakuchika' ||
    b.questionType === 'motivation' ||
    b.questionType === 'selfPr' ||
    b.questionType === 'research' ||
    b.questionType === 'other'
      ? b.questionType
      : classifyEsQuestionType(question);

  const candidates = normalizeCandidates(b.candidates);
  // 候補が 1 件も無い（＝Career Data 未入力）なら AI を呼ばずに「関連なし」を返す。
  if (candidates.length === 0) {
    return Response.json({ selections: [], questionType });
  }

  const knownIds = new Set(candidates.map((c) => c.id));

  try {
    const budget = createAiCallBudget({
      totalBudgetMs: MATERIALS_AI_TOTAL_BUDGET_MS,
      perCallTimeoutMs: MATERIALS_AI_TIMEOUT_MS,
      minRetryBudgetMs: MATERIALS_AI_MIN_RETRY_BUDGET_MS,
    });

    for (let attempt = 1; attempt <= 2; attempt++) {
      const callTimeoutMs = budget.nextCallTimeoutMs();
      // 残予算不足 → retry せず打ち切る（合計上限を超える前に JSON エラーを返す）。
      if (callTimeoutMs === null) {
        return jsonError(
          'AI_ES_MATERIALS_PARSE_FAILED',
          502,
          'AIの応答を解釈できませんでした。もう一度お試しください。',
        );
      }

      const message = await anthropic.messages.create(
        {
          model: CAREER_ES_MATERIALS_MODEL,
          max_tokens: 900,
          temperature: attempt === 2 ? 0 : 0.2,
          system: ES_MATERIALS_SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: buildEsMaterialsUserMessage(question, questionType, candidates) },
          ],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';
      if (message.stop_reason === 'max_tokens') {
        return jsonError(
          'AI_ES_MATERIALS_TRUNCATED',
          502,
          'AIの応答が途中で切れました。もう一度お試しください。',
        );
      }

      try {
        const parsed = JSON.parse(extractJson(raw)) as unknown;
        // selections が空配列なのは正常（＝関連する既存情報が無い）。
        return Response.json({
          selections: normalizeEsMaterialSelections(parsed, knownIds),
          questionType,
        });
      } catch {
        if (attempt === 1) continue;
        return jsonError(
          'AI_ES_MATERIALS_PARSE_FAILED',
          502,
          'AIの応答を解釈できませんでした。もう一度お試しください。',
        );
      }
    }

    return jsonError(
      'AI_ES_MATERIALS_PARSE_FAILED',
      502,
      'AIの応答を解釈できませんでした。もう一度お試しください。',
    );
  } catch (error) {
    if (isAbortError(error)) {
      return jsonError(
        'AI_TIMEOUT',
        503,
        'AIの応答に時間がかかっています。少し時間を置いてもう一度お試しください。',
      );
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[career/es/materials]', msg.slice(0, 200));
    return jsonError(
      'AI_REQUEST_FAILED',
      500,
      '関連する情報の検索に失敗しました。もう一度お試しください。',
    );
  }
}

// PASSAI 就活版 — ES「深掘りしながら書く」深掘り質問 route（最小・ステートレス）
//
// 役割: ある ES 設問に対して、次の1問を生成して返す（材料整理のための壁打ち）。
//   - turns が空（かつ answer 無し）なら seed（1問目）を生成する。
//   - answer が来たら、それを会話に加えたうえで followup（リアクション＋次の1問）を返す。
//   - 設問種別ごとの上限に達したら done を返す（ガクチカ 5〜8 / 志望動機 3〜5 等）。
//   - 会話状態（turns）はクライアントが送る（ステートレス）。DB / 課金 / usage には接続しない。
//   - AI は本文を書かない（ai_policy）。質問生成のみ。
//
// V1（材料選択フェーズ）:
//   client が「ユーザーが選択した既存 Career Data」から作った knownFacts / missingAxes を
//   optional で受け取り、既知の事実を再質問しないよう制約する（＋既知の分だけ質問数を減らす）。
//   ★ server は Data Spine（Layer 1）を読まない。既知情報は **request body 経由のみ**
//     （この route は引き続き server context consumer ではない）。
//   ★ 未指定なら prompt も上限も従来と完全に同じ（既存呼び出し・関連情報なしは挙動不変）。

import { anthropic, extractJson } from '@/lib/ai';
import { createAiCallBudget, createTimeoutSignal, isAbortError } from '@/lib/aiTimeout';
import {
  CAREER_ES_DEEP_MODEL,
  ES_KNOWN_FACTS_MAX_LINES,
  ES_KNOWN_FACTS_MAX_LINE_CHARS,
  classifyEsQuestionType,
  esTurnCapForContext,
  esCountAnswers,
  buildEsDeepSystem,
  buildEsSeedUserPrompt,
  buildEsFollowupUserPrompt,
  type EsDeepDiveContext,
  type EsQuestionType,
  type EsTurn,
} from '@/lib/careerEs/deepDivePrompt';
// Data Spine fallback: 材料未選択のときだけ背景 context を足す（選択済みなら byte 不変）。
import { resolveEsFallbackContextBlock } from '../resolveFallbackContext';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';

export const maxDuration = 80;

const MAX_ANSWER_CHARS = 8000;
// 深掘り質問は軽く、通常 15 秒以内に返る。30 秒で絞り、スマホでも必ず JSON エラーを返す。
const QUESTION_AI_TIMEOUT_MS = 30_000;
// 上の「必ず JSON エラーを返す」は 1 request **合計**についての約束。parse retry が満額 signal を
// 再発行すると合計 60s になり、その約束が成立しなくなるため合計側にも上限を置く。
const QUESTION_AI_TOTAL_BUDGET_MS = 45_000;
// max_tokens 500 の再生成に最低限必要な残予算（下回れば retry せず parse エラーを返す）。
const QUESTION_AI_MIN_RETRY_BUDGET_MS = 12_000;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function jsonError(code: string, status: number, detail: string) {
  return Response.json({ error: code, code, detail }, { status });
}

// 既知事実 / 不足観点（client が選択材料から作る）。文字列配列のみ採用し、件数・長さを bound する。
function normalizeStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const line = item.trim().slice(0, maxChars);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeTurns(value: unknown): EsTurn[] {
  if (!Array.isArray(value)) return [];
  const out: EsTurn[] = [];
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
    return jsonError('BAD_REQUEST', 400, 'リクエストの形式が不正です。');
  }

  const b = (body && typeof body === 'object' ? body : {}) as {
    question?: unknown;
    questionType?: unknown;
    turns?: unknown;
    answer?: unknown;
    knownFacts?: unknown;
    missingAxes?: unknown;
    // User Data Spine bridge（材料未選択時の fallback 用。未指定なら従来どおり）。
    profile?: CareerProfileInput | null;
    activity?: CareerActivityInput | null;
    values?: CareerValuesInput | null;
  };

  const question = str(b.question);
  if (!question) {
    return jsonError('INPUT_REQUIRED', 400, 'ES設問が指定されていません。');
  }
  // 種別はクライアント指定を優先し、無ければ設問文から推定する。
  const questionType: EsQuestionType =
    b.questionType === 'gakuchika' ||
    b.questionType === 'motivation' ||
    b.questionType === 'selfPr' ||
    b.questionType === 'research' ||
    b.questionType === 'other'
      ? b.questionType
      : classifyEsQuestionType(question);

  // 選択材料 context（未指定なら空 = 従来挙動）。
  const context: EsDeepDiveContext = {
    knownFacts: normalizeStringList(b.knownFacts, ES_KNOWN_FACTS_MAX_LINES, ES_KNOWN_FACTS_MAX_LINE_CHARS),
    // 観点 key は短い識別子。未知 key は builder 側が捨てる。
    missingAxes: normalizeStringList(b.missingAxes, 16, 40),
  };
  // 既知の観点が多いほど質問数上限を下げる（下限は ES_MIN_TURN_CAP）。
  const cap = esTurnCapForContext(questionType, context);

  const turns = normalizeTurns(b.turns);
  const answer = str(b.answer);
  const isSeed = turns.length === 0 && !answer;

  // 材料を 1 つも選んでいないユーザーにだけ背景 context を足す（選択済みなら '' ＝ byte 不変）。
  const fallbackBlock = await resolveEsFallbackContextBlock(
    (context.knownFacts ?? []).length > 0,
    b,
    req,
  );

  try {
    const system = [buildEsDeepSystem(question, questionType, context), fallbackBlock]
      .filter((s) => s !== '')
      .join('\n\n');

    // ── seed（1問目）─────────────────────────────────────────────
    if (isSeed) {
      const message = await anthropic.messages.create(
        {
          model: CAREER_ES_DEEP_MODEL,
          max_tokens: 400,
          temperature: 0.6,
          system,
          messages: [{ role: 'user', content: buildEsSeedUserPrompt(questionType, context) }],
        },
        { signal: createTimeoutSignal(QUESTION_AI_TIMEOUT_MS) },
      );
      const q = extractText(message.content as Array<{ type: string; text?: string }>);
      if (!q) {
        return jsonError('AI_ES_DEEP_EMPTY', 502, '質問の生成に失敗しました。もう一度お試しください。');
      }
      return Response.json({ reaction: '', question: q, done: false, cap, questionType });
    }

    // ── followup ─────────────────────────────────────────────────
    if (!answer) {
      return jsonError('EMPTY_ANSWER', 400, '回答を入力してください。');
    }
    if (answer.length > MAX_ANSWER_CHARS) {
      return jsonError('ANSWER_TOO_LONG', 413, '回答が長すぎます。少し短くしてお試しください。');
    }
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'question') {
      return jsonError('NO_PENDING_QUESTION', 409, '回答対象の質問が見つかりませんでした。画面を更新してお試しください。');
    }

    // 回答を加えた後の回答数。上限到達なら followup を生成せず done。
    const newAnswerCount = esCountAnswers(turns) + 1;
    if (newAnswerCount >= cap) {
      return Response.json({ done: true, reaction: '', question: null, cap, questionType });
    }

    const priorTurns: EsTurn[] = [...turns, { role: 'answer', content: answer }];

    const budget = createAiCallBudget({
      totalBudgetMs: QUESTION_AI_TOTAL_BUDGET_MS,
      perCallTimeoutMs: QUESTION_AI_TIMEOUT_MS,
      minRetryBudgetMs: QUESTION_AI_MIN_RETRY_BUDGET_MS,
    });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const callTimeoutMs = budget.nextCallTimeoutMs();
      // 残予算不足 → retry せず打ち切る（合計上限を超える前に JSON エラーを返す）。
      if (callTimeoutMs === null) {
        return jsonError('AI_ES_DEEP_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
      }
      const message = await anthropic.messages.create(
        {
          model: CAREER_ES_DEEP_MODEL,
          max_tokens: 500,
          temperature: attempt === 2 ? 0 : 0.6,
          system,
          messages: [
            { role: 'user', content: buildEsFollowupUserPrompt(questionType, priorTurns, context) },
          ],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';
      if (message.stop_reason === 'max_tokens') {
        return jsonError('AI_ES_DEEP_TRUNCATED', 502, 'AIの応答が途中で切れました。もう一度お試しください。');
      }

      try {
        const parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
        const q = str(parsed.question);
        if (!q) throw new Error('empty-question');
        return Response.json({
          reaction: str(parsed.reaction),
          question: q,
          done: false,
          cap,
          questionType,
        });
      } catch {
        if (attempt === 1) continue;
        return jsonError('AI_ES_DEEP_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
      }
    }

    return jsonError('AI_ES_DEEP_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
  } catch (error) {
    if (isAbortError(error)) {
      return jsonError('AI_TIMEOUT', 503, 'AIの応答に時間がかかっています。少し時間を置いてもう一度お試しください。');
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[career/es/deep]', msg.slice(0, 200));
    return jsonError(
      'AI_REQUEST_FAILED',
      500,
      isSeed ? '深掘りの開始に失敗しました。もう一度お試しください。' : '次の質問の生成に失敗しました。もう一度お試しください。',
    );
  }
}

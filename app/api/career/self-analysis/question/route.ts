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
import { createAiCallBudget, createTimeoutSignal, isAbortError } from '@/lib/aiTimeout';
import {
  CAREER_SELF_ANALYSIS_MODEL,
  CAREER_SELF_ANALYSIS_MAX_TURNS,
  buildDeepDiveBaseSystem,
  buildSeedUserPrompt,
  buildFollowupUserPrompt,
  countAnswers,
} from '../deepDivePrompt';
import { resolveSelfAnalysisContextInputs } from '../resolveContextInputs';
import { normalizeSelfAnalysisPastSummaries } from '@/lib/careerSelfAnalysis/pastLogSummary';

// P0（HARDENING）: 認証 identity / rate limit / 入力サイズ上限の共通ガード。
import { guardCareerAiRequest } from '@/lib/careerApi/requestGuard';
import { CAREER_AI_RATE_LIMITS } from '@/lib/rateLimit';
import { requireCareerAiAccess } from '@/lib/careerBilling/aiAccess';

export const maxDuration = 80;

const MAX_ANSWER_CHARS = 8000;

// 深掘り質問は max_tokens 400〜500 と軽く、通常 15 秒以内に返る。
// AI timeout を 30 秒に絞ることで、応答が遅い場合でも Vercel/モバイルSafari が接続を
// 切る前に必ず JSON エラーを返せる（＝スマホで raw な "Load failed" を出さない）。
const QUESTION_AI_TIMEOUT_MS = 30_000;
// 1 request で AI に使ってよい合計時間。上の「必ず 30 秒以内に JSON を返す」という不変条件は
// **合計**についての約束であり、client 側 QUESTION_TIMEOUT_MS=35s もその前提で決まっている。
// parse retry が満額 signal を再発行すると合計 60s となり client が先に abort して
// "時間内に応答がありませんでした（電波…）" という誤った network 文言が出ていた。
// 合計を per-call と同値に固定し、残予算から attempt の timeout を導出する。
const QUESTION_AI_TOTAL_BUDGET_MS = 30_000;
// max_tokens 500 の再生成に最低限必要な残予算（下回れば retry せず parse エラーを返す）。
const QUESTION_AI_MIN_RETRY_BUDGET_MS = 10_000;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 失敗時の共通 JSON レスポンス（形を統一: error=機械コード / code=同値 / detail=ユーザー向け日本語）。
function jsonError(code: string, status: number, detail: string) {
  return Response.json({ error: code, code, detail }, { status });
}

// 開発者向けの安全なログ。個人情報・入力全文・secret は出さず、件数と有無フラグのみ。
function logFailure(stage: string, meta: Record<string, unknown>, error?: unknown): void {
  const msg = error instanceof Error ? error.message : error ? String(error) : '';
  console.error('[career/self-analysis/question]', {
    stage,
    ...meta,
    ...(msg ? { error: msg.slice(0, 200) } : {}),
  });
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
  // P0（HARDENING）: 認証 identity / rate limit / body サイズ上限の共通ガード。
  //   ★ AI・prompt 構築より前に通す。429 ならここで返るので Anthropic コールは 0 回。
  const guard = await guardCareerAiRequest(req, {
    rules: {
      member: CAREER_AI_RATE_LIMITS.selfAnalysisQuestionMember,
      guest: CAREER_AI_RATE_LIMITS.selfAnalysisQuestionGuest,
    },
    label: 'self-analysis-question',
    badRequest: () => jsonError('BAD_REQUEST', 400, 'リクエストの形式が不正です。'),
  });
  if (!guard.ok) return guard.response;

  // 有料ゲート（PASSAI CAREER 単一プラン）。AI 到達前・Quota より前に必ず通す。
  //   guest / 未契約 / 契約状態が確認できない場合はここで終了し、AI コストを 0 にする。
  //   ★ Quota より前に置くのが必須（未契約者に Quota を消費させない）。
  const accessDenied = await requireCareerAiAccess(guard.identity);
  if (accessDenied) return accessDenied;
  const body = guard.body;

  const b = (body && typeof body === 'object' ? body : {}) as {
    profile?: CareerProfileInput | null;
    activity?: CareerActivityInput | null;
    values?: CareerValuesInput | null;
    turns?: unknown;
    answer?: unknown;
    pastSummaries?: unknown;
  };

  const turns = normalizeTurns(b.turns);
  const answer = str(b.answer);
  // 過去の自己分析ログ（軽量サマリ）。繰り返し回避・次テーマ選定に使う。無ければ空配列。
  const pastSummaries = normalizeSelfAnalysisPastSummaries(b.pastSummaries);

  // Closure Batch（`D-S9`）: base + pastSummaries を kind 単位で server / bridge から選ぶ。
  const ctx = await resolveSelfAnalysisContextInputs(
    'self_analysis_deep_dive',
    { profile: b.profile ?? null, activity: b.activity ?? null, values: b.values ?? null, pastSummaries },
    req,
  );

  // プロフィールも活動も無ければ深掘りの材料が無いので弾く（単発生成と同基準）。
  //   ★ readiness gate は resolver 解決後の値で判定する（server 由来でも同条件）。
  const hasProfile = !!ctx.profile && Object.keys(ctx.profile).length > 0;
  const hasActivity = !!ctx.activity && Object.keys(ctx.activity).length > 0;
  const hasValues = !!ctx.values && Object.keys(ctx.values).length > 0;
  const isSeed = turns.length === 0 && !answer;

  // 開発者ログ用の安全なメタ（件数・有無のみ。入力全文や個人情報は含めない）。
  const meta = {
    stageKind: isSeed ? 'seed' : 'followup',
    hasProfile,
    hasActivity,
    hasValues,
    turns: turns.length,
    answers: countAnswers(turns),
    pastSummaries: ctx.pastSummaries.length,
  };

  if (!hasProfile && !hasActivity) {
    return jsonError('INPUT_REQUIRED', 400, '基本情報または活動整理のいずれかを入力してください。');
  }

  // buildDeepDiveBaseSystem・AI 呼び出しをまとめて try で囲み、想定外の throw でも
  // 必ず JSON エラーを返す（非JSONな 500 → スマホで "Load failed" になるのを防ぐ）。
  try {
    const system = buildDeepDiveBaseSystem({
      profile: ctx.profile,
      activity: ctx.activity,
      values: ctx.values,
      pastSummaries: ctx.pastSummaries,
    });

    // ── seed（1問目）: turns 空かつ answer 無し ──────────────────────
    if (isSeed) {
      const message = await anthropic.messages.create(
        {
          model: CAREER_SELF_ANALYSIS_MODEL,
          max_tokens: 400,
          temperature: 0.6,
          system,
          messages: [{ role: 'user', content: buildSeedUserPrompt() }],
        },
        { signal: createTimeoutSignal(QUESTION_AI_TIMEOUT_MS) },
      );
      const question = extractText(
        message.content as Array<{ type: string; text?: string }>,
      );
      if (!question) {
        logFailure('seed-empty', meta);
        return jsonError('AI_SELF_ANALYSIS_EMPTY', 502, '質問の生成に失敗しました。もう一度お試しください。');
      }
      return Response.json({ reaction: '', question, done: false });
    }

    // ── followup（回答を踏まえた次の1問）─────────────────────────────
    if (!answer) {
      return jsonError('EMPTY_ANSWER', 400, '回答を入力してください。');
    }
    if (answer.length > MAX_ANSWER_CHARS) {
      return jsonError('ANSWER_TOO_LONG', 413, '回答が長すぎます。少し短くしてお試しください。');
    }
    // 直前に未回答の質問が必要（末尾が question）。
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'question') {
      return jsonError('NO_PENDING_QUESTION', 409, '回答対象の質問が見つかりませんでした。画面を更新してお試しください。');
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

    // parse 失敗時のみ 1 回だけ temperature 0 で再生成する（合計は budget 内に収める）。
    const budget = createAiCallBudget({
      totalBudgetMs: QUESTION_AI_TOTAL_BUDGET_MS,
      perCallTimeoutMs: QUESTION_AI_TIMEOUT_MS,
      minRetryBudgetMs: QUESTION_AI_MIN_RETRY_BUDGET_MS,
    });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const callTimeoutMs = budget.nextCallTimeoutMs();
      // 残予算不足 → retry せず打ち切る（client の 35s abort より先に JSON を返す）。
      if (callTimeoutMs === null) {
        logFailure('followup-parse', meta);
        return jsonError('AI_SELF_ANALYSIS_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
      }
      const message = await anthropic.messages.create(
        {
          model: CAREER_SELF_ANALYSIS_MODEL,
          max_tokens: 500,
          temperature: attempt === 2 ? 0 : 0.6,
          system,
          messages: [{ role: 'user', content: buildFollowupUserPrompt(priorTurns) }],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        logFailure('followup-truncated', meta);
        return jsonError('AI_SELF_ANALYSIS_TRUNCATED', 502, 'AIの応答が途中で切れました。もう一度お試しください。');
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
        logFailure('followup-parse', meta);
        return jsonError('AI_SELF_ANALYSIS_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
      }
    }

    return jsonError('AI_SELF_ANALYSIS_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
  } catch (error) {
    const timeout = isAbortError(error);
    logFailure(timeout ? 'ai-timeout' : 'ai-failed', meta, error);
    return timeout
      ? jsonError('AI_TIMEOUT', 503, 'AIの応答に時間がかかっています。少し時間を置いてもう一度お試しください。')
      : jsonError('AI_REQUEST_FAILED', 500, isSeed ? '深掘りの開始に失敗しました。もう一度お試しください。' : '次の質問の生成に失敗しました。もう一度お試しください。');
  }
}

// PASSAI 就活版 — 自己分析AI API。
//
// 2 経路を持つ:
//   - legacy 同期経路（pilot OFF / 明確な anonymous）: 従来どおり Claude 同期呼び出しで
//     JSON を返す。job table・課金・usage・DB には接続しない。
//   - job 経路（members pilot ON の authenticated member）: atomic claim → 202 即返し →
//     after() で background 生成 → fenced に DB 保存。詳細は lib/careerSelfAnalysis/summaryJobService。
//
// Step2 の対象は「POST を Claude 完了まで開かない」こと。client polling / recovery は Step3。

import 'server-only';

import { after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { anthropic, extractJson } from '@/lib/ai';
import {
  DEFAULT_AI_TIMEOUT_MS,
  createAiCallBudget,
  createTimeoutSignal,
  isAbortError,
} from '@/lib/aiTimeout';
import { getServerSupabaseClient } from '@/lib/supabase/serverClient';
import { getServiceRoleSupabaseClient } from '@/lib/supabase/serviceRoleClient';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import { normalizeSelfAnalysisPastSummaries } from '@/lib/careerSelfAnalysis/pastLogSummary';

import {
  SELF_ANALYSIS_FEATURE,
  SELF_ANALYSIS_MODEL,
  SELF_ANALYSIS_PROMPT_REVISION,
  SELF_ANALYSIS_OUTPUT_SCHEMA_REVISION,
  SELF_ANALYSIS_SUMMARY_OPERATION,
} from '@/lib/careerGenerationJob/constants';
import { buildSelfAnalysisIdentity } from '@/lib/careerGenerationJob/idempotency';
import {
  claimGenerationJob,
  completeGenerationJob,
  failGenerationJob,
  getOwnedGenerationJob,
} from '@/lib/careerGenerationJob/repository';
import {
  isSelfAnalysisJobPilotEnabled,
  isSelfAnalysisJobPilotEnabledForUser,
  isLocalOrTestEnv,
} from '@/lib/careerGenerationJob/flag.server';
import {
  buildSelfAnalysisMessages,
  normalizeConversation,
  normalizeResult,
  type SelfAnalysisSummaryInput,
} from '@/lib/careerSelfAnalysis/summaryPrompt';
import { resolveSelfAnalysisContextInputs } from './resolveContextInputs';
import {
  anthropicSelfAnalysisProvider,
} from '@/lib/careerSelfAnalysis/summaryProvider';
import {
  runSelfAnalysisGenerationAttempt,
  type AttemptLogEvent,
} from '@/lib/careerSelfAnalysis/summaryJobAttempt';
import {
  handleSelfAnalysisJobPost,
  type AuthResolution,
  type JobClaimLogEvent,
} from '@/lib/careerSelfAnalysis/summaryJobService';

// Node runtime を明示（Anthropic SDK / node:crypto / service-role）。
export const runtime = 'nodejs';
// invocation 全体の実行時間上限（Vercel Pro 前提）。
// Next の segment config は静的解析対象のため **リテラル必須**（import した定数は不可）。
// 値は constants.ROUTE_MAX_DURATION_SECONDS と一致させる（QA で不一致を検出）。
export const maxDuration = 300;

// legacy 同期経路の AI 合計時間予算（ms）。job 経路（PROVIDER_DEADLINE_MS=225s）とは別物で、
// legacy は client の AbortController（run/page.tsx GENERATE_TIMEOUT_MS=70s）が実効的な
// 外側境界になるため、そこに収まる 60s を合計上限とする。
const LEGACY_AI_TOTAL_BUDGET_MS = 60_000;
// max_tokens 4000 の再生成に最低限必要な残予算（下回れば retry せず parse エラーを返す）。
const LEGACY_AI_MIN_RETRY_BUDGET_MS = 25_000;

// 失敗時の共通 JSON レスポンス（legacy 用）。error=機械コード / code=同値 / detail=ユーザー向け。
function jsonError(code: string, status: number, detail: string) {
  return Response.json({ error: code, code, detail }, { status });
}

// 開発者向けの安全なログ。個人情報・入力全文・secret は出さない。
function logFailure(stage: string, meta: Record<string, unknown>, error?: unknown): void {
  const msg = error instanceof Error ? error.message : error ? String(error) : '';
  console.error('[career/self-analysis]', {
    stage,
    ...meta,
    ...(msg ? { error: msg.slice(0, 200) } : {}),
  });
}

// claim の安全な観測ログ（固定コード・数値・jobId のみ。userId / identity / 本文は出さない）。
// Gate B の B-01/B-02/B-03（legacy では job event 無し / canary では job event あり）の evidence 源。
function logClaim(event: JobClaimLogEvent): void {
  console.info('[career/self-analysis/job]', {
    stage: event.stage,
    outcome: event.outcome,
    attemptCount: event.attemptCount,
    status: event.status,
    jobId: event.jobId,
  });
}

// background attempt の安全な観測ログ（数値と固定コードのみ）。
function logAttempt(event: AttemptLogEvent): void {
  console.info('[career/self-analysis/job]', {
    stage: event.stage,
    applied: event.applied,
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    providerDurationMs: event.providerDurationMs,
    totalDurationMs: event.totalDurationMs,
  });
}

type ParsedBody = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  userInput: string;
  conversation: SelfAnalysisSummaryInput['conversation'];
  pastSummaries: SelfAnalysisSummaryInput['pastSummaries'];
};

function parseBody(body: unknown): ParsedBody {
  const b = (body && typeof body === 'object' ? body : {}) as {
    profile?: CareerProfileInput | null;
    activity?: CareerActivityInput | null;
    values?: CareerValuesInput | null;
    conversation?: unknown;
    userInput?: string;
    pastSummaries?: unknown;
  };
  return {
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    userInput: typeof b.userInput === 'string' ? b.userInput : '',
    conversation: normalizeConversation(b.conversation),
    pastSummaries: normalizeSelfAnalysisPastSummaries(b.pastSummaries),
  };
}

// ── legacy 同期経路（pilot OFF / 明確な anonymous のみ）──────────────
async function legacyGenerate(input: SelfAnalysisSummaryInput): Promise<Response> {
  const meta = {
    hasProfile: !!input.profile && Object.keys(input.profile).length > 0,
    hasActivity: !!input.activity && Object.keys(input.activity).length > 0,
    hasValues: !!input.values && Object.keys(input.values).length > 0,
    conversation: input.conversation.length,
    pastSummaries: input.pastSummaries.length,
  };

  if (!meta.hasProfile && !meta.hasActivity) {
    return jsonError('INPUT_REQUIRED', 400, '基本情報または活動整理のいずれかを入力してください。');
  }

  try {
    const { system, user } = buildSelfAnalysisMessages(input);

    let result: CareerSelfAnalysisResult | null = null;
    // legacy 経路の AI 合計時間予算。client（run/page.tsx GENERATE_TIMEOUT_MS=70s）は
    // 「サーバ 60s」を前提に決まっているが、parse retry が満額 signal を再発行すると
    // 合計 120s となり client が先に abort し、誤った network 文言が出ていた。
    // 合計を 60s に固定して client 側の前提を回復する（per-call の値は不変）。
    const budget = createAiCallBudget({
      totalBudgetMs: LEGACY_AI_TOTAL_BUDGET_MS,
      perCallTimeoutMs: DEFAULT_AI_TIMEOUT_MS,
      minRetryBudgetMs: LEGACY_AI_MIN_RETRY_BUDGET_MS,
    });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const callTimeoutMs = budget.nextCallTimeoutMs();
      // 残予算不足 → retry せず打ち切る（client abort より先に JSON エラーを返す）。
      if (callTimeoutMs === null) {
        logFailure('parse-failed', meta);
        return jsonError('AI_SELF_ANALYSIS_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
      }
      const message = await anthropic.messages.create(
        {
          model: SELF_ANALYSIS_MODEL,
          max_tokens: 4000,
          temperature: attempt === 2 ? 0 : 0.5,
          system,
          messages: [{ role: 'user', content: user }],
        },
        { signal: createTimeoutSignal(callTimeoutMs) },
      );

      const raw = message.content[0]?.type === 'text' ? message.content[0].text : '';

      if (message.stop_reason === 'max_tokens') {
        logFailure('truncated', meta);
        return jsonError('AI_SELF_ANALYSIS_TRUNCATED', 502, 'AIの応答が途中で切れました。もう一度お試しください。');
      }

      try {
        result = normalizeResult(JSON.parse(extractJson(raw)));
        break;
      } catch {
        if (attempt === 1) continue;
        logFailure('parse-failed', meta);
        return jsonError('AI_SELF_ANALYSIS_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
      }
    }

    if (!result) {
      logFailure('parse-failed', meta);
      return jsonError('AI_SELF_ANALYSIS_PARSE_FAILED', 502, 'AIの応答を解釈できませんでした。もう一度お試しください。');
    }

    return Response.json({ result });
  } catch (error) {
    const timeout = isAbortError(error);
    logFailure(timeout ? 'ai-timeout' : 'ai-failed', meta, error);
    return timeout
      ? jsonError('AI_TIMEOUT', 503, 'AIの応答に時間がかかっています。少し時間を置いてもう一度お試しください。')
      : jsonError('AI_REQUEST_FAILED', 500, '自己分析の生成に失敗しました。もう一度お試しください。');
  }
}

// ── auth 解決（auth 失敗 と 未ログイン を分離）──────────────────────
async function resolveMemberAuth(): Promise<AuthResolution> {
  let client;
  try {
    client = await getServerSupabaseClient();
  } catch {
    return { kind: 'auth_error' };
  }
  // pilot ON deployment で auth client が無いのは infra 未整備＝anonymous 扱いにしない。
  if (!client) return { kind: 'auth_error' };
  try {
    const { data, error } = await client.auth.getUser();
    if (error) return { kind: 'auth_error' };
    if (!data.user) return { kind: 'anonymous' };
    if (data.user.is_anonymous) return { kind: 'anonymous' };
    return { kind: 'member', userId: data.user.id };
  } catch {
    return { kind: 'auth_error' };
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('BAD_REQUEST', 400, 'リクエストの形式が不正です。');
  }

  const parsed = parseBody(body);
  // Closure Batch（`D-S9`）: base + pastSummaries を kind 単位で server / bridge から選ぶ。
  //   ★ ここで解決した値は job identity（idempotency hash）にも入る。verified ⟹ 内容一致
  //     なので hash は変わらない（未 verify 時は従来どおり body 由来）。
  //   ★ conversation / userInput は request 固有の入力であり Layer 1 source ではない（不変）。
  const ctx = await resolveSelfAnalysisContextInputs(
    'self_analysis',
    {
      profile: parsed.profile,
      activity: parsed.activity,
      values: parsed.values,
      pastSummaries: parsed.pastSummaries,
    },
    req,
  );
  const input: SelfAnalysisSummaryInput = {
    profile: ctx.profile,
    activity: ctx.activity,
    values: ctx.values,
    userInput: parsed.userInput,
    conversation: parsed.conversation,
    pastSummaries: ctx.pastSummaries,
  };

  return handleSelfAnalysisJobPost(
    {
      isPilotEnabledGlobally: isSelfAnalysisJobPilotEnabled,
      isPilotEnabledForUser: isSelfAnalysisJobPilotEnabledForUser,
      resolveAuth: resolveMemberAuth,
      getAdmin: () => {
        try {
          return { kind: 'ok', admin: getServiceRoleSupabaseClient() };
        } catch {
          return { kind: 'unavailable' };
        }
      },
      buildIdentity: ({ userId, input: i }) =>
        buildSelfAnalysisIdentity({
          userId,
          feature: SELF_ANALYSIS_FEATURE,
          operation: SELF_ANALYSIS_SUMMARY_OPERATION,
          profile: i.profile,
          activity: i.activity,
          values: i.values,
          conversation: i.conversation,
          promptRevision: SELF_ANALYSIS_PROMPT_REVISION,
          outputSchemaRevision: SELF_ANALYSIS_OUTPUT_SCHEMA_REVISION,
          model: SELF_ANALYSIS_MODEL,
        }),
      claimJob: (admin, args) => claimGenerationJob(admin as SupabaseClient, args),
      readJob: (admin, userId, jobId) =>
        getOwnedGenerationJob(admin as SupabaseClient, userId, { jobId }),
      schedule: (task) => after(task),
      runAttempt: (admin, params) =>
        runSelfAnalysisGenerationAttempt(
          {
            provider: anthropicSelfAnalysisProvider,
            completeJob: (a) => completeGenerationJob(admin as SupabaseClient, a),
            failJob: (a) => failGenerationJob(admin as SupabaseClient, a),
            createSignal: (ms) => AbortSignal.timeout(ms),
            now: () => Date.now(),
            log: logAttempt,
          },
          params,
        ),
      legacy: () => legacyGenerate(input),
      // default 禁止。非 production かつ明示 dev flag のときだけ undefined-table legacy fallback。
      allowDevUndefinedTableFallback: () =>
        isLocalOrTestEnv() && process.env.CAREER_SELF_ANALYSIS_JOB_DEV_FALLBACK === 'true',
      logClaim,
    },
    input,
  );
}

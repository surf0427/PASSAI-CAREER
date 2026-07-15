// 自己分析まとめ生成 — POST orchestration（Step2）。
//
// pilot flag / 認証 / claim outcome を判定し、Claude 完了を待たずに 202 を返す。
// 生成本体は scheduler（after/waitUntil）へ登録した runAttempt が担う。
//
// テスト容易性のため、副作用（auth/claim/read/schedule/runAttempt/legacy）はすべて DI する。
// route.ts は実 deps を組んで本関数を呼ぶだけにする。

import {
  SELF_ANALYSIS_FEATURE,
  SELF_ANALYSIS_SUMMARY_OPERATION,
  isRetryableErrorCode,
} from '@/lib/careerGenerationJob/constants';
import { GenerationJobStorageError } from '@/lib/careerGenerationJob/errors';
import type {
  GenerationJobClaimResult,
  GenerationJobIdentity,
  OwnedGenerationJob,
} from '@/lib/careerGenerationJob/types';
import type { SelfAnalysisSummaryInput } from './summaryPrompt';
import { hasUsableInput } from './summaryPrompt';

// ── 認証解決 ────────────────────────────────────────────────────────
export type AuthResolution =
  | { kind: 'member'; userId: string }
  | { kind: 'anonymous' }
  | { kind: 'auth_error' };

// ── admin 取得（service-role gateway）────────────────────────────────
export type AdminHandle = unknown;
export type AdminResolution =
  | { kind: 'ok'; admin: AdminHandle }
  | { kind: 'unavailable' };

export interface JobPostDeps {
  /** pilot が deployment 全体で ON か（OFF なら auth に触れず legacy）。 */
  isPilotEnabledGlobally: () => boolean;
  /** 指定 user に対し pilot 有効か（canary allowlist 反映）。 */
  isPilotEnabledForUser: (userId: string) => boolean;
  /** cookie/JWT からの member 認証解決（auth 失敗と未ログインを分離）。 */
  resolveAuth: () => Promise<AuthResolution>;
  /** service-role admin client の取得。 */
  getAdmin: () => AdminResolution;
  /** server-authoritative identity（idempotency key / revisions）算出。 */
  buildIdentity: (args: { userId: string; input: SelfAnalysisSummaryInput }) => GenerationJobIdentity;
  /** atomic claim RPC。 */
  claimJob: (admin: AdminHandle, args: {
    userId: string;
    feature: string;
    operation: string;
    identity: GenerationJobIdentity;
  }) => Promise<GenerationJobClaimResult>;
  /** owner-scoped read（cached/terminal 取得用）。 */
  readJob: (admin: AdminHandle, userId: string, jobId: string) => Promise<OwnedGenerationJob | null>;
  /** background 生成を scheduler（after/waitUntil）へ登録。response を await させない。 */
  schedule: (task: () => Promise<void>) => void;
  /** background 生成本体（admin 束縛済み）。 */
  runAttempt: (admin: AdminHandle, params: {
    userId: string;
    jobId: string;
    attemptToken: string;
    validatedInput: SelfAnalysisSummaryInput;
  }) => Promise<void>;
  /** legacy 同期経路（flag OFF / 明確な anonymous のみ）。 */
  legacy: () => Promise<Response>;
  /** 非 production かつ明示 dev fallback flag のときのみ true（default false）。 */
  allowDevUndefinedTableFallback: () => boolean;
}

// ── response builders（統一 contract）────────────────────────────────
const RUNNING_RETRY_AFTER_MS = 1000;

function respondRunning(jobId: string): Response {
  return Response.json({ status: 'running', jobId, retryAfterMs: RUNNING_RETRY_AFTER_MS }, { status: 202 });
}
function respondCompleted(jobId: string, result: unknown): Response {
  return Response.json({ status: 'completed', jobId, result: result ?? {} }, { status: 200 });
}
// job terminal（DB 由来）の failed 応答。retryable は DB 値を信用せず job error_code の
// server-side allowlist mapping で決める。
function respondFailed(jobId: string, errorCode: string, httpStatus: number): Response {
  return Response.json(
    { status: 'failed', jobId, errorCode, retryable: isRetryableErrorCode(errorCode) },
    { status: httpStatus },
  );
}
// infra 応答（DB へは保存しない response-only コード）。retryable は明示指定（server-authoritative）。
function respondInfra(errorCode: string, httpStatus: number, retryable: boolean): Response {
  return Response.json({ status: 'failed', errorCode, retryable }, { status: httpStatus });
}

/**
 * 自己分析まとめ生成 POST の中核。Claude 完了を await せず、
 * claim 後に 202/200/4xx/503 のいずれかを即返す。
 */
export async function handleSelfAnalysisJobPost(
  deps: JobPostDeps,
  input: SelfAnalysisSummaryInput,
): Promise<Response> {
  // (3.1) flag OFF は auth に触れず legacy を完全維持。
  if (!deps.isPilotEnabledGlobally()) return deps.legacy();

  // pilot ON: 認証を解決する。
  const auth = await deps.resolveAuth();

  // (3.3) auth 確認失敗は anonymous 扱いにせず、Claude を呼ばず retryable error。
  if (auth.kind === 'auth_error') {
    return respondInfra('AUTH_TEMPORARILY_UNAVAILABLE', 503, true);
  }
  // (3.2) 明確な anonymous のみ legacy。
  if (auth.kind === 'anonymous') return deps.legacy();

  const userId = auth.userId;

  // member だが canary 対象外 → legacy（job table 未使用）。
  if (!deps.isPilotEnabledForUser(userId)) return deps.legacy();

  // (3.4-2) request body validation（claim より前）。材料が無ければ非 retryable。
  if (!hasUsableInput(input.profile, input.activity)) {
    return respondInfra('INVALID_INPUT', 400, false);
  }

  // storage 取得。member+pilot ON で不能なら Claude を呼ばず 503（silent legacy 禁止）。
  const adminRes = deps.getAdmin();
  if (adminRes.kind !== 'ok') {
    return respondInfra('GENERATION_JOB_STORAGE_UNAVAILABLE', 503, true);
  }
  const admin = adminRes.admin;

  // (3.4-3/4) server-authoritative identity。
  const identity = deps.buildIdentity({ userId, input });

  // (3.4-5) atomic claim。
  let claim: GenerationJobClaimResult;
  try {
    claim = await deps.claimJob(admin, {
      userId,
      feature: SELF_ANALYSIS_FEATURE,
      operation: SELF_ANALYSIS_SUMMARY_OPERATION,
      identity,
    });
  } catch (error) {
    if (
      error instanceof GenerationJobStorageError &&
      error.reason === 'UNDEFINED_TABLE' &&
      deps.allowDevUndefinedTableFallback()
    ) {
      // 非 production かつ明示 dev flag のときのみ許可（default 禁止）。
      return deps.legacy();
    }
    return respondInfra('GENERATION_JOB_STORAGE_UNAVAILABLE', 503, true);
  }

  // (3.5) outcome 別。
  switch (claim.outcome) {
    case 'CLAIMED_NEW':
    case 'CLAIMED_RETRY': {
      const attemptToken = claim.attemptToken;
      if (!attemptToken) {
        // 生成を開始できない claim は storage 異常として扱う（Claude を呼ばない）。
        return respondInfra('GENERATION_JOB_STORAGE_UNAVAILABLE', 503, true);
      }
      // background 生成を登録して即 202（response は生成完了を await しない）。
      deps.schedule(() =>
        deps.runAttempt(admin, {
          userId,
          jobId: claim.jobId,
          attemptToken,
          validatedInput: input,
        }),
      );
      return respondRunning(claim.jobId);
    }

    case 'ALREADY_RUNNING':
      return respondRunning(claim.jobId);

    case 'ALREADY_COMPLETED': {
      try {
        const job = await deps.readJob(admin, userId, claim.jobId);
        return respondCompleted(claim.jobId, job?.result ?? {});
      } catch {
        return respondInfra('GENERATION_JOB_STORAGE_UNAVAILABLE', 503, true);
      }
    }

    case 'FAILED_NON_RETRYABLE': {
      try {
        const job = await deps.readJob(admin, userId, claim.jobId);
        const code = job?.errorCode ?? 'SCHEMA_VALIDATION_FAILED';
        return respondFailed(claim.jobId, code, 409);
      } catch {
        return respondInfra('GENERATION_JOB_STORAGE_UNAVAILABLE', 503, true);
      }
    }

    case 'RETRY_LIMIT_REACHED':
      return respondFailed(claim.jobId, 'RETRY_LIMIT_REACHED', 409);

    default:
      // 未知 outcome は生成せず storage 異常扱い（型上到達しない）。
      return respondInfra('GENERATION_JOB_STORAGE_UNAVAILABLE', 503, true);
  }
}

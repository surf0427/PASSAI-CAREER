/**
 * career generation job — server-side repository（STEP-CAREER-GENJOB-01）。
 *
 * 書き込み境界（要件 7/8）:
 *   - **admin（service_role）client のみ**が write する。cookie/JWT の auth client は流用しない。
 *   - 公開関数は必ず「サーバーで認証済みの userId」を明示的に受け取る。
 *     userId は request body / query / client 指定値から取ってはならない（呼び出し側の責務）。
 *   - claim は atomic RPC（career_generation_job_claim）に委譲。
 *   - completed/failed は attempt fencing（status=running AND attempt_token 一致 AND user_id 一致）
 *     でのみ適用。applied=false は lease を失った古い attempt＝結果破棄。
 *   - status read は owner-scoped（jobId/idempotency_key + userId 両方で絞る）。
 *
 * 本 module は route / status endpoint（後続 STEP）から使う。ここでは配線しない。
 */

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  NONRETRYABLE_ERROR_CODES,
} from './constants';
import { GenerationJobStorageError } from './errors';
import type {
  GenerationJobClaimArgs,
  GenerationJobClaimResult,
  GenerationJobCompleteArgs,
  GenerationJobFailArgs,
  GenerationJobStatus,
  GenerationJobUpdateResult,
  OwnedGenerationJob,
} from './types';

const TABLE = 'career_generation_jobs';
const CLAIM_FN = 'career_generation_job_claim';

// storage error 型は 'server-only' 非依存の errors.ts に置く（内部利用 + 後方互換 re-export）。
export { GenerationJobStorageError };
export type { GenerationJobStorageReason } from './errors';

/** Postgres「テーブル/関数未作成」= migration 未適用の検出。 */
function isUndefinedObject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === '42P01' || // undefined_table
    e.code === '42883' || // undefined_function
    (typeof e.message === 'string' &&
      /relation .* does not exist|function .* does not exist/i.test(e.message))
  );
}

function toStorageError(err: unknown, ctx: string): GenerationJobStorageError {
  if (isUndefinedObject(err)) {
    return new GenerationJobStorageError(
      'UNDEFINED_TABLE',
      `${ctx}: generation job storage not provisioned`,
    );
  }
  // raw provider/DB message は route へ伝播させない（PII/内部情報の露出防止）。
  return new GenerationJobStorageError('DB_ERROR', `${ctx}: storage error`);
}

/**
 * job を atomic に claim する。生成を開始してよいのは
 * outcome=CLAIMED_NEW / CLAIMED_RETRY のときだけ（attempt_token が返る）。
 */
export async function claimGenerationJob(
  admin: SupabaseClient,
  args: GenerationJobClaimArgs,
): Promise<GenerationJobClaimResult> {
  if (!args.userId) {
    throw new GenerationJobStorageError('DB_ERROR', 'claim: missing userId');
  }
  const { identity } = args;

  const { data, error } = await admin.rpc(CLAIM_FN, {
    p_user_id: args.userId,
    p_feature: args.feature,
    p_operation: args.operation,
    p_idempotency_key: identity.idempotencyKey,
    p_input_revision: identity.inputRevision,
    p_prompt_revision: identity.promptRevision,
    p_output_schema_revision: identity.outputSchemaRevision,
    p_model: identity.model,
    p_lease_seconds: LEASE_SECONDS,
    p_max_attempts: MAX_ATTEMPTS,
    p_nonretryable_codes: [...NONRETRYABLE_ERROR_CODES],
  });

  if (error) throw toStorageError(error, 'claim');

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new GenerationJobStorageError('DB_ERROR', 'claim: empty result');
  }

  return {
    outcome: row.outcome,
    jobId: row.job_id,
    attemptToken: row.attempt_token ?? null,
    status: row.status as GenerationJobStatus,
    attemptCount: typeof row.attempt_count === 'number' ? row.attempt_count : 0,
  };
}

/**
 * completed への fenced 更新。status=running AND attempt_token 一致 AND user_id 一致 のときのみ適用。
 * applied=false は古い attempt（lease を失った）＝結果を破棄する合図。
 */
export async function completeGenerationJob(
  admin: SupabaseClient,
  args: GenerationJobCompleteArgs,
): Promise<GenerationJobUpdateResult> {
  const { data, error } = await admin
    .from(TABLE)
    .update({
      status: 'completed',
      result: args.result ?? {},
      completed_at: new Date().toISOString(),
      error_code: null,
      failed_at: null,
      attempt_token: null,
      lease_expires_at: null,
      provider_duration_ms: args.providerDurationMs ?? null,
      total_duration_ms: args.totalDurationMs ?? null,
    })
    .eq('id', args.jobId)
    .eq('user_id', args.userId)
    .eq('status', 'running')
    .eq('attempt_token', args.attemptToken)
    .select('id');

  if (error) throw toStorageError(error, 'complete');
  return { applied: Array.isArray(data) && data.length === 1 };
}

/**
 * failed への fenced 更新。fencing 条件は complete と同一。
 * error_code は allowlist のみ（型で担保・raw provider message は入れない）。
 */
export async function failGenerationJob(
  admin: SupabaseClient,
  args: GenerationJobFailArgs,
): Promise<GenerationJobUpdateResult> {
  const { data, error } = await admin
    .from(TABLE)
    .update({
      status: 'failed',
      error_code: args.errorCode,
      failed_at: new Date().toISOString(),
      result: null,
      attempt_token: null,
      lease_expires_at: null,
      provider_duration_ms: args.providerDurationMs ?? null,
      total_duration_ms: args.totalDurationMs ?? null,
    })
    .eq('id', args.jobId)
    .eq('user_id', args.userId)
    .eq('status', 'running')
    .eq('attempt_token', args.attemptToken)
    .select('id');

  if (error) throw toStorageError(error, 'fail');
  return { applied: Array.isArray(data) && data.length === 1 };
}

type OwnedLookup = { jobId: string } | { idempotencyKey: string };

/**
 * owner-scoped read。必ず userId と (jobId | idempotency_key) の両方で絞る。
 * client 指定の user ID は受け取らない（呼び出し側が server 認証 userId を渡す）。
 */
export async function getOwnedGenerationJob(
  admin: SupabaseClient,
  userId: string,
  lookup: OwnedLookup,
): Promise<OwnedGenerationJob | null> {
  if (!userId) return null;

  let query = admin
    .from(TABLE)
    .select(
      'id, feature, operation, status, result, error_code, attempt_count, created_at, updated_at',
    )
    .eq('user_id', userId);

  query =
    'jobId' in lookup
      ? query.eq('id', lookup.jobId)
      : query.eq('idempotency_key', lookup.idempotencyKey);

  const { data, error } = await query.maybeSingle();
  if (error) throw toStorageError(error, 'read');
  if (!data) return null;

  return {
    id: data.id,
    feature: data.feature,
    operation: data.operation,
    status: data.status as GenerationJobStatus,
    result: data.result ?? null,
    errorCode: data.error_code ?? null,
    attemptCount: typeof data.attempt_count === 'number' ? data.attempt_count : 0,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

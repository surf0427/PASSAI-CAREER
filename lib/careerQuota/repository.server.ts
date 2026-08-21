/**
 * PASSAI CAREER — daily quota の durable store 境界（server-only）。
 *
 * 権威は Supabase（Project B）の `career_daily_quota_consume` RPC。
 * check と consume を 1 statement 内で原子的に決めるため、複数の Vercel インスタンス
 * にまたがっても上限を追い越せない（process-local Map は使わない）。
 *
 * ★ userId は **必ず server session 由来**の値だけを渡す（client 申告値を渡さない）。
 * ★ 実 user_id / operation の元データはログに出さない（feature / outcome のみ）。
 */

import 'server-only';

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

import type { CareerDailyQuotaFeature } from './limits';

export const CAREER_DAILY_USAGE_TABLE = 'career_daily_usage';
export const CAREER_DAILY_USAGE_OPERATIONS_TABLE = 'career_daily_usage_operations';
export const CAREER_DAILY_QUOTA_CONSUME_FN = 'career_daily_quota_consume';
export const CAREER_DAILY_QUOTA_SETTLE_FN = 'career_daily_quota_settle';

export type CareerQuotaConsumeOutcome = 'CONSUMED' | 'DEDUPED' | 'LIMIT_REACHED';

export type CareerQuotaConsumeResult =
  | {
      kind: 'ok';
      outcome: CareerQuotaConsumeOutcome;
      used: number;
      limit: number;
      resetAtMs: number;
    }
  /** career_daily_quota_apply.sql が未適用（table / function が無い）。 */
  | { kind: 'not-provisioned' }
  | { kind: 'db-error'; message: string };

/** undefined table (42P01) / undefined function (42883) を「未適用」として扱う。 */
function isNotProvisioned(error: PostgrestError | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (code === '42P01' || code === '42883' || code === 'PGRST202') return true;
  const message = `${error.message ?? ''}`.toLowerCase();
  return (
    message.includes('does not exist') &&
    (message.includes('relation') || message.includes('function'))
  );
}

type ConsumeRow = {
  outcome?: unknown;
  used_count?: unknown;
  limit_count?: unknown;
  reset_at?: unknown;
};

function toOutcome(value: unknown): CareerQuotaConsumeOutcome | null {
  return value === 'CONSUMED' || value === 'DEDUPED' || value === 'LIMIT_REACHED'
    ? value
    : null;
}

/**
 * 利用回数の原子的な check + consume。
 *
 * dedupe されるのは「実行中（in_flight）の同一 operation への再送」だけ。
 * settle 済みの同一 operation が再び来た場合は、ユーザーによる明示的な再実行として
 * 新しく 1 回消費する（判定は RPC 側。TS は状態を持たない）。
 */
export async function consumeCareerDailyQuota(
  admin: SupabaseClient,
  input: {
    userId: string;
    feature: CareerDailyQuotaFeature;
    operationId: string;
    limit: number;
    leaseSeconds: number;
    maxDedupeHits: number;
  },
): Promise<CareerQuotaConsumeResult> {
  const { data, error } = await admin.rpc(CAREER_DAILY_QUOTA_CONSUME_FN, {
    p_user_id: input.userId,
    p_feature: input.feature,
    p_operation_id: input.operationId,
    p_limit: input.limit,
    p_lease_seconds: input.leaseSeconds,
    p_max_dedupe_hits: input.maxDedupeHits,
  });

  if (error) {
    if (isNotProvisioned(error)) return { kind: 'not-provisioned' };
    return { kind: 'db-error', message: error.message ?? 'quota consume failed' };
  }

  const row = (Array.isArray(data) ? data[0] : data) as ConsumeRow | null | undefined;
  const outcome = toOutcome(row?.outcome);
  if (!row || !outcome) {
    return { kind: 'db-error', message: 'quota consume: unexpected result shape' };
  }

  const used = Number(row.used_count);
  const limit = Number(row.limit_count);
  const resetAtMs = row.reset_at ? new Date(String(row.reset_at)).getTime() : NaN;

  return {
    kind: 'ok',
    outcome,
    used: Number.isFinite(used) ? used : 0,
    limit: Number.isFinite(limit) ? limit : input.limit,
    resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : Date.now(),
  };
}

/**
 * 実行が **成功して返し終わった**ことを記録する（冪等 / never throw）。
 *
 * これ以降、同じ operation id で来た request は「ユーザーが明示的に実行し直した」と
 * みなされ、新しく 1 回消費される。
 *
 * ★ 失敗した実行では呼ばない。in_flight のまま残すことで、ユーザーの再試行が
 *   二重課金にならない（放置された in_flight は RPC 側の lease で回収される）。
 */
export async function settleCareerDailyQuota(
  admin: SupabaseClient,
  input: { userId: string; feature: CareerDailyQuotaFeature; operationId: string },
): Promise<{ kind: 'ok' } | { kind: 'not-provisioned' } | { kind: 'db-error'; message: string }> {
  const { error } = await admin.rpc(CAREER_DAILY_QUOTA_SETTLE_FN, {
    p_user_id: input.userId,
    p_feature: input.feature,
    p_operation_id: input.operationId,
  });
  if (error) {
    if (isNotProvisioned(error)) return { kind: 'not-provisioned' };
    return { kind: 'db-error', message: error.message ?? 'quota settle failed' };
  }
  return { kind: 'ok' };
}

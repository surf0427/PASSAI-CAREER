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
 * @param operationIds 同一操作とみなす id の候補列（[0] が canonical）。
 */
export async function consumeCareerDailyQuota(
  admin: SupabaseClient,
  input: {
    userId: string;
    feature: CareerDailyQuotaFeature;
    operationIds: readonly string[];
    limit: number;
  },
): Promise<CareerQuotaConsumeResult> {
  const { data, error } = await admin.rpc(CAREER_DAILY_QUOTA_CONSUME_FN, {
    p_user_id: input.userId,
    p_feature: input.feature,
    p_operation_ids: [...input.operationIds],
    p_limit: input.limit,
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

/**
 * PASSAI CAREER — daily quota の **route 側入口**（server-only）。
 *
 * 使い方（anchor route の中で 1 回だけ）:
 *   const quota = await enforceCareerDailyQuota({
 *     identity: guard.identity, feature: 'es', operationSource: body,
 *   });
 *   if (quota) return quota;   // 429 DAILY_LIMIT_REACHED（AI は 1 度も呼ばない）
 *
 * 呼ぶ位置（Phase 16 の failure semantics）:
 *   - **AI provider へ request を出す前**、かつ
 *   - **server validation（body 不正 / 必須入力欠落 / feature flag OFF / auth 失敗）の後**。
 *     → 検証で落ちる request は quota を消費しない。
 *   - AI へ送信済みの request は原則消費する（API 原価が発生しているため）。
 *     ただし同一 operation の retry は operation dedupe により二重消費しない。
 *
 * 既存の burst rate limit（lib/rateLimit）とは **別レイヤー**。短時間の連打防御はそちら、
 * 商品仕様としての 1 日の利用回数は本 module。両方を通す。
 *
 * ★ ENTITLEMENT_INTEGRATION_REQUIRED（既知の限界・意図的に未解決）:
 *   CAREER の AI route は guest 利用を正式に許可しており（401 で閉じない設計）、
 *   guest には user_id が無いため本 quota の対象にできない。したがって現状
 *   「member には日次上限があるが guest には無い」。guest を突然禁止するのは
 *   今回のスコープ外（商品仕様の変更）なので、**仕様変更はせず**に限界として記録する。
 *   同様に plan（free / basic / premium）別の出し分けも行わず、member 全員に
 *   BASIC の上限を適用する（現状 repo に plan gate は 1 つも配線されていない）。
 */

import 'server-only';

import { getCareerServiceRoleSupabaseClient } from '@/lib/careerSupabase/serviceRoleClient';
import type { CareerRequestIdentity } from '@/lib/careerApi/requestGuard';

import {
  CAREER_DAILY_QUOTA_DEDUPE_WINDOW_SECONDS,
  CAREER_DAILY_QUOTA_LABELS,
  careerQuotaJstResetAtMs,
  getCareerDailyLimit,
  type CareerDailyQuotaFeature,
} from './limits';
import { buildCareerQuotaOperationIds } from './operationId';
import { consumeCareerDailyQuota } from './repository.server';

/**
 * quota を無効化する escape hatch（**local / test / CI 用**）。
 * 既定は「有効」なので、設定し忘れで本番が silent no-op になることはない。
 * 既存の `CAREER_GD_RATE_LIMIT_DISABLED` と同じ思想・同じ受理値。
 */
export function isCareerDailyQuotaDisabled(): boolean {
  const v = process.env.CAREER_DAILY_QUOTA_DISABLED;
  return v === '1' || v === 'true';
}

/** 上限到達時の共通レスポンス（machine-readable + 既存 client 契約の `detail`）。 */
export function careerDailyLimitReachedResponse(input: {
  feature: CareerDailyQuotaFeature;
  limit: number;
  used: number;
  resetAtMs: number;
  nowMs?: number;
}): Response {
  const nowMs = input.nowMs ?? Date.now();
  const retryAfterSeconds = Math.max(1, Math.ceil((input.resetAtMs - nowMs) / 1000));
  const label = CAREER_DAILY_QUOTA_LABELS[input.feature];
  // 既存 CAREER client は一貫して `data.detail ?? '<既定文言>'` を読む。
  // detail に理由を載せることで、UI を一切変えずに「なぜ止まったか」が伝わる。
  const detail =
    `本日の${label}の利用回数（${input.limit}回）に達しました。` +
    `日本時間の翌日0:00になると、また利用できます。`;

  return Response.json(
    {
      error: 'DAILY_LIMIT_REACHED',
      code: 'DAILY_LIMIT_REACHED',
      feature: input.feature,
      limit: input.limit,
      used: input.used,
      remaining: 0,
      resetAt: new Date(input.resetAtMs).toISOString(),
      detail,
      message: detail,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
        'X-Career-Quota-Feature': input.feature,
        'X-Career-Quota-Limit': String(input.limit),
        'X-Career-Quota-Remaining': '0',
        'X-Career-Quota-Reset': String(Math.floor(input.resetAtMs / 1000)),
      },
    },
  );
}

// store 障害 / DDL 未適用の警告は 1 プロセス 1 回だけ出す（ログ汚染を防ぐ）。
let warnedNotProvisioned = false;

/**
 * 日次利用回数の check + consume。上限到達なら 429 Response、続行してよければ null。
 *
 * fail-open（可用性優先）にしている経路と、その理由:
 *   - `CAREER_DAILY_QUOTA_DISABLED` … 明示的な無効化。
 *   - guest（user_id 無し）        … 上記 ENTITLEMENT_INTEGRATION_REQUIRED。
 *   - DDL 未適用 / service_role 未設定 / DB エラー
 *       … 「上限が数えられない」を理由に有料ユーザーの機能を止めない。既存 rate limit の
 *         member 経路（fail-open）と同じ判断。濫用面（未認証・短時間連打）は burst rate limit
 *         が別レイヤーで塞いでおり、そちらは guest fail-closed のまま維持している。
 *     ★ 本番で quota を実効化するには `supabase/career_daily_quota_apply.sql` の適用が必要。
 *       未適用のあいだは警告ログが 1 度出る（silent no-op にしない）。
 */
export async function enforceCareerDailyQuota(params: {
  identity: CareerRequestIdentity;
  feature: CareerDailyQuotaFeature;
  /** operation を一意に決める server 側の素材（通常は parse 済み request body）。 */
  operationSource: unknown;
  nowMs?: number;
}): Promise<Response | null> {
  if (isCareerDailyQuotaDisabled()) return null;
  if (params.identity.kind !== 'member') return null;

  const feature = params.feature;
  const limit = getCareerDailyLimit(feature);
  const nowMs = params.nowMs ?? Date.now();

  const operationIds = buildCareerQuotaOperationIds({
    feature,
    source: params.operationSource,
    windowSeconds: CAREER_DAILY_QUOTA_DEDUPE_WINDOW_SECONDS[feature],
    nowMs,
  });

  let admin;
  try {
    admin = getCareerServiceRoleSupabaseClient();
  } catch {
    if (!warnedNotProvisioned) {
      warnedNotProvisioned = true;
      console.warn(
        'career daily quota: service_role 未設定のため日次上限を適用できません（fail-open）。',
      );
    }
    return null;
  }

  const result = await consumeCareerDailyQuota(admin, {
    userId: params.identity.userId,
    feature,
    operationIds,
    limit,
  });

  if (result.kind === 'not-provisioned') {
    if (!warnedNotProvisioned) {
      warnedNotProvisioned = true;
      console.warn(
        'career daily quota: career_daily_quota_apply.sql が未適用のため日次上限を適用できません（fail-open）。',
      );
    }
    return null;
  }
  if (result.kind === 'db-error') {
    // user_id / operation の実値は出さない。feature とメッセージのみ。
    console.warn(
      `career daily quota: consume failed feature=${feature} (request allowed / fail-open)`,
    );
    return null;
  }

  if (result.outcome === 'LIMIT_REACHED') {
    console.warn(
      `career daily quota reached: feature=${feature} limit=${result.limit} used=${result.used}`,
    );
    return careerDailyLimitReachedResponse({
      feature,
      limit: result.limit,
      used: result.used,
      resetAtMs: Number.isFinite(result.resetAtMs)
        ? result.resetAtMs
        : careerQuotaJstResetAtMs(nowMs),
      nowMs,
    });
  }

  return null;
}

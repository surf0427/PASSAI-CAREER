/**
 * PASSAI CAREER — daily quota の **route 側入口**（server-only）。
 *
 * 使い方（anchor route の中で 1 回だけ）:
 *   const quota = await enforceCareerDailyQuota({
 *     identity: guard.identity, feature: 'es', operationSource: body,
 *   });
 *   if (quota.blocked) return quota.blocked;  // 429（AI は 1 度も呼ばない）
 *   ...
 *   await quota.settle();                     // ★ 成功して返す直前にだけ呼ぶ
 *   return Response.json({ review });
 *
 * ★ settle の意味論（本 module の中核）:
 *   dedupe を「同じ入力なら永久に同一 operation」にすると、ユーザーが明示的に
 *   「もう一度添削 / 再分析 / 再評価」しても消費されず、同じ内容を繰り返すだけで
 *   上限を無限に迂回できてしまう。そこで operation は実行状態を持つ:
 *     in_flight（実行中）への再送 … retry / 二重送信 / timeout 後の再送 → +0
 *     settled（成功して返し終えた）後の同一入力 … 明示的な再実行        → +1
 *   したがって settle は **成功パスでだけ**呼ぶ。失敗した実行を settle しないことで、
 *   ユーザーの再試行が二重課金にならない（放置された in_flight は lease で回収）。
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
 * ★ entitlement との関係（2026-08-21 の商品決定で解決済み）:
 *   本 module へ到達する時点で、request は既に有料ゲート
 *   （lib/careerBilling/aiAccess.ts）を通過している。したがって:
 *     - guest / 未契約は quota に**到達しない**（＝ quota を消費しない）
 *     - quota を数える対象は「有効な契約を持つ member」だけ
 *   PASSAI CAREER は単一の有料プランなので、plan 別の上限出し分けは存在しない。
 *   下の guest 判定は「順序を間違えて guest が来ても消費しない」ための保険である。
 */

import 'server-only';

import { getCareerServiceRoleSupabaseClient } from '@/lib/careerSupabase/serviceRoleClient';
import type { CareerRequestIdentity } from '@/lib/careerApi/requestGuard';

import {
  CAREER_DAILY_QUOTA_LABELS,
  CAREER_QUOTA_LEASE_SECONDS,
  CAREER_QUOTA_MAX_DEDUPE_HITS,
  careerQuotaJstResetAtMs,
  getCareerDailyLimit,
  type CareerDailyQuotaFeature,
} from './limits';
import { buildCareerQuotaOperationId } from './operationId';
import { consumeCareerDailyQuota, settleCareerDailyQuota } from './repository.server';

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

function warnOnce(message: string): void {
  if (warnedNotProvisioned) return;
  warnedNotProvisioned = true;
  console.warn(message);
}

/**
 * 日次利用回数の check + consume。上限到達なら 429 Response、続行してよければ null。
 *
 * fail-open（可用性優先）にしている経路と、その理由:
 *   - `CAREER_DAILY_QUOTA_DISABLED` … 明示的な無効化。
 *   - guest（user_id 無し）        … 有料ゲートで既に弾かれている（保険の no-op）。
 *   - DDL 未適用 / service_role 未設定 / DB エラー
 *       … 「上限が数えられない」を理由に有料ユーザーの機能を止めない。既存 rate limit の
 *         member 経路（fail-open）と同じ判断。濫用面（未認証・短時間連打）は burst rate limit
 *         が別レイヤーで塞いでおり、そちらは guest fail-closed のまま維持している。
 *     ★ 本番で quota を実効化するには `supabase/career_daily_quota_apply.sql` の適用が必要。
 *       未適用のあいだは警告ログが 1 度出る（silent no-op にしない）。
 */
/**
 * quota gate の戻り値。
 *
 * `blocked` が非 null なら 429 をそのまま返す（AI へ到達させない）。
 * 通過した場合は、**成功して返す直前**に `settle()` を呼ぶ。
 */
export type CareerQuotaGate = {
  /** 上限到達時の 429 レスポンス。通過時は null。 */
  blocked: Response | null;
  /** 実行成功の記録（冪等 / never throw）。失敗パスでは呼ばない。 */
  settle: () => Promise<void>;
};

const NOOP_GATE: CareerQuotaGate = { blocked: null, settle: async () => {} };

/**
 * 日次利用回数の check + consume。
 *
 * fail-open（可用性優先）にしている経路と、その理由:
 *   - `CAREER_DAILY_QUOTA_DISABLED` … 明示的な無効化。
 *   - guest（user_id 無し）        … 有料ゲートで既に弾かれている（保険の no-op）。
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
}): Promise<CareerQuotaGate> {
  if (isCareerDailyQuotaDisabled()) return NOOP_GATE;
  if (params.identity.kind !== 'member') return NOOP_GATE;

  const feature = params.feature;
  const userId = params.identity.userId;
  const limit = getCareerDailyLimit(feature);
  const nowMs = params.nowMs ?? Date.now();
  const operationId = buildCareerQuotaOperationId(feature, params.operationSource);

  let admin;
  try {
    admin = getCareerServiceRoleSupabaseClient();
  } catch {
    warnOnce('career daily quota: service_role 未設定のため日次上限を適用できません（fail-open）。');
    return NOOP_GATE;
  }

  const result = await consumeCareerDailyQuota(admin, {
    userId,
    feature,
    operationId,
    limit,
    leaseSeconds: CAREER_QUOTA_LEASE_SECONDS,
    maxDedupeHits: CAREER_QUOTA_MAX_DEDUPE_HITS,
  });

  if (result.kind === 'not-provisioned') {
    warnOnce(
      'career daily quota: career_daily_quota_apply.sql が未適用のため日次上限を適用できません（fail-open）。',
    );
    return NOOP_GATE;
  }
  if (result.kind === 'db-error') {
    // user_id / operation の実値は出さない。feature とメッセージのみ。
    console.warn(
      `career daily quota: consume failed feature=${feature} (request allowed / fail-open)`,
    );
    return NOOP_GATE;
  }

  if (result.outcome === 'LIMIT_REACHED') {
    console.warn(
      `career daily quota reached: feature=${feature} limit=${result.limit} used=${result.used}`,
    );
    return {
      blocked: careerDailyLimitReachedResponse({
        feature,
        limit: result.limit,
        used: result.used,
        resetAtMs: Number.isFinite(result.resetAtMs)
          ? result.resetAtMs
          : careerQuotaJstResetAtMs(nowMs),
        nowMs,
      }),
      settle: async () => {},
    };
  }

  // CONSUMED / DEDUPED はどちらも「実行してよい」。settle も同じ扱いでよい
  // （DEDUPED は先行実行と同じ operation なので、どちらが settle しても意味は同じ）。
  return {
    blocked: null,
    settle: async () => {
      try {
        const settled = await settleCareerDailyQuota(admin, { userId, feature, operationId });
        if (settled.kind === 'db-error') {
          console.warn(`career daily quota: settle failed feature=${feature}`);
        }
      } catch {
        // never throw: settle の失敗で成功レスポンスを壊さない。
        // 記録できなかった in_flight は RPC 側の lease で回収される。
        console.warn(`career daily quota: settle threw feature=${feature}`);
      }
    },
  };
}

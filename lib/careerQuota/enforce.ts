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
 * ★ fail-closed（2026-08-22 / Project B へ quota schema 適用済み・実 DB smoke 完了後に切替）:
 *   quota が数えられない状態で AI を実行すると、上限が静かに消えたまま原価だけが出る。
 *   したがって **quota infrastructure の失敗はすべて 503 で止める**:
 *     DDL 未適用 / service_role 未設定 / DB・RPC エラー / 想定外の例外
 *   → いずれも AI provider へは 1 度も到達しない。
 *   「上限に達した（429）」と「上限を数えられない（503）」は必ず別物として扱う。
 *
 * ★ entitlement との関係（2026-08-21 の商品決定で解決済み）:
 *   本 module へ到達する時点で、request は既に有料ゲート
 *   （lib/careerBilling/aiAccess.ts）を通過している。したがって:
 *     - guest / 未契約は quota に**到達しない**（＝ quota を消費しない）
 *     - quota を数える対象は「有効な契約を持つ member」だけ
 *   PASSAI CAREER は単一の有料プランなので、plan 別の上限出し分けは存在しない。
 *   下の member 判定は「順序を間違えて guest が来た」ことを検出する保険であり、
 *   その場合も **通さず 503**（誰の分として数えるか決められないため）。
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
 *
 * ★ 既定（未設定）は必ず「有効」。'1' / 'true' を **明示的に**入れたときだけ無効になるので、
 *   env の設定し忘れで本番が silent no-op になることはない。
 *   既存の `CAREER_GD_RATE_LIMIT_DISABLED` と同じ思想・同じ受理値。
 * ★ 本番で有効化されていたら警告を出す（気付かないまま上限が消えている状態を作らない）。
 */
export function isCareerDailyQuotaDisabled(): boolean {
  const v = process.env.CAREER_DAILY_QUOTA_DISABLED;
  const disabled = v === '1' || v === 'true';
  if (disabled && !warnedDisabledInProduction) {
    const isProd =
      process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
    if (isProd) {
      warnedDisabledInProduction = true;
      console.warn(
        'career daily quota: CAREER_DAILY_QUOTA_DISABLED が production で有効です。日次上限は適用されません。',
      );
    }
  }
  return disabled;
}

let warnedDisabledInProduction = false;

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

/**
 * quota を数えられなかった理由。**server ログでの切り分け用**であり、
 * client には返さない（内部構成を推測させない / §7 no-leak）。
 */
export type CareerQuotaFailureReason =
  | 'not-provisioned'      // career_daily_quota_apply.sql 未適用（table / RPC が無い）
  | 'service-role-missing' // CAREER_SUPABASE_SERVICE_ROLE_KEY 未設定
  | 'db-error'             // DB / RPC / ネットワークのエラー
  | 'unexpected'           // repository が想定外に throw した
  | 'identity-missing';    // member でない identity が quota まで来た（順序バグの保険）

const QUOTA_UNAVAILABLE_DETAIL =
  'ただいま一時的にご利用いただけません。時間をおいて再度お試しください。';

/**
 * quota infrastructure が使えないときの共通レスポンス（**fail-closed**）。
 *
 * ★ 429（上限到達）とは必ず別物にする。上限に達したのではなく「数えられない」ので、
 *   再試行の意味も UI の出し方も違う。
 * ★ 失敗理由は body に載せない。Supabase の error / table 名 / RPC 名 / secret も載せない。
 */
export function careerQuotaUnavailableResponse(): Response {
  return Response.json(
    {
      error: 'QUOTA_UNAVAILABLE',
      code: 'QUOTA_UNAVAILABLE',
      detail: QUOTA_UNAVAILABLE_DETAIL,
      message: QUOTA_UNAVAILABLE_DETAIL,
    },
    { status: 503, headers: { 'Retry-After': '60' } },
  );
}

/** 原因を切り分け可能な形で記録する（secret / user_id / operation は出さない）。 */
function logQuotaFailure(feature: CareerDailyQuotaFeature, reason: CareerQuotaFailureReason): void {
  console.error(
    `career daily quota unavailable: feature=${feature} reason=${reason} (request BLOCKED / fail-closed)`,
  );
}

/**
 * quota gate の戻り値。
 *
 * `blocked` が非 null なら 429 をそのまま返す（AI へ到達させない）。
 * 通過した場合は、**成功して返す直前**に `settle()` を呼ぶ。
 */
export type CareerQuotaGate = {
  /** 止めるべきときの Response（429 = 上限到達 / 503 = 数えられない）。通過時は null。 */
  blocked: Response | null;
  /** 実行成功の記録（冪等 / never throw）。失敗パスでは呼ばない。 */
  settle: () => Promise<void>;
};

const NOOP_GATE: CareerQuotaGate = { blocked: null, settle: async () => {} };

/** quota 評価の結果（I/O を含まない表現）。 */
export type CareerQuotaEvaluation =
  | { kind: 'ok'; outcome: 'CONSUMED' | 'DEDUPED' | 'LIMIT_REACHED'; used: number; limit: number; resetAtMs: number }
  | { kind: 'failure'; reason: CareerQuotaFailureReason };

/**
 * 評価結果 → 「通す / 止める」の決定（**純関数**）。
 *
 * I/O を持たないので QA から全分岐を直接検証できる（失敗注入に mock が要らない）。
 * ここが fail-closed の唯一の判断点であり、route 側は結果をそのまま返すだけ。
 */
export function decideCareerQuotaGate(input: {
  feature: CareerDailyQuotaFeature;
  evaluation: CareerQuotaEvaluation;
  nowMs: number;
}): { blocked: Response | null } {
  const { feature, evaluation, nowMs } = input;

  // quota を数えられない → AI を実行しない（503）。
  if (evaluation.kind === 'failure') {
    return { blocked: careerQuotaUnavailableResponse() };
  }

  // 上限に到達した → 429（数えられてはいる）。
  if (evaluation.outcome === 'LIMIT_REACHED') {
    return {
      blocked: careerDailyLimitReachedResponse({
        feature,
        limit: evaluation.limit,
        used: evaluation.used,
        resetAtMs: Number.isFinite(evaluation.resetAtMs)
          ? evaluation.resetAtMs
          : careerQuotaJstResetAtMs(nowMs),
        nowMs,
      }),
    };
  }

  // CONSUMED / DEDUPED はどちらも実行してよい。
  return { blocked: null };
}

/**
 * 日次利用回数の check + consume。
 *
 * 戻り値の `blocked` が非 null なら **その Response をそのまま返す**（AI へ進まない）:
 *   429 … 本日の上限に到達
 *   503 … quota を数えられない（DDL 未適用 / service_role 未設定 / DB エラー / 想定外）
 * 通過した場合は、成功して返す直前に `settle()` を呼ぶ。
 */
export async function enforceCareerDailyQuota(params: {
  identity: CareerRequestIdentity;
  feature: CareerDailyQuotaFeature;
  /** operation を一意に決める server 側の素材（通常は parse 済み request body）。 */
  operationSource: unknown;
  nowMs?: number;
}): Promise<CareerQuotaGate> {
  // ★ 明示的な無効化のみ no-op（未設定なら必ず有効）。
  if (isCareerDailyQuotaDisabled()) return NOOP_GATE;

  const feature = params.feature;
  const nowMs = params.nowMs ?? Date.now();

  // 順序バグの保険。有料ゲートを通っていれば member 以外はここへ来ない。
  //   来てしまった場合は「誰の分として数えるか決められない」ので fail-closed。
  if (params.identity.kind !== 'member') {
    logQuotaFailure(feature, 'identity-missing');
    return { blocked: careerQuotaUnavailableResponse(), settle: async () => {} };
  }

  const userId = params.identity.userId;
  const limit = getCareerDailyLimit(feature);
  const operationId = buildCareerQuotaOperationId(feature, params.operationSource);

  let admin;
  try {
    admin = getCareerServiceRoleSupabaseClient();
  } catch {
    logQuotaFailure(feature, 'service-role-missing');
    return { blocked: careerQuotaUnavailableResponse(), settle: async () => {} };
  }

  // repository が想定外に throw しても AI へ進ませない。
  let result;
  try {
    result = await consumeCareerDailyQuota(admin, {
      userId,
      feature,
      operationId,
      limit,
      leaseSeconds: CAREER_QUOTA_LEASE_SECONDS,
      maxDedupeHits: CAREER_QUOTA_MAX_DEDUPE_HITS,
    });
  } catch {
    logQuotaFailure(feature, 'unexpected');
    return { blocked: careerQuotaUnavailableResponse(), settle: async () => {} };
  }

  const evaluation: CareerQuotaEvaluation =
    result.kind === 'ok'
      ? { kind: 'ok', outcome: result.outcome, used: result.used, limit: result.limit, resetAtMs: result.resetAtMs }
      : { kind: 'failure', reason: result.kind === 'not-provisioned' ? 'not-provisioned' : 'db-error' };

  if (evaluation.kind === 'failure') logQuotaFailure(feature, evaluation.reason);

  const decision = decideCareerQuotaGate({ feature, evaluation, nowMs });
  if (decision.blocked) {
    if (evaluation.kind === 'ok') {
      console.warn(
        `career daily quota reached: feature=${feature} limit=${evaluation.limit} used=${evaluation.used}`,
      );
    }
    return { blocked: decision.blocked, settle: async () => {} };
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

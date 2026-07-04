// PASSAI — 汎用 rate limit ユーティリティ（STEP-GD-20-K）。
//
// - key（user_id 等）は hash 化してから store に渡す（生値を store/ログに残さない）。
// - namespace で機能別に分離。複数 window（短期・中期）を同時チェックし、どれか超過で 429。
// - 429 response は安定した JSON（`error: 'RATE_LIMITED'`）＋ Retry-After / X-RateLimit-* header。
// - `CAREER_GD_RATE_LIMIT_DISABLED=1|true` で無効化（**local/test/CI 用**。本番では設定しない）。
//   既定は「有効」なので、本番で silent no-op にはならない。
//
// server-only。将来 ES/面接/プレゼンでも再利用できるよう汎用寄りにしている。

import 'server-only';
import { createHash } from 'node:crypto';
import { getRateLimitStore } from './store';

export type RateLimitWindow = { limit: number; windowSeconds: number };

export type RateLimitRule = { namespace: string; windows: readonly RateLimitWindow[] };

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // unix seconds（このウインドウがリセットされる時刻）
  retryAfterSeconds: number;
};

// key の実値を store/ログに残さないため SHA-256 の先頭 20 桁に短縮して使う。
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 20);
}

export function isRateLimitDisabled(): boolean {
  const v = process.env.CAREER_GD_RATE_LIMIT_DISABLED;
  return v === '1' || v === 'true';
}

// 単一 window の固定ウインドウカウンタ。nowMs はテスト用に注入可能。
export async function checkRateLimit(params: {
  key: string;
  limit: number;
  windowSeconds: number;
  namespace: string;
  nowMs?: number;
}): Promise<RateLimitResult> {
  const nowMs = params.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const bucket = Math.floor(nowSec / params.windowSeconds);
  const storeKey = `${params.namespace}:${hashKey(params.key)}:${bucket}`;
  const resetAt = (bucket + 1) * params.windowSeconds;

  let count: number;
  try {
    count = await getRateLimitStore().incr(storeKey, params.windowSeconds, nowMs);
  } catch {
    // store 障害時は可用性を優先して通す（namespace のみログ・key は出さない）。
    console.warn(`rate limit store error: namespace=${params.namespace} (request allowed)`);
    return { allowed: true, limit: params.limit, remaining: params.limit, resetAt, retryAfterSeconds: 0 };
  }

  const allowed = count <= params.limit;
  const remaining = Math.max(0, params.limit - count);
  const retryAfterSeconds = allowed ? 0 : Math.max(1, resetAt - nowSec);
  return { allowed, limit: params.limit, remaining, resetAt, retryAfterSeconds };
}

// 複数 window を全てチェック。どれか超過で allowed=false（最初に超過した window を返す）。
// 無効化時は store に触れず allowed を返す。
export async function checkRateLimits(params: {
  key: string;
  rule: RateLimitRule;
  nowMs?: number;
}): Promise<{ allowed: boolean; result: RateLimitResult }> {
  const { windows, namespace } = params.rule;
  if (isRateLimitDisabled()) {
    const w = windows[0];
    return {
      allowed: true,
      result: { allowed: true, limit: w?.limit ?? 0, remaining: w?.limit ?? 0, resetAt: 0, retryAfterSeconds: 0 },
    };
  }

  let blocked: RateLimitResult | null = null;
  let tightest: RateLimitResult | null = null;
  for (const w of windows) {
    const r = await checkRateLimit({
      key: params.key,
      limit: w.limit,
      windowSeconds: w.windowSeconds,
      namespace,
      nowMs: params.nowMs,
    });
    if (!r.allowed && !blocked) blocked = r; // 最初に引っかかった window を採用
    if (!tightest || r.remaining < tightest.remaining) tightest = r;
  }
  if (blocked) return { allowed: false, result: blocked };
  return { allowed: true, result: tightest ?? { allowed: true, limit: 0, remaining: 0, resetAt: 0, retryAfterSeconds: 0 } };
}

// 429 レスポンス（secret/PII/user_id/room_id を含めない安定 JSON）。
const RATE_LIMITED_MESSAGE = '短時間に操作が集中しています。少し待ってからもう一度お試しください。';

export function rateLimitedResponse(result: RateLimitResult): Response {
  return Response.json(
    { error: 'RATE_LIMITED', message: RATE_LIMITED_MESSAGE, detail: RATE_LIMITED_MESSAGE, retryAfterSeconds: result.retryAfterSeconds },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfterSeconds),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(result.resetAt),
      },
    },
  );
}

// route 用ショートカット: key（user_id）と rule を受け、超過なら 429 Response、許可なら null。
export async function enforceRateLimit(key: string, rule: RateLimitRule): Promise<Response | null> {
  const { allowed, result } = await checkRateLimits({ key, rule });
  if (allowed) return null;
  // key の実値は出さない。namespace / limit / retryAfter のみ。
  console.warn(`GD rate limited: namespace=${rule.namespace} limit=${result.limit} retryAfterSec=${result.retryAfterSeconds}`);
  return rateLimitedResponse(result);
}

// ── GD ロビー/合言葉の rate limit ルール（正本） ────────────────
export const CAREER_GD_RATE_LIMITS = {
  // 公開ロビー create: 3/分・10/時（同一 host 再create=reused でも連打負荷があるため対象）。
  lobbyCreate: {
    namespace: 'career_gd_lobby_create',
    windows: [{ limit: 3, windowSeconds: 60 }, { limit: 10, windowSeconds: 3600 }],
  },
  // 公開ロビー join: 10/分・30/時（冪等でも連打負荷を避ける）。
  lobbyJoin: {
    namespace: 'career_gd_lobby_join',
    windows: [{ limit: 10, windowSeconds: 60 }, { limit: 30, windowSeconds: 3600 }],
  },
  // 合言葉 create: 5/分・20/時。
  inviteCreate: {
    namespace: 'career_gd_invite_create',
    windows: [{ limit: 5, windowSeconds: 60 }, { limit: 20, windowSeconds: 3600 }],
  },
  // 合言葉 join: 10/分・40/時。
  inviteJoin: {
    namespace: 'career_gd_invite_join',
    windows: [{ limit: 10, windowSeconds: 60 }, { limit: 40, windowSeconds: 3600 }],
  },
} as const satisfies Record<string, RateLimitRule>;

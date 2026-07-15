// 自己分析まとめ生成 — client polling/recovery 定数（Step3）。
//
// fake timer QA を可能にするため、すべて定数化しここで一元管理する。
// server 側 lease / maxDuration の複製定数は持たない（stale 判定は server の recoveryAction に従う）。

// pending slot（owner 単位で key を分ける）。
export const PENDING_VERSION = 1 as const;
export const PENDING_KEY_PREFIX = 'careerSelfAnalysisPendingJob:v1:' as const;

// polling 間隔（server の retryAfterMs をこの範囲へ clamp）。
export const MIN_POLL_MS = 1_000 as const;
export const MAX_POLL_MS = 10_000 as const;

// transport（network / 一時 503 / POST 応答不明）の backoff。
export const TRANSPORT_BASE_MS = 1_000 as const;
export const TRANSPORT_BACKOFF_MULTIPLIER = 2 as const;
export const TRANSPORT_MAX_MS = 10_000 as const;
// 同一 session 内の POST 不明 → 自動 resubmit の上限回数（無限ループ防止）。
export const MAX_TRANSPORT_RESUBMIT = 5 as const;

// active polling の上限（これを超えたら pending は消さず「再確認」状態へ）。
// route maxDuration(300s) + lease(360s) を考慮し、余裕を持って打ち切る。
export const MAX_ACTIVE_POLL_MS = 360_000 as const;
export const MAX_ACTIVE_POLLS = 200 as const;

/** server retryAfterMs を安全な [MIN, MAX] へ clamp する。 */
export function clampPollDelay(retryAfterMs: unknown): number {
  const n = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : MIN_POLL_MS;
  if (n < MIN_POLL_MS) return MIN_POLL_MS;
  if (n > MAX_POLL_MS) return MAX_POLL_MS;
  return n;
}

/** transport backoff（attempt は 0 始まり）。 */
export function transportBackoffMs(attempt: number): number {
  const ms = TRANSPORT_BASE_MS * Math.pow(TRANSPORT_BACKOFF_MULTIPLIER, Math.max(0, attempt));
  return Math.min(ms, TRANSPORT_MAX_MS);
}

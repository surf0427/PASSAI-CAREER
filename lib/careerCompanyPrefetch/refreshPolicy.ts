/**
 * Company Prefetch — job 台帳の **再取得ライフサイクル** policy（pure・決定論・never-throw）。
 *
 * なぜこの module が要るか（本 slice で直した事故の本体）:
 *   company-scoped idempotency key は `company_id + task + fetcher_revision + schema_revision`
 *   から作られ、**時間の成分を持たない**（`idempotency.ts`）。よって 1 度 completed になった
 *   job 行は natural key が永久に同じままで、claim RPC が `ALREADY_COMPLETED` を返し続けた。
 *   結果として TTL が切れても外部取得が二度と走らず、`fetcher_revision` を上げる
 *   **コード変更でしか**再取得できない状態だった。
 *
 *   dedupe（同時実行を 1 回に畳む）と、将来の正当な TTL refresh の禁止は **別物**である。
 *   ここでは前者を保ったまま後者だけを解く:
 *
 *     running（lease 有効）        → 常に ALREADY_RUNNING（＝ N 人 → 1 job は不変）
 *     terminal から cooldown 経過  → **新しい取得サイクル**として再 claim できる
 *     cooldown 未経過              → 従来どおり取得しない（毎 request で外部に出ない）
 *
 * 本 module は SQL 関数 `career_company_enrichment_job_claim` の分岐と **1:1 で対応**する。
 * SQL 側を変えたらここも変える（drift は `scripts/career-company-prefetch-ttl-qa.ts` が固定する）。
 * ここに I/O は書かない（判定のみ）。
 */

import { COMPANY_FACT_TTL_SECONDS } from '@/lib/careerCompanyOfficial/freshness';
import { PREFETCH_FACT_GROUPS } from '@/types/careerCompanyOfficial';
import {
  FAILURE_COOLDOWN_SECONDS,
  MAX_ATTEMPTS,
  NONRETRYABLE_ERROR_CODES,
  REFRESH_COOLDOWN_SECONDS,
} from './constants';

/** job 台帳の status（DDL の CHECK と同一）。 */
export type CompanyJobStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed';

/** claim 判定に必要な既存行の状態（DB の列と 1:1）。 */
export type CompanyJobLedgerState = {
  status: CompanyJobStatus;
  attemptCount: number;
  /** ISO。running のときだけ非 null。 */
  leaseExpiresAt: string | null;
  /** ISO。completed / partial のときだけ非 null。 */
  completedAt: string | null;
  /** ISO。failed のときだけ非 null。 */
  failedAt: string | null;
  errorCode: string | null;
};

export type CompanyJobClaimOutcome =
  | 'CLAIMED_NEW'
  | 'CLAIMED_RETRY'
  /** ★ 追加: TTL 経過後の **新しい取得サイクル**（attempt 予算をリセットして再取得する）。 */
  | 'CLAIMED_REFRESH'
  | 'ALREADY_RUNNING'
  | 'ALREADY_COMPLETED'
  | 'FAILED_NON_RETRYABLE'
  | 'RETRY_LIMIT_REACHED';

export type CompanyJobClaimDecision = {
  outcome: CompanyJobClaimOutcome;
  /** claim できたときに行へ書く attempt_count（できなければ現在値）。 */
  attemptCount: number;
  /** 取得を開始してよいか（＝ attempt_token を発行するか）。 */
  claimed: boolean;
};

export type CompanyRefreshPolicyParams = {
  maxAttempts: number;
  /** completed（全 group 取得済み）からの再取得サイクル最短間隔（秒）。 */
  refreshCooldownSeconds: number;
  /** partial / failed からの再試行サイクル最短間隔（秒）。 */
  failureCooldownSeconds: number;
  nonRetryableCodes: readonly string[];
};

export const DEFAULT_REFRESH_POLICY: CompanyRefreshPolicyParams = {
  maxAttempts: MAX_ATTEMPTS,
  refreshCooldownSeconds: REFRESH_COOLDOWN_SECONDS,
  failureCooldownSeconds: FAILURE_COOLDOWN_SECONDS,
  nonRetryableCodes: NONRETRYABLE_ERROR_CODES,
};

/** ISO → epoch ms（不正なら null）。never-throw。 */
function toEpochMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * prefetch 対象 group のうち **最短の TTL**（秒）。
 *
 * ★ `REFRESH_COOLDOWN_SECONDS` はこの値と一致していなければならない。
 *   DB 側の cooldown が freshness policy より長いと、
 *   「呼び出し側は stale と判定したのに DB が claim を拒む」＝ 再取得できない状態に戻る。
 */
export function minPrefetchTtlSeconds(): number {
  return PREFETCH_FACT_GROUPS.reduce(
    (min, g) => Math.min(min, COMPANY_FACT_TTL_SECONDS[g]),
    Number.POSITIVE_INFINITY,
  );
}

/** cooldown が freshness policy を追い越していないか（QA が固定する不変条件）。 */
export function refreshCooldownIsConsistent(
  params: CompanyRefreshPolicyParams = DEFAULT_REFRESH_POLICY,
): boolean {
  return (
    params.refreshCooldownSeconds <= minPrefetchTtlSeconds() &&
    params.failureCooldownSeconds > 0 &&
    params.failureCooldownSeconds <= params.refreshCooldownSeconds
  );
}

/** terminal（completed / partial / failed）になった時刻。terminal でなければ null。 */
export function terminalAtIso(state: CompanyJobLedgerState): string | null {
  if (state.status === 'completed' || state.status === 'partial') return state.completedAt;
  if (state.status === 'failed') return state.failedAt;
  return null;
}

/**
 * その terminal 状態に対して適用する cooldown（秒）。
 *
 *   completed        → データの TTL（＝ 再取得サイクル）
 *   partial / failed → 失敗 cooldown（短い。ただし毎 request では出ない）
 */
export function cooldownSecondsFor(
  state: CompanyJobLedgerState,
  params: CompanyRefreshPolicyParams = DEFAULT_REFRESH_POLICY,
): number {
  return state.status === 'completed'
    ? params.refreshCooldownSeconds
    : params.failureCooldownSeconds;
}

/**
 * 「新しい取得サイクルを開いてよいか」。
 *
 * ★ 境界は `>=`（cooldown ちょうどで開く）。
 *   freshness 側は `age <= TTL` を fresh とする（`classifyGroupFreshness`）ため、
 *   呼び出し側が stale と判定する瞬間には DB 側は必ず開いている。
 *   この非対称が「stale なのに claim できない」窓を消している。
 */
export function isRefreshCycleDue(
  state: CompanyJobLedgerState,
  nowIso: string,
  params: CompanyRefreshPolicyParams = DEFAULT_REFRESH_POLICY,
): boolean {
  const terminalAt = toEpochMs(terminalAtIso(state));
  const now = toEpochMs(nowIso);
  if (terminalAt === null || now === null) return false;
  return now - terminalAt >= cooldownSecondsFor(state, params) * 1000;
}

/** lease を失った running 行か（＝ 別 attempt が落ちた）。 */
function isLeaseExpired(state: CompanyJobLedgerState, nowIso: string): boolean {
  if (state.status !== 'running') return false;
  const lease = toEpochMs(state.leaseExpiresAt);
  const now = toEpochMs(nowIso);
  if (lease === null || now === null) return false;
  return lease <= now;
}

/**
 * 既存 job 行に対する claim 判定（**SQL 関数の分岐と同順**）。
 *
 *   1. running かつ lease 有効        → ALREADY_RUNNING   （★ 同時実行の収束点。最優先）
 *   2. terminal かつ cooldown 経過    → CLAIMED_REFRESH   （★ TTL 後の再取得。attempt を 1 へ戻す）
 *   3. completed                      → ALREADY_COMPLETED
 *   4. failed かつ non-retryable      → FAILED_NON_RETRYABLE
 *   5. attempt_count >= max           → RETRY_LIMIT_REACHED
 *   6. それ以外                       → CLAIMED_RETRY     （同一サイクル内の再試行）
 *
 * 1 が 2 より前であることが重要（実行中の job を refresh で横取りしない）。
 */
export function decideCompanyJobClaim(
  state: CompanyJobLedgerState,
  nowIso: string,
  params: CompanyRefreshPolicyParams = DEFAULT_REFRESH_POLICY,
): CompanyJobClaimDecision {
  const attemptCount = Number.isFinite(state.attemptCount) ? state.attemptCount : 0;

  if (state.status === 'running' && !isLeaseExpired(state, nowIso)) {
    return { outcome: 'ALREADY_RUNNING', attemptCount, claimed: false };
  }

  if (isRefreshCycleDue(state, nowIso, params)) {
    // ★ 新しいサイクル: attempt 予算を戻す。
    //   戻さないと「過去に 3 回失敗した企業」が TTL 後も永久に取得不能なままになる。
    return { outcome: 'CLAIMED_REFRESH', attemptCount: 1, claimed: true };
  }

  if (state.status === 'completed') {
    return { outcome: 'ALREADY_COMPLETED', attemptCount, claimed: false };
  }

  if (
    state.status === 'failed' &&
    typeof state.errorCode === 'string' &&
    params.nonRetryableCodes.includes(state.errorCode)
  ) {
    return { outcome: 'FAILED_NON_RETRYABLE', attemptCount, claimed: false };
  }

  if (attemptCount >= params.maxAttempts) {
    return { outcome: 'RETRY_LIMIT_REACHED', attemptCount, claimed: false };
  }

  return { outcome: 'CLAIMED_RETRY', attemptCount: attemptCount + 1, claimed: true };
}

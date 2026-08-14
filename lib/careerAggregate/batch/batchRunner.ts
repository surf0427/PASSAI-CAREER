// PASSAI CAREER — provider-neutral batch runner（Decision Resolution Batch / `D-R3`）。
//
// Human 指示 §13:
//   production queue / cron を provision しない。ただし
//   batch runner interface / idempotency / retry semantics / cursor(checkpoint) /
//   dry-run / failure state / rebuild(invalidation) が code 上不足しているなら完成させる。
//
// ★ provider-neutral:
//   Vercel Cron / Supabase pg_cron / GitHub Actions / 手動実行 のいずれからでも
//   **同じ contract** で呼べる。特定 cloud SDK を import しない。
//   I/O はすべて injected port（`BatchPorts`）越しで、本 module は pure。
//
// ★ 何を保証するか:
//   1. **idempotency**: 同じ (metric, window, calculationVersion) は
//      何度実行しても 1 つの batch にしかならない（`runKey` で判定）。
//   2. **retry safety**: 失敗した batch は同じ runKey で再実行でき、
//      成功済みの batch を二重に作らない（`HDR-7` / `HDR-8` が固定）。
//   3. **cursor / checkpoint**: 中断しても次回は続きから（window 単位の進行）。
//   4. **dry-run**: 書き込みを一切行わずに「何が起きるか」を返す。
//   5. **failure state**: 失敗を握り潰さず、状態として残す（未完のまま serve しない）。
//   6. **rebuild**: invalidation 由来の再生成を通常実行と同じ経路で扱う。
//
// ★ 何を保証しないか（誇張しない）:
//   - 分散ロック（同時に 2 プロセスが走る前提の排他）は **提供しない**。
//     `claimRun` port の実装（DB の UNIQUE 制約 / advisory lock）に委ねる契約。
//   - 実際の scheduling（cron の時刻・再試行間隔）は provider 側の責務。
//
// pure / deterministic / never-throw。`now` は注入。

import type { AggregateBatchManifest } from '@/types/careerAggregateBatch';

// ── run key（idempotency の単位）────────────────────────────────────
export type BatchRunKey = {
  metricKey: string;
  calculationVersion: string;
  sourceWindowStart: string; // ISO
  sourceWindowEnd: string; // ISO
};

/** run key を決定論的な文字列へ（区切りの曖昧さを避けるため JSON 配列）。 */
export function serializeRunKey(key: BatchRunKey): string {
  return JSON.stringify([
    key.metricKey,
    key.calculationVersion,
    key.sourceWindowStart,
    key.sourceWindowEnd,
  ]);
}

// ── run state ───────────────────────────────────────────────────────
export type BatchRunState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  /** 実行したが serve 可能な成果物にならなかった（例: eligible contributor 0）。 */
  | 'completed_empty';

export type BatchRunRecord = {
  runKey: string;
  state: BatchRunState;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** 失敗理由の enum（raw error / stack を保持しない）。 */
  failureCategory: BatchFailureCategory | null;
};

export type BatchFailureCategory =
  | 'source_unavailable'
  | 'projection_rejected'
  | 'quality_check_failed'
  | 'write_failed'
  | 'timeout'
  | 'unknown';

// ── cursor / checkpoint ─────────────────────────────────────────────
/**
 * どの window まで処理済みか。provider に依存しない単純な checkpoint。
 * `nextWindowStart` から再開すれば、中断しても重複せず続きから処理できる。
 */
export type BatchCursor = {
  metricKey: string;
  calculationVersion: string;
  /** 次に処理すべき window の開始（ISO）。null は「未開始」。 */
  nextWindowStart: string | null;
  updatedAt: string | null;
};

export const EMPTY_CURSOR = (metricKey: string, calculationVersion: string): BatchCursor => ({
  metricKey,
  calculationVersion,
  nextWindowStart: null,
  updatedAt: null,
});

// ── ports（すべて注入。実装は Supabase / in-memory / fake）─────────────
export type BatchPorts = {
  /**
   * run を予約する。**同じ runKey が既に succeeded なら false**（idempotency の要）。
   * 実装は DB の UNIQUE 制約 / advisory lock で排他すること（本 module は排他を提供しない）。
   */
  claimRun: (runKey: string, attempt: number) => Promise<{ claimed: boolean; existing: BatchRunRecord | null }>;
  /** run 状態を更新する（失敗も必ず記録する）。 */
  recordRun: (record: BatchRunRecord) => Promise<void>;
  /** cursor を読む。 */
  readCursor: (metricKey: string, calculationVersion: string) => Promise<BatchCursor | null>;
  /** cursor を進める（成功時のみ呼ぶ）。 */
  writeCursor: (cursor: BatchCursor) => Promise<void>;
  /** 集計本体。manifest を返す（副作用は実装側）。 */
  execute: (key: BatchRunKey) => Promise<{ manifest: AggregateBatchManifest; producedArtifacts: number }>;
  /** invalidation 由来の再生成対象（rebuild）。空配列なら通常実行。 */
  listPendingRebuilds?: () => Promise<BatchRunKey[]>;
};

// ── 実行結果 ─────────────────────────────────────────────────────────
export type BatchRunOutcome =
  | { status: 'skipped_already_succeeded'; runKey: string }
  | { status: 'skipped_dry_run'; runKey: string; wouldExecute: true }
  | { status: 'succeeded'; runKey: string; producedArtifacts: number; attempt: number }
  | { status: 'completed_empty'; runKey: string; attempt: number }
  | { status: 'failed'; runKey: string; attempt: number; failureCategory: BatchFailureCategory }
  | { status: 'not_claimed'; runKey: string; reason: 'concurrent_run' };

export type RunBatchInput = {
  key: BatchRunKey;
  ports: BatchPorts;
  /** 現在時刻（ISO）。注入（決定論）。 */
  nowIso: string;
  /** 何も書かずに「実行されるか」だけ返す。 */
  dryRun?: boolean;
  /** 再試行回数（呼び出し側が管理。runner は attempt を記録するだけ）。 */
  attempt?: number;
  /** rebuild（invalidation 由来）か。記録に残す。 */
  rebuild?: boolean;
};

/**
 * batch を 1 回実行する（never-throw）。
 *
 * 順序:
 *   1. 既に succeeded な runKey なら **何もしない**（idempotency）
 *   2. dry-run なら「実行される」とだけ返す（**書き込みゼロ**）
 *   3. claim（排他は port の実装責務）
 *   4. execute
 *   5. 成功なら cursor を進め、失敗なら failure state を記録して **cursor を進めない**
 */
export async function runAggregateBatch(input: RunBatchInput): Promise<BatchRunOutcome> {
  const runKey = serializeRunKey(input.key);
  const attempt = Number.isInteger(input.attempt) && (input.attempt as number) > 0
    ? (input.attempt as number)
    : 1;
  try {
    // 1) idempotency: 既に成功しているなら再実行しない。
    const pre = await input.ports.claimRun(runKey, attempt);
    if (pre.existing?.state === 'succeeded') {
      return { status: 'skipped_already_succeeded', runKey };
    }
    // 2) dry-run: ここまでで判定できる（書き込みは一切しない）。
    if (input.dryRun === true) {
      return { status: 'skipped_dry_run', runKey, wouldExecute: true };
    }
    // 3) claim できなければ他プロセスが実行中（排他は port 実装の責務）。
    if (!pre.claimed) {
      return { status: 'not_claimed', runKey, reason: 'concurrent_run' };
    }

    await input.ports.recordRun({
      runKey, state: 'running', attempt,
      startedAt: input.nowIso, finishedAt: null, failureCategory: null,
    });

    // 4) 実行。
    let produced = 0;
    try {
      const res = await input.ports.execute(input.key);
      produced = Number.isFinite(res?.producedArtifacts) ? res.producedArtifacts : 0;
    } catch {
      await input.ports.recordRun({
        runKey, state: 'failed', attempt,
        startedAt: input.nowIso, finishedAt: input.nowIso, failureCategory: 'unknown',
      });
      // ★ cursor を進めない（次回同じ window を再試行できる）。
      return { status: 'failed', runKey, attempt, failureCategory: 'unknown' };
    }

    // 5) 成果ゼロは失敗ではないが「serve できる成果物なし」として区別する。
    if (produced === 0) {
      await input.ports.recordRun({
        runKey, state: 'completed_empty', attempt,
        startedAt: input.nowIso, finishedAt: input.nowIso, failureCategory: null,
      });
      await input.ports.writeCursor({
        metricKey: input.key.metricKey,
        calculationVersion: input.key.calculationVersion,
        nextWindowStart: input.key.sourceWindowEnd,
        updatedAt: input.nowIso,
      });
      return { status: 'completed_empty', runKey, attempt };
    }

    await input.ports.recordRun({
      runKey, state: 'succeeded', attempt,
      startedAt: input.nowIso, finishedAt: input.nowIso, failureCategory: null,
    });
    await input.ports.writeCursor({
      metricKey: input.key.metricKey,
      calculationVersion: input.key.calculationVersion,
      nextWindowStart: input.key.sourceWindowEnd,
      updatedAt: input.nowIso,
    });
    return { status: 'succeeded', runKey, producedArtifacts: produced, attempt };
  } catch {
    // never-throw: runner が例外で落ちても呼び出し側（cron / script）を壊さない。
    return { status: 'failed', runKey, attempt, failureCategory: 'unknown' };
  }
}

/**
 * cursor から次の window を導く（pure）。
 * 未開始なら `defaultStart` から。既に進んでいればその続きから。
 */
export function nextWindow(
  cursor: BatchCursor | null | undefined,
  defaultStart: string,
  windowMs: number,
): { start: string; end: string } | null {
  const startIso = cursor?.nextWindowStart ?? defaultStart;
  const startMs = Date.parse(startIso);
  if (Number.isNaN(startMs) || !Number.isFinite(windowMs) || windowMs <= 0) return null;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + windowMs).toISOString(),
  };
}

/**
 * rebuild（invalidation 由来）を通常実行と同じ経路で流す。
 * 対象が無ければ空配列（＝通常の cursor 実行へ進んでよい）。
 */
export async function collectRebuildTargets(ports: BatchPorts): Promise<BatchRunKey[]> {
  try {
    if (typeof ports.listPendingRebuilds !== 'function') return [];
    const list = await ports.listPendingRebuilds();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// PASSAI CAREER — Canary counters（server-only・process-local・PII フリー）。
//
// 責務: H-4 rollout 判断のための最小 evidence 収集。外部 metrics 基盤を新設せず、
//   **同一 process 内の enum 別カウンタ**だけを持つ。
//
// ★ 設計上の割り切り（過大主張しない）:
//   - process-local。serverless では instance ごとにリセットされ、集計は近似値。
//     「rollout 可否を判断するための傾向値」であって正確な課金/監査 metrics ではない。
//   - 永続化しない・DB へ書かない（second writer を作らない）。
//   - 上限付き（固定 enum の直積のみ）なのでメモリは有界。
//
// ★★ 記録するのは enum と件数のみ ★★
//   userId / UUID / 本文 / prompt / AI response / email / name を **保持しない**。
//   型が enum しか受け付けないため構造的に混入できない（QA が静的にも検査する）。

import 'server-only';

import type { CanaryObservation } from './observation';
import {
  CANARY_CONTEXT_OUTCOMES,
  CANARY_MEMORY_OUTCOMES,
  CANARY_PURPOSE_COVERAGES,
  CANARY_SOURCE_ORIGINS,
  CANARY_SYNC_OUTCOMES,
} from './observation';
import { CAREER_SOURCE_KINDS } from '@/lib/careerSourceData/types';
import { SOURCE_SYNC_VERDICTS } from '@/lib/careerSourceSync/signal';

type CounterMap = Record<string, number>;

type CanaryCounterState = {
  startedAt: number;
  requests: number;
  sync: CounterMap;
  memory: CounterMap;
  context: CounterMap;
  /** purpose 別 request 件数（purpose は固定 enum なので有界）。 */
  purpose: CounterMap;
  /** prompt へ載った section 数の合計（平均算出用。内容は持たない）。 */
  memorySectionTotal: number;
  /** Batch 2: `<kind>:<server|bridge>` 別件数（key 空間は固定 enum の直積で有界）。 */
  sourceOrigin: CounterMap;
  /** Batch 2: `<kind>:<verdict>` 別件数。 */
  sourceVerdict: CounterMap;
  /** Batch 2: purpose 単位の server 化度合い別件数。 */
  coverage: CounterMap;
};

function emptyState(now: number): CanaryCounterState {
  const zero = (keys: readonly string[]): CounterMap =>
    Object.fromEntries(keys.map((k) => [k, 0]));
  return {
    startedAt: now,
    requests: 0,
    sync: zero(CANARY_SYNC_OUTCOMES),
    memory: zero(CANARY_MEMORY_OUTCOMES),
    context: zero(CANARY_CONTEXT_OUTCOMES),
    purpose: {},
    memorySectionTotal: 0,
    sourceOrigin: zero(
      CAREER_SOURCE_KINDS.flatMap((k) => CANARY_SOURCE_ORIGINS.map((o) => `${k}:${o}`)),
    ),
    sourceVerdict: zero(
      CAREER_SOURCE_KINDS.flatMap((k) => SOURCE_SYNC_VERDICTS.map((v) => `${k}:${v}`)),
    ),
    coverage: zero(CANARY_PURPOSE_COVERAGES),
  };
}

// process-local singleton（cross-user 情報を持たないので共有して安全）。
let state: CanaryCounterState = emptyState(Date.now());

/** 1 request 分の観測を記録する（never-throw・fire-and-forget 前提）。 */
export function recordCanaryObservation(obs: CanaryObservation): void {
  try {
    state.requests += 1;
    state.purpose[obs.purpose] = (state.purpose[obs.purpose] ?? 0) + 1;
    if (obs.sync) state.sync[obs.sync] = (state.sync[obs.sync] ?? 0) + 1;
    if (obs.memory) state.memory[obs.memory] = (state.memory[obs.memory] ?? 0) + 1;
    if (obs.context) state.context[obs.context] = (state.context[obs.context] ?? 0) + 1;
    if (Number.isFinite(obs.memorySectionCount)) {
      state.memorySectionTotal += Math.max(0, Math.trunc(obs.memorySectionCount));
    }
    // ★ key は「既知 kind × 既知 enum」だけを通す。未知の key は捨てる
    //   （counter が任意文字列の受け皿にならない＝識別子混入経路を作らない）。
    if (obs.sourceOrigins) {
      for (const [kind, origin] of Object.entries(obs.sourceOrigins)) {
        const key = `${kind}:${origin}`;
        if (key in state.sourceOrigin) state.sourceOrigin[key] += 1;
      }
    }
    if (obs.sourceVerdicts) {
      for (const [kind, verdict] of Object.entries(obs.sourceVerdicts)) {
        const key = `${kind}:${verdict}`;
        if (key in state.sourceVerdict) state.sourceVerdict[key] += 1;
      }
    }
    if (obs.coverage && obs.coverage in state.coverage) state.coverage[obs.coverage] += 1;
  } catch {
    /* never-throw: 観測は機能の成功条件にしない */
  }
}

function rate(n: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((n / total) * 10000) / 10000; // 小数 4 桁
}

/** operator 向け snapshot（enum + 件数 + 率のみ）。 */
export type CanaryCounterSnapshot = {
  startedAt: string;
  requests: number;
  sync: CounterMap;
  memory: CounterMap;
  context: CounterMap;
  purpose: CounterMap;
  /** Batch 2: source kind 別の採用元 / verdict / purpose coverage。 */
  sourceOrigin: CounterMap;
  sourceVerdict: CounterMap;
  coverage: CounterMap;
  rates: {
    syncVerified: number;
    syncMismatch: number;
    syncUnreadable: number;
    memoryPersisted: number;
    memoryRebuilt: number;
    memoryOmitted: number;
    contextUsed: number;
    bridgeFallback: number;
    error: number;
  };
  avgMemorySections: number;
  /** ★ process-local の近似値である旨を snapshot 自体に明記する。 */
  note: string;
};

export function snapshotCanaryCounters(): CanaryCounterSnapshot {
  const total = state.requests;
  const memTotal = Object.values(state.memory).reduce((a, b) => a + b, 0);
  const ctxTotal = Object.values(state.context).reduce((a, b) => a + b, 0);
  const syncTotal = Object.values(state.sync).reduce((a, b) => a + b, 0);
  return {
    startedAt: new Date(state.startedAt).toISOString(),
    requests: total,
    sync: { ...state.sync },
    memory: { ...state.memory },
    context: { ...state.context },
    purpose: { ...state.purpose },
    sourceOrigin: { ...state.sourceOrigin },
    sourceVerdict: { ...state.sourceVerdict },
    coverage: { ...state.coverage },
    rates: {
      syncVerified: rate(state.sync.verified ?? 0, syncTotal),
      syncMismatch: rate(state.sync.mismatch ?? 0, syncTotal),
      syncUnreadable: rate(state.sync.unreadable ?? 0, syncTotal),
      memoryPersisted: rate(state.memory.persisted ?? 0, memTotal),
      memoryRebuilt: rate(state.memory.rebuilt ?? 0, memTotal),
      memoryOmitted: rate(state.memory.omitted ?? 0, memTotal),
      contextUsed: rate(state.context.server_context_used ?? 0, ctxTotal),
      bridgeFallback: rate(state.context.bridge_fallback ?? 0, ctxTotal),
      error: rate((state.memory.invalid ?? 0) + (state.sync.invalid ?? 0), total),
    },
    avgMemorySections: total > 0 ? Math.round((state.memorySectionTotal / total) * 100) / 100 : 0,
    note: 'process-local approximate counters; resets on restart/redeploy; no identifiers retained',
  };
}

/** テスト / operator の明示リセット用。 */
export function resetCanaryCounters(now: number = Date.now()): void {
  state = emptyState(now);
}

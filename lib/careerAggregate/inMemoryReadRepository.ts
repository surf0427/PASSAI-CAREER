/**
 * Aggregated Insight — in-memory read repository（P17-A §5.1・synthetic 専用）。
 *
 * 決定論的（Date.now / Math.random 非使用）。Supabase / production reader へ接続しない。
 *
 * duplicate metric 解決:
 *   同一 read 鍵の artifact が複数 put された場合、generatedAt が新しい方を採用する
 *   （同値なら後勝ち）。これにより read / list が put 順に依存せず決定論的になる。
 *
 * 安全読み取り:
 *   - expiresAt <= now は stale（available にしない）。
 *   - suppressed は suppressed（数値なし）。
 *   - valid / zero かつ fresh のみ available。
 *   - 未登録は missing。
 */

import {
  serializeAggregateReadKey,
  toAggregateReadKey,
  type AggregateReadQuery,
  type AggregateReadRepository,
  type AggregateReadResult,
} from './readRepository';
import type { SafeAggregateArtifact } from '@/types/careerAggregate';

function generatedAtMs(a: SafeAggregateArtifact): number {
  const t = Date.parse(a.generatedAt);
  return Number.isNaN(t) ? -Infinity : t;
}

function isExpired(a: SafeAggregateArtifact, now: number): boolean {
  const t = Date.parse(a.expiresAt);
  if (Number.isNaN(t)) return true; // expiry 不明は安全側（stale 扱い）
  return t <= now;
}

export function createInMemoryAggregateReadRepository(): AggregateReadRepository {
  const store = new Map<string, SafeAggregateArtifact>();

  return {
    put(artifact: SafeAggregateArtifact): void {
      if (!artifact || typeof artifact !== 'object') return;
      const key = serializeAggregateReadKey(toAggregateReadKey(artifact));
      const existing = store.get(key);
      // duplicate metric: generatedAt が新しい方を採用（同値は後勝ち）。
      if (existing && generatedAtMs(existing) > generatedAtMs(artifact)) return;
      store.set(key, artifact);
    },

    read(query: AggregateReadQuery): AggregateReadResult {
      const key = serializeAggregateReadKey({
        metricKey: query.metricKey,
        feature: query.feature,
        cohortType: query.cohortType,
        cohortValue: query.cohortValue,
        timeBucket: query.timeBucket,
        audience: query.audience,
      });
      const a = store.get(key);
      if (!a) return { status: 'missing' };
      // stale は available にしない（suppressed より先に freshness を見る）。
      if (isExpired(a, query.now)) return { status: 'stale' };
      if (a.kind === 'suppressed') return { status: 'suppressed', artifact: a };
      // valid / zero のみ available。
      return { status: 'available', artifact: a };
    },

    list(): readonly SafeAggregateArtifact[] {
      // 決定論順（key 昇順）。put / Map 反復順に依存しない。
      return Array.from(store.entries())
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([, v]) => v);
    },
  };
}

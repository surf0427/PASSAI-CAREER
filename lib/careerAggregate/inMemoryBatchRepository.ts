/**
 * Aggregated Insight (Layer 4) — in-memory batch-aware read repository（P17-B・synthetic 専用）。
 *
 * 決定論的。Supabase / production reader へ接続しない。
 * read は共通 governance 規則（evaluateGovernanceDisposition）へ委譲する。
 */

import { manifestToGovernanceState } from './batchManifest';
import { isBatchServable } from './invalidation';
import { evaluateGovernanceDisposition } from '@/lib/careerDataGovernance/state';
import type {
  AggregateBatchRepository,
  BatchAwareReadResult,
  PutManifestResult,
} from './batchRepository';
import type {
  AggregateBatchManifest,
  PropagationRecord,
} from '@/types/careerAggregateBatch';
import type { SafeAggregateArtifact } from '@/types/careerAggregate';
import type { GovernanceFreshnessState, InvalidationReason } from '@/types/careerDataGovernance';

export function createInMemoryAggregateBatchRepository(): AggregateBatchRepository {
  const manifests = new Map<string, AggregateBatchManifest>(); // batchId → manifest
  const idempotencyIndex = new Map<string, string>(); // idempotencyKey → batchId
  const artifacts = new Map<string, { batchId: string; artifact: SafeAggregateArtifact }>();
  // requestId → 最新 propagation record（advance で上書き。regeneration 完了を反映するため）。
  const propagations = new Map<string, PropagationRecord>();

  function freshnessOf(artifact: SafeAggregateArtifact, now: number): GovernanceFreshnessState {
    const exp = Date.parse(artifact.expiresAt);
    if (Number.isNaN(exp)) return 'unknown';
    return exp <= now ? 'expired' : 'fresh';
  }

  function invalidationFor(batchId: string): InvalidationReason | null {
    for (const rec of propagations.values()) {
      if (!isBatchServable(rec, batchId)) {
        return rec.request.trigger === 'user_deletion' ? 'user_deleted' : 'consent_revoked';
      }
    }
    return null;
  }

  return {
    putManifest(m: AggregateBatchManifest): PutManifestResult {
      if (!m || typeof m.batchId !== 'string' || m.batchId === '') return { accepted: false, deduped: false };
      const existingBatchForKey = idempotencyIndex.get(m.idempotencyKey);
      if (existingBatchForKey && existingBatchForKey !== m.batchId) {
        // 同一 idempotency key・別 batchId = 二重生成 → 拒否。
        return { accepted: false, deduped: true };
      }
      const deduped = manifests.has(m.batchId);
      manifests.set(m.batchId, m);
      idempotencyIndex.set(m.idempotencyKey, m.batchId);
      return { accepted: true, deduped };
    },
    getManifest(batchId: string): AggregateBatchManifest | null {
      return manifests.get(batchId) ?? null;
    },
    listManifests(): readonly AggregateBatchManifest[] {
      return Array.from(manifests.values()).sort((a, b) =>
        a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0,
      );
    },

    putArtifact(batchId: string, artifactId: string, artifact: SafeAggregateArtifact): void {
      if (typeof artifactId !== 'string' || artifactId === '') return;
      artifacts.set(artifactId, { batchId, artifact });
    },

    recordPropagation(record: PropagationRecord): void {
      if (!record || !record.request || typeof record.request.requestId !== 'string') return;
      propagations.set(record.request.requestId, record);
    },

    readArtifact(artifactId: string, now: number): BatchAwareReadResult {
      const entry = artifacts.get(artifactId);
      if (!entry) return { status: 'missing' };
      const manifest = manifests.get(entry.batchId);
      if (!manifest) return { status: 'unavailable', reason: 'lookup_error' };

      const gov = manifestToGovernanceState(manifest, {
        freshness: freshnessOf(entry.artifact, now),
        invalidation: invalidationFor(entry.batchId),
      });
      const disposition = evaluateGovernanceDisposition(gov);

      if (!disposition.serve) {
        if (disposition.status === 'blocked') return { status: 'blocked', reason: disposition.reason };
        if (disposition.status === 'stale') return { status: 'stale' };
        return { status: 'unavailable', reason: disposition.reason };
      }

      // serve 可: artifact 種別で available / suppressed を分ける。
      if (entry.artifact.kind === 'suppressed') return { status: 'suppressed', artifact: entry.artifact };
      return { status: 'available', artifact: entry.artifact };
    },
  };
}

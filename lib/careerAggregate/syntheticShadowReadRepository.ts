/**
 * Aggregated Insight — synthetic-only shadow read repository（P17-E2 §5）。
 *
 * service-role は RLS を bypass するため、**query 側で synthetic-only を強制**する。
 * production classification / unknown classification / invalidated / duplicate / malformed は
 * fail-closed。raw row / exact count / identity を上位へ返さない（BatchAwareReadResult のみ）。
 *
 * 通常 production read（supabaseReadRepository）とは **別 method** にして混同を避ける。
 * DataSpineReadPort を注入（raw client を受け取らない）。pure な合成 + governance 判定。
 */

import { parseArtifactPayload, parseBatchManifest } from './supabaseReadRepository';
import { manifestToGovernanceState } from './batchManifest';
import { evaluateGovernanceDisposition } from '@/lib/careerDataGovernance/state';
import { SYNTHETIC_CONSULTATION_ARTIFACT_ID } from './server/runtimeTypes';
import type { BatchAwareReadResult } from './batchRepository';
import type { DataSpineReadPort, DbRow } from '@/lib/careerDataSpineDb/types';
import type { GovernanceFreshnessState, InvalidationReason } from '@/types/careerDataGovernance';

const ARTIFACTS_TABLE = 'career_aggregate_artifacts';
const BATCHES_TABLE = 'career_aggregate_batches';
const SYNTHETIC = 'synthetic';
const EXPECTED_METRIC = 'feature_usage_prevalence';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function bool(v: unknown): boolean {
  return v === true;
}

export type SyntheticShadowReadRepository = {
  readSyntheticShadowArtifact(now: number): Promise<BatchAwareReadResult>;
};

/**
 * synthetic-only の shadow artifact を読む（強制 filter・fail-closed）。
 * 対象は固定 synthetic fixture id のみ。production / unknown classification は取得しない。
 */
export function createSyntheticShadowReadRepository(readPort: DataSpineReadPort): SyntheticShadowReadRepository {
  return {
    async readSyntheticShadowArtifact(now: number): Promise<BatchAwareReadResult> {
      try {
        // ── artifact: synthetic-only 強制 filter（id 固定 / metric 固定 / invalidated 除外）──
        const res = await readPort.select({
          table: ARTIFACTS_TABLE,
          eq: {
            id: SYNTHETIC_CONSULTATION_ARTIFACT_ID,
            data_classification: SYNTHETIC,
            metric_key: EXPECTED_METRIC,
            invalidated: false,
          },
          order: { column: 'id', ascending: true },
          limit: 2, // duplicate 検出のため 2 まで取得
        });
        if (!res.ok) return { status: 'unavailable', reason: 'lookup_error' };
        if (res.rows.length === 0) return { status: 'missing' };
        if (res.rows.length > 1) return { status: 'blocked', reason: 'moderation' }; // duplicate → serve しない

        const row: DbRow = res.rows[0];
        // 二重防御: classification が synthetic 以外は拒否（production を絶対に返さない）。
        if (str(row.data_classification) !== SYNTHETIC) return { status: 'unavailable', reason: 'lookup_error' };
        if (str(row.metric_key) !== EXPECTED_METRIC) return { status: 'unavailable', reason: 'lookup_error' };
        if (bool(row.invalidated)) return { status: 'blocked', reason: 'consent' };

        const artifact = parseArtifactPayload(row);
        if (!artifact) return { status: 'unavailable', reason: 'lookup_error' }; // malformed fail-closed

        // ── batch: 同じく synthetic-only ──
        const batchId = str(row.batch_id);
        const bres = await readPort.select({
          table: BATCHES_TABLE,
          eq: { id: batchId, data_classification: SYNTHETIC },
          limit: 2,
        });
        if (!bres.ok) return { status: 'unavailable', reason: 'lookup_error' };
        if (bres.rows.length === 0) return { status: 'unavailable', reason: 'lookup_error' };
        if (bres.rows.length > 1) return { status: 'blocked', reason: 'moderation' };

        const manifest = parseBatchManifest(bres.rows[0]);
        if (!manifest) return { status: 'unavailable', reason: 'lookup_error' };

        const exp = Date.parse(artifact.expiresAt);
        const freshness: GovernanceFreshnessState = Number.isNaN(exp) ? 'unknown' : exp <= now ? 'expired' : 'fresh';
        const invalidation: InvalidationReason | null = bool(row.invalidated) ? 'consent_revoked' : null;

        const gov = manifestToGovernanceState(manifest, { freshness, invalidation });
        const disposition = evaluateGovernanceDisposition(gov);
        if (!disposition.serve) {
          if (disposition.status === 'blocked') return { status: 'blocked', reason: disposition.reason };
          if (disposition.status === 'stale') return { status: 'stale' };
          return { status: 'unavailable', reason: disposition.reason };
        }
        if (artifact.kind === 'suppressed') return { status: 'suppressed', artifact };
        return { status: 'available', artifact };
      } catch {
        return { status: 'unavailable', reason: 'unknown' };
      }
    },
  };
}

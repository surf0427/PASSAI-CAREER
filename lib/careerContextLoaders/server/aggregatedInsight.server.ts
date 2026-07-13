/**
 * Production server loader — Aggregated Insight (Layer 4)（P17-C §11）。
 *
 * P17-A の disabled loader 契約は破壊しない（別 module）。ここは repository を DI で受け取る
 * server loader。多重 gate（flag / readiness / canary）を通過し、governed read が valid のときのみ
 * available を返す。route / Orchestrator から import しない（static guard QA が保証）。
 *
 * 状態写像:
 *   flag OFF → disabled(flag_off) / readiness false → blocked(legal) / canary 外 → disabled(not_connected)
 *   repository error → unavailable / stale → stale / suppressed·zero·missing → empty / valid → available
 *
 * pure DI（env / client を読まない）・never-throw。usage=reference_only 固定。
 */

import { renderSafeAggregate } from '@/lib/careerAggregate/renderer';
import { AGGREGATE_DISCLAIMER_KEY } from '@/lib/careerAggregate/policy';
import type { BatchAwareReadResult } from '@/lib/careerAggregate/batchRepository';
import type { CanaryDecision } from '@/lib/careerDataSpineGate/canary';
import type { ValidAggregateArtifact } from '@/types/careerAggregate';
import type {
  AggregatedInsightProjection,
  ContextSourceResult,
} from '@/types/careerContextSource';

export type AggregatedInsightServerDeps = {
  readRepository: { readArtifact(artifactId: string, now: number): Promise<BatchAwareReadResult> };
  isReadEnabled: boolean;
  isConsumerEnabled: boolean;
  readinessReady: boolean;
  canary: CanaryDecision;
  artifactId: string;
  now: number;
};

function buildInsightProjection(a: ValidAggregateArtifact): AggregatedInsightProjection | null {
  const rendered = renderSafeAggregate(a);
  if (!rendered || rendered.kind !== 'valid' || rendered.text.trim() === '') return null;
  return {
    metricKey: a.metricKey,
    feature: a.feature,
    displayText: rendered.text,
    disclaimerKey: AGGREGATE_DISCLAIMER_KEY,
    sampleSizeBucket: a.sampleSizeBucket,
    generatedAt: a.generatedAt,
    expiresAt: a.expiresAt,
    provenance: {
      layer: 'aggregated_insight',
      generatedAt: a.generatedAt,
      sourceWindow: a.timeBucket,
      calculationVersion: a.calculationVersion,
      policyStatus: a.provenance.policyStatus,
    },
  };
}

export async function loadAggregatedInsightContextServer(
  deps: AggregatedInsightServerDeps,
): Promise<ContextSourceResult<AggregatedInsightProjection[]>> {
  try {
    // 多重 gate（fail-closed）。
    if (!deps.isReadEnabled || !deps.isConsumerEnabled) return { status: 'disabled', reason: 'flag_off' };
    if (!deps.readinessReady) return { status: 'blocked', reason: 'legal' };
    if (!deps.canary.eligible) return { status: 'disabled', reason: 'not_connected' };

    const res = await deps.readRepository.readArtifact(deps.artifactId, deps.now);
    switch (res.status) {
      case 'missing':
        return { status: 'empty', reason: 'no_evidence' };
      case 'suppressed':
        return { status: 'empty', reason: 'no_eligible_data' };
      case 'stale':
        return { status: 'stale', reason: 'freshness_expired' };
      case 'blocked':
        return { status: 'blocked', reason: res.reason };
      case 'unavailable':
        return { status: 'unavailable', reason: res.reason };
      case 'available': {
        if (res.artifact.kind !== 'valid') return { status: 'empty', reason: 'no_eligible_data' }; // zero
        const projection = buildInsightProjection(res.artifact);
        if (!projection) return { status: 'empty', reason: 'no_eligible_data' };
        return {
          status: 'available',
          data: [projection],
          provenance: projection.provenance,
          confidence: 0.6,
          freshness: {
            generatedAt: projection.generatedAt,
            expiresAt: projection.expiresAt,
            observedPeriod: null,
            classification: 'fresh',
          },
          privacy: 'anonymous_aggregate',
          usage: 'reference_only',
        };
      }
      default:
        return { status: 'unavailable', reason: 'unknown' };
    }
  } catch {
    return { status: 'unavailable', reason: 'unknown' };
  }
}

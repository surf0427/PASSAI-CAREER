/**
 * Aggregated Insight — shadow compose 純粋コア（P17-E §5-7）。
 *
 * gate を DB query の **前** に評価する（flag / synthetic readiness / canary / real-mode-blocked）。
 * gate 通過時のみ read → offline renderer → safe evidence を組む。prompt / response には触れない。
 *
 * pure（server-only を import しない）。QA が直接検証する。
 */

import { loadAggregatedInsightContextServer } from '@/lib/careerContextLoaders/server/aggregatedInsight.server';
import { renderAggregatedInsightConsultationBlock } from '@/lib/careerContextRenderers/aggregatedInsightConsultation';
import { buildShadowEvidence, type ShadowEvidence, type ShadowSourceStatus } from '@/lib/careerAggregate/shadowEvidence';
import type { ShadowComposeDeps } from './runtimeTypes';
import type { ContextSourceResult, AggregatedInsightProjection } from '@/types/careerContextSource';

const DISCLAIMER_SENTINEL = 'あなたの能力・準備度・適性・選考結果を示すものではありません';

function byteLen(text: string): number {
  return new TextEncoder().encode(text).length;
}

function mapStatus(status: ContextSourceResult<unknown>['status']): ShadowSourceStatus {
  switch (status) {
    case 'available':
      return 'available';
    case 'empty':
      return 'empty';
    case 'stale':
      return 'stale';
    case 'blocked':
      return 'blocked';
    case 'disabled':
      return 'disabled';
    default:
      return 'unavailable';
  }
}

/**
 * shadow を評価して evidence を返す（pure・never-throw を呼び出し側で保証）。
 * gate 前 short-circuit を厳守（gate 未通過なら readArtifact を呼ばない＝DB query 0）。
 */
export async function composeAggregatedInsightShadow(deps: ShadowComposeDeps): Promise<ShadowEvidence> {
  const base = { runId: deps.runId, latencyMs: deps.latencyMs, timestamp: deps.timestamp };

  // real mode は本 series で無効（有効化できない）。
  if (deps.mode !== 'synthetic_only') {
    return buildShadowEvidence({ ...base, gateDecision: 'real_mode_blocked', sourceStatus: 'not_run', rendered: false, byteCount: 0, disclaimerPresent: false, errorCategory: 'none' });
  }
  // gate（DB query 前・fail-closed）。
  if (!deps.masterFlag || !deps.consumerFlag) {
    return buildShadowEvidence({ ...base, gateDecision: 'flag_off', sourceStatus: 'not_run', rendered: false, byteCount: 0, disclaimerPresent: false, errorCategory: 'none' });
  }
  if (!deps.syntheticReady) {
    return buildShadowEvidence({ ...base, gateDecision: 'readiness_not_ready', sourceStatus: 'not_run', rendered: false, byteCount: 0, disclaimerPresent: false, errorCategory: 'none' });
  }
  if (!deps.canary.eligible) {
    return buildShadowEvidence({ ...base, gateDecision: 'canary_excluded', sourceStatus: 'not_run', rendered: false, byteCount: 0, disclaimerPresent: false, errorCategory: 'none' });
  }

  // gate 通過。dependency（read port）が無ければ query せず unavailable。
  if (!deps.readArtifact) {
    return buildShadowEvidence({ ...base, gateDecision: 'passed', sourceStatus: 'unavailable', rendered: false, byteCount: 0, disclaimerPresent: false, errorCategory: 'dependency_unavailable' });
  }

  // gate 済のため loader へは全 gate true + eligible canary を渡し、read→projection 変換のみ再利用。
  const result: ContextSourceResult<AggregatedInsightProjection[]> = await loadAggregatedInsightContextServer({
    readRepository: { readArtifact: deps.readArtifact },
    artifactId: deps.artifactId,
    now: deps.now,
    isReadEnabled: true,
    isConsumerEnabled: true,
    readinessReady: true,
    canary: deps.canary,
  });

  const block = renderAggregatedInsightConsultationBlock(result);
  const metricKey = result.status === 'available' ? result.data[0]?.metricKey ?? null : null;
  const calculationVersion = result.status === 'available' ? result.provenance.calculationVersion : null;

  return buildShadowEvidence({
    ...base,
    gateDecision: 'passed',
    sourceStatus: mapStatus(result.status),
    rendered: block.used,
    byteCount: byteLen(block.text),
    disclaimerPresent: block.text.includes(DISCLAIMER_SENTINEL),
    metricKey,
    calculationVersion,
    errorCategory: 'none',
  });
}

/**
 * Aggregated Insight — shadow compose 純粋コア（P17-E §5-7 / P17-E2）。
 *
 * gate を **privileged client 生成の前** に評価する（real-mode-blocked / flag / synthetic readiness /
 * canary）。gate 通過時のみ resolvePrivilegedRead() を呼び（＝service-role client 生成）、
 * synthetic-only read → offline renderer → safe evidence を組む。prompt / response には触れない。
 *
 * pure（server-only を import しない）。QA が resolvePrivilegedRead の呼出回数を検証する。
 */

import { loadAggregatedInsightContextServer } from '@/lib/careerContextLoaders/server/aggregatedInsight.server';
import { renderAggregatedInsightConsultationBlock } from '@/lib/careerContextRenderers/aggregatedInsightConsultation';
import { buildShadowEvidence, type ShadowEvidence, type ShadowSourceStatus } from '@/lib/careerAggregate/shadowEvidence';
import { SYNTHETIC_CONSULTATION_ARTIFACT_ID, type ShadowComposeDeps } from './runtimeTypes';
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
 * gate 前 short-circuit を厳守: gate 未通過なら resolvePrivilegedRead を **呼ばない**（client 生成 0）。
 */
export async function composeAggregatedInsightShadow(deps: ShadowComposeDeps): Promise<ShadowEvidence> {
  const base = { runId: deps.runId, latencyMs: deps.latencyMs, timestamp: deps.timestamp };
  const notRun = (gateDecision: ShadowEvidence['gateDecision']): ShadowEvidence =>
    buildShadowEvidence({ ...base, gateDecision, sourceStatus: 'not_run', rendered: false, byteCount: 0, disclaimerPresent: false, errorCategory: 'none' });

  // real mode は本 series で無効（有効化できない）。client 生成しない。
  if (deps.mode !== 'synthetic_only') return notRun('real_mode_blocked');
  // gate（privileged client 生成の前・fail-closed）。
  if (!deps.masterFlag || !deps.consumerFlag) return notRun('flag_off');
  if (!deps.syntheticReady) return notRun('readiness_not_ready');
  if (!deps.canary.eligible) return notRun('canary_excluded');

  // ── gate 全通過。ここで初めて privileged (service-role) client を生成する ──
  const port = deps.resolvePrivilegedRead();
  if (port.status !== 'available') {
    // misconfigured / unavailable は raw error を出さず fail-closed。
    return buildShadowEvidence({ ...base, gateDecision: 'passed', sourceStatus: 'unavailable', rendered: false, byteCount: 0, disclaimerPresent: false, errorCategory: 'dependency_unavailable' });
  }

  // synthetic-only read（強制 filter 済）→ read repository の read result。
  const readResult = await deps.readSyntheticArtifact(port.read, deps.now);

  // read→projection 変換は既存 loader を再利用（gate 済のため全 true + eligible canary を渡す）。
  const result: ContextSourceResult<AggregatedInsightProjection[]> = await loadAggregatedInsightContextServer({
    readRepository: { readArtifact: () => Promise.resolve(readResult) },
    artifactId: SYNTHETIC_CONSULTATION_ARTIFACT_ID,
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

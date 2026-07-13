/**
 * Aggregated Insight runtime — shared types（P17-E §5・pure）。
 *
 * runtime mode は synthetic_only のみ実効。'real' は本 series で **無効**（blocked）。
 */

import type { BatchAwareReadResult } from '@/lib/careerAggregate/batchRepository';
import type { CanaryDecision } from '@/lib/careerDataSpineGate/canary';

/** 'real' は型上存在するが composition が blocked に倒す（有効化できない）。 */
export type AggregatedInsightRuntimeMode = 'synthetic_only' | 'real';

/** synthetic round-trip / shadow が対象とする固定 synthetic id（seed と runtime で共有）。 */
export const SYNTHETIC_CONSULTATION_BATCH_ID = 'synthetic-l4-consultation-batch-1';
export const SYNTHETIC_CONSULTATION_ARTIFACT_ID = 'synthetic-l4-consultation-artifact-1';

export type ShadowReadFn = (artifactId: string, now: number) => Promise<BatchAwareReadResult>;

/** shadow compose の依存（すべて injected・pure）。 */
export type ShadowComposeDeps = {
  runId: string;
  mode: AggregatedInsightRuntimeMode;
  masterFlag: boolean;
  consumerFlag: boolean;
  syntheticReady: boolean;
  canary: CanaryDecision;
  /** read repository の read 関数。null なら dependency_unavailable。 */
  readArtifact: ShadowReadFn | null;
  /** synthetic artifact の固定 id。 */
  artifactId: string;
  now: number;
  timestamp: string | null;
  latencyMs: number;
};

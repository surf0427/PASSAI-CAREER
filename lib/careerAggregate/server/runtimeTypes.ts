/**
 * Aggregated Insight runtime — shared types（P17-E §5 / P17-E2）。
 *
 * runtime mode は synthetic_only のみ実効。'real' は本 series で **無効**（blocked）。
 * pure（server-only を import しない）。QA が直接検証できる。
 */

import type { BatchAwareReadResult } from '@/lib/careerAggregate/batchRepository';
import type { CanaryDecision } from '@/lib/careerDataSpineGate/canary';
import type { DataSpineReadPort } from '@/lib/careerDataSpineDb/types';

/** 'real' は型上存在するが composition が blocked に倒す（有効化できない）。 */
export type AggregatedInsightRuntimeMode = 'synthetic_only' | 'real';

/**
 * synthetic round-trip / shadow が対象とする固定 synthetic id（seed と runtime で共有）。
 * career_aggregate_{batches,artifacts}.id は uuid 列のため **有効な固定 UUID(v4)** を使う
 * （P17-E3: 非 UUID 文字列は Postgres 22P02 になる）。実行ごとに変わらない fixture 値。
 */
export const SYNTHETIC_CONSULTATION_BATCH_ID = '00000000-0000-4000-8000-000000000001';
export const SYNTHETIC_CONSULTATION_ARTIFACT_ID = '10000000-0000-4000-8000-000000000001';

/**
 * canary identity は **shared Supabase auth の UID**（root AuthProvider / useCurrentUserId 由来）。
 * CAREER OTP（CareerAuthProvider）の UID ではない。両者を型と命名で区別する。
 */
export type SharedAuthUserId = string;

/** privileged（service-role）read port の解決結果。raw client は含めない。 */
export type PrivilegedReadResult =
  | { status: 'available'; read: DataSpineReadPort }
  | { status: 'unavailable' }
  | { status: 'misconfigured' };

/** gate 通過後にのみ呼ぶ privileged read port factory。 */
export type ResolvePrivilegedRead = () => PrivilegedReadResult;

/** synthetic-only read（read port を受け取り BatchAwareReadResult を返す）。 */
export type SyntheticShadowReadFn = (read: DataSpineReadPort, now: number) => Promise<BatchAwareReadResult>;

/** shadow compose の依存（すべて injected・pure）。 */
export type ShadowComposeDeps = {
  runId: string;
  mode: AggregatedInsightRuntimeMode;
  masterFlag: boolean;
  consumerFlag: boolean;
  syntheticReady: boolean;
  /** shared auth UID を用いた canary 判定結果。 */
  canary: CanaryDecision;
  now: number;
  timestamp: string | null;
  latencyMs: number;
  /** gate 通過後にのみ呼ばれる privileged read port factory（呼出回数を QA が検証）。 */
  resolvePrivilegedRead: ResolvePrivilegedRead;
  /** synthetic-only read（強制 filter 済）。 */
  readSyntheticArtifact: SyntheticShadowReadFn;
};

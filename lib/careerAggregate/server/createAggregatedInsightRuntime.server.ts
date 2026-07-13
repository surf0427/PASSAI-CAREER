/**
 * Aggregated Insight — production composition root（P17-E §5・server-only）。
 *
 * 既存の shared client adapter / Supabase read repository / synthetic readiness / feature gate /
 * server loader を組み立てる。**gate を DB query の前に評価**し、flag OFF / readiness false /
 * canary 外では ports / repository を生成せず return（query 0）。
 *
 * synthetic-only 固定。real mode は本 series で有効化できない（compose が blocked に倒す）。
 * Layer 5 / Personal Memory への依存なし。secret / client metadata を返さない。
 */

import 'server-only';

import { getServerSupabaseClient } from '@/lib/supabase/serverClient';
import { getSharedDataSpineReadPort } from '@/lib/careerDataSpineDb/sharedClientAdapter.server';
import { createSupabaseAggregateReadRepository } from '@/lib/careerAggregate/supabaseReadRepository';
import {
  isAggregatedInsightReadEnabled,
  isAggregatedInsightConsultationEnabled,
  isAggregatedInsightSyntheticOnly,
  aggregatedInsightCanaryAllowlist,
} from '@/lib/careerDataSpineGate/flags.server';
import { evaluateCanary, type CanaryDecision } from '@/lib/careerDataSpineGate/canary';
import { getServerReadinessConfig } from '@/lib/careerDataSpinePolicy/config.server';
import { isSyntheticReadyForShadow } from '@/lib/careerDataSpinePolicy/syntheticReadiness';
import { composeAggregatedInsightShadow } from './aggregatedInsightShadowCore';
import { SYNTHETIC_CONSULTATION_ARTIFACT_ID, type ShadowReadFn } from './runtimeTypes';
import type { ShadowEvidence } from '@/lib/careerAggregate/shadowEvidence';

const INELIGIBLE: CanaryDecision = { eligible: false, reason: 'invalid_user' };

/** 共有 session の userId を解決する（never-throw・uid をログに出さない）。 */
async function resolveSharedUserId(): Promise<string | null> {
  try {
    const client = await getServerSupabaseClient();
    if (!client) return null;
    const { data } = await client.auth.getUser();
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * synthetic shadow を実行して evidence を返す（never-throw）。
 * gate 前 short-circuit を厳守（flag OFF / readiness false / canary 外では port/repo を作らない）。
 */
export async function runAggregatedInsightConsultationShadow(input: {
  runId: string;
  timestamp: string | null;
}): Promise<ShadowEvidence> {
  const startNow = 0; // latency は synthetic では常に微小。real 計測は行わない。
  const master = isAggregatedInsightReadEnabled();
  const consumer = isAggregatedInsightConsultationEnabled();

  const baseDeps = {
    runId: input.runId,
    mode: 'synthetic_only' as const,
    artifactId: SYNTHETIC_CONSULTATION_ARTIFACT_ID,
    now: startNow,
    timestamp: input.timestamp,
    latencyMs: 1,
  };

  // 1) flag（env・I/O なし）。OFF なら port/repo/userId を一切作らずに compose（flag_off）。
  if (!master || !consumer) {
    return composeAggregatedInsightShadow({ ...baseDeps, masterFlag: master, consumerFlag: consumer, syntheticReady: false, canary: INELIGIBLE, readArtifact: null });
  }

  // 2) synthetic readiness（config.server・I/O なし）。
  const syntheticReady = isSyntheticReadyForShadow(getServerReadinessConfig());
  if (!syntheticReady) {
    return composeAggregatedInsightShadow({ ...baseDeps, masterFlag: true, consumerFlag: true, syntheticReady: false, canary: INELIGIBLE, readArtifact: null });
  }

  // 3) real-data mode は無効（synthetic-only 以外は compose が blocked に倒す）。
  //    synthetic-only flag が明示 false のときも real は許可しない（＝ shadow 自体を止める）。
  if (!isAggregatedInsightSyntheticOnly()) {
    return composeAggregatedInsightShadow({ ...baseDeps, mode: 'real', masterFlag: true, consumerFlag: true, syntheticReady: true, canary: INELIGIBLE, readArtifact: null });
  }

  // 4) canary（ここで初めて userId 解決）。allowlist 空 / 非対象なら port/repo を作らない。
  const userId = await resolveSharedUserId();
  const canary = evaluateCanary(aggregatedInsightCanaryAllowlist(), userId);
  if (!canary.eligible) {
    return composeAggregatedInsightShadow({ ...baseDeps, masterFlag: true, consumerFlag: true, syntheticReady: true, canary, readArtifact: null });
  }

  // 5) gate 全通過。ここで初めて port/repo を生成する。
  const readPort = await getSharedDataSpineReadPort();
  const readArtifact: ShadowReadFn | null = readPort
    ? (artifactId, now) => createSupabaseAggregateReadRepository(readPort).readArtifact(artifactId, now)
    : null;

  return composeAggregatedInsightShadow({ ...baseDeps, masterFlag: true, consumerFlag: true, syntheticReady: true, canary, readArtifact });
}

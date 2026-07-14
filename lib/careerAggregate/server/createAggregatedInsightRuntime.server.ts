/**
 * Aggregated Insight — production composition root（P17-E §5 / P17-E2・server-only）。
 *
 * gate を **privileged client 生成の前** に評価する。順序（P17-E2 §4）:
 *   1 master flag → 2 synthetic-only flag → 3 synthetic readiness → 4 consumer flag →
 *   5 shared canary UID 解決 → 6 real-mode 確認（compose 内）→ 7 privileged client 生成（compose 内）→
 *   8 synthetic-only query → 9 governance → 10 safe projection → 11 renderer → 12 evidence。
 *
 * canary identity は **shared Supabase auth UID**（getServerSupabaseClient の session）を使う。
 * CAREER OTP（careerSupabase）の UID は使わない。UID を evidence / console / response へ出さない。
 *
 * synthetic-only 固定。real mode は compose が blocked に倒す（有効化できない）。
 * Layer 5 / Personal Memory 依存なし。secret / client metadata を返さない。
 */

import 'server-only';

import { getServerSupabaseClient } from '@/lib/supabase/serverClient';
import { getSharedServiceRoleReadPort } from '@/lib/careerDataSpineDb/sharedServiceRolePorts.server';
import { createSyntheticShadowReadRepository } from '@/lib/careerAggregate/syntheticShadowReadRepository';
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
import type { ResolvePrivilegedRead, SharedAuthUserId, SyntheticShadowReadFn } from './runtimeTypes';
import type { ShadowEvidence } from '@/lib/careerAggregate/shadowEvidence';

const INELIGIBLE: CanaryDecision = { eligible: false, reason: 'invalid_user' };

// gate 通過後にのみ compose が呼ぶ（privileged client 生成 / synthetic read）。
const resolvePrivilegedRead: ResolvePrivilegedRead = () => getSharedServiceRoleReadPort();
const readSyntheticArtifact: SyntheticShadowReadFn = (read, now) =>
  createSyntheticShadowReadRepository(read).readSyntheticShadowArtifact(now);

/**
 * shared Supabase auth の UID を解決する（root AuthProvider と同じ anon serverClient の session）。
 * CAREER OTP の UID ではない。never-throw・uid をログに出さない。
 * anonymous shared auth user でも uid を持つため shared UID として扱える（RUNTIME UNVERIFIED: 実 session 種別）。
 */
async function resolveSharedAuthUserId(): Promise<SharedAuthUserId | null> {
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
 * gate 前 short-circuit を厳守（privileged client factory は compose が gate 通過後にのみ呼ぶ）。
 */
export async function runAggregatedInsightConsultationShadow(input: {
  runId: string;
  timestamp: string | null;
}): Promise<ShadowEvidence> {
  const master = isAggregatedInsightReadEnabled();
  const consumer = isAggregatedInsightConsultationEnabled();
  const syntheticOnly = isAggregatedInsightSyntheticOnly();

  const base = {
    runId: input.runId,
    now: 0,
    timestamp: input.timestamp,
    latencyMs: 1,
    resolvePrivilegedRead,
    readSyntheticArtifact,
  };

  // 1) master flag（env・I/O なし）。OFF なら UID/canary/client を一切作らない。
  if (!master) {
    return composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: false, consumerFlag: consumer, syntheticReady: false, canary: INELIGIBLE });
  }
  // 2) synthetic-only（real は blocked）。
  if (!syntheticOnly) {
    return composeAggregatedInsightShadow({ ...base, mode: 'real', masterFlag: true, consumerFlag: consumer, syntheticReady: true, canary: INELIGIBLE });
  }
  // 3) synthetic readiness（config.server・I/O なし）。
  if (!isSyntheticReadyForShadow(getServerReadinessConfig())) {
    return composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: true, consumerFlag: consumer, syntheticReady: false, canary: INELIGIBLE });
  }
  // 4) consumer flag。
  if (!consumer) {
    return composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: true, consumerFlag: false, syntheticReady: true, canary: INELIGIBLE });
  }
  // 5) shared canary UID を解決（anon serverClient の session。privileged client ではない）。
  const sharedUid = await resolveSharedAuthUserId();
  const canary = evaluateCanary(aggregatedInsightCanaryAllowlist(), sharedUid);

  // 6-12) compose（gate 通過後にのみ privileged client 生成 → synthetic query → evidence）。
  return composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: true, consumerFlag: true, syntheticReady: true, canary });
}

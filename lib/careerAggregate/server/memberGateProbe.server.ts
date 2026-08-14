// PASSAI CAREER — member request から呼べる **privilege-free** gate probe
// （Decision Resolution Batch / `D-R1`）。
//
// 解決した問題（`D-C7` / STATE §5.3.6 で residual boundary として記録していたもの）:
//
// ```text
//   consultation route（member request）
//     → shadowDispatcher
//       → createAggregatedInsightRuntime.server   ← ここが service-role port を import
//         → getSharedServiceRoleReadPort
// ```
//
// synthetic-only 固定 + real-mode ブロックで囲ってはいたが、
// **member request path から service-role port へ到達しうる import graph** が存在していた。
//
// ★ 本 module は「member path 側」の置き換えであり、**privileged port を一切 import しない**。
//   したがって consultation route からの到達可能性は import graph レベルで消える。
//   QA `HDR-1` が app/ から `sharedServiceRolePorts` への **推移的到達性ゼロ**を固定する。
//
// できること / できないこと:
//   ✅ flag / synthetic readiness / canary の gate 判定を、実 request 条件下で観測する
//   ❌ DB read（privileged / non-privileged いずれも行わない。**I/O は auth 解決のみ**）
//
//   もともと shadow が読んでいたのは **synthetic 固定行**であり、member traffic で読む
//   意味は無い（同じ synthetic 行を batch でも読める）。したがって member path に必要なのは
//   「gate がどう判定されたか」だけで、read は batch 側（`../batch/*.batch.ts`）へ移した。
//
// server-only / never-throw / 識別子を出さない。

import 'server-only';

import { getServerSupabaseClient } from '@/lib/supabase/serverClient';
import {
  isAggregatedInsightReadEnabled,
  isAggregatedInsightConsultationEnabled,
  isAggregatedInsightSyntheticOnly,
  aggregatedInsightCanaryAllowlist,
} from '@/lib/careerDataSpineGate/flags.server';
import { evaluateCanary } from '@/lib/careerDataSpineGate/canary';
import { getServerReadinessConfig } from '@/lib/careerDataSpinePolicy/config.server';
import { isSyntheticReadyForShadow } from '@/lib/careerDataSpinePolicy/syntheticReadiness';

/** gate 判定の結果（enum のみ。識別子・secret を含まない）。 */
export type MemberGateProbeResult = {
  runId: string;
  /** 契約: member path は DB read を **一切** 行わない。 */
  performedRead: false;
  /** 契約: privileged port へ到達しない。 */
  privilegedAccess: false;
  masterFlag: boolean;
  consumerFlag: boolean;
  syntheticOnly: boolean;
  syntheticReady: boolean;
  canaryEligible: boolean;
  /** どこで止まったか（最初に不成立になった gate）。全通過なら 'all_gates_passed'。 */
  stoppedAt:
    | 'master_flag'
    | 'consumer_flag'
    | 'synthetic_only_disabled'
    | 'synthetic_not_ready'
    | 'canary'
    | 'all_gates_passed';
  timestamp: string | null;
};

function result(
  partial: Omit<MemberGateProbeResult, 'performedRead' | 'privilegedAccess'>,
): MemberGateProbeResult {
  return { ...partial, performedRead: false, privilegedAccess: false };
}

/**
 * member request 条件下で gate だけを評価する（never-throw・**DB read なし**）。
 *
 * flag OFF（既定）なら auth 解決すら行わず即 return（I/O ゼロ）。
 */
export async function probeAggregatedInsightGates(input: {
  runId: string;
  timestamp: string | null;
}): Promise<MemberGateProbeResult> {
  const base = { runId: input.runId, timestamp: input.timestamp };
  try {
    const masterFlag = isAggregatedInsightReadEnabled();
    const consumerFlag = isAggregatedInsightConsultationEnabled();
    const syntheticOnly = isAggregatedInsightSyntheticOnly();

    // 1) master flag（env のみ・I/O ゼロ）。
    if (!masterFlag) {
      return result({
        ...base, masterFlag, consumerFlag, syntheticOnly,
        syntheticReady: false, canaryEligible: false, stoppedAt: 'master_flag',
      });
    }
    // 2) synthetic-only（解除されていたら member path では何もしない）。
    if (!syntheticOnly) {
      return result({
        ...base, masterFlag, consumerFlag, syntheticOnly,
        syntheticReady: false, canaryEligible: false, stoppedAt: 'synthetic_only_disabled',
      });
    }
    // 3) synthetic readiness。
    const syntheticReady = isSyntheticReadyForShadow(getServerReadinessConfig());
    if (!syntheticReady) {
      return result({
        ...base, masterFlag, consumerFlag, syntheticOnly,
        syntheticReady, canaryEligible: false, stoppedAt: 'synthetic_not_ready',
      });
    }
    // 4) consumer flag。
    if (!consumerFlag) {
      return result({
        ...base, masterFlag, consumerFlag, syntheticOnly,
        syntheticReady, canaryEligible: false, stoppedAt: 'consumer_flag',
      });
    }
    // 5) canary（shared auth UID。**anon server client のみ**。privileged client ではない）。
    let uid: string | null = null;
    try {
      const client = await getServerSupabaseClient();
      const { data } = (await client?.auth.getUser()) ?? { data: null };
      uid = data?.user?.id ?? null;
    } catch {
      uid = null;
    }
    const canary = evaluateCanary(aggregatedInsightCanaryAllowlist(), uid);
    return result({
      ...base, masterFlag, consumerFlag, syntheticOnly, syntheticReady,
      canaryEligible: canary.eligible,
      stoppedAt: canary.eligible ? 'all_gates_passed' : 'canary',
    });
  } catch {
    return result({
      ...base, masterFlag: false, consumerFlag: false, syntheticOnly: true,
      syntheticReady: false, canaryEligible: false, stoppedAt: 'master_flag',
    });
  }
}

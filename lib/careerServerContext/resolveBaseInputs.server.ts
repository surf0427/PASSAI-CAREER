// PASSAI CAREER — purpose 共通の base context 解決（Batch 1 / `D-S5`）。
//
// 責務: 「profile / activity / values を server Layer 1 から取るか、request body bridge から取るか」を
//   **purpose 横断で 1 箇所** に集約する。
//   Batch 1 以前は interview_practice 専用の resolver（app/api/career/interview/resolveBaseInputs.ts）
//   しか無く、purpose を増やすたびに同じ分岐を書く必要があった。
//
// 使用条件（`D-S4` の canary gate をそのまま再利用）:
//   purpose opt-in AND canary user AND Source-Sync verified → server source
//   それ以外 → request body bridge（＝リクエスト端末の canonical。出力は従来どおり）
//
// 厳守:
//   - server-only。userId は server auth 由来のみ（client 申告値を canary 判定に使わない）。
//   - never-throw / fail-open。どんな失敗でも bridge へ倒す。
//   - **古い mirror へ fallback しない**（veto は「使わない」であって「古いのを使う」ではない）。
//   - 本文 / PII / UUID を log しない。

import 'server-only';

import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import { loadServerBaseContext } from './baseContext.server';
import type { BaseContextDecisionReason } from './baseContextPolicy';
import { readSourceSyncSignal } from '@/lib/careerSourceSync/request.server';
import { normalizeContextOutcome } from '@/lib/careerDataSpineCanary/observation';
import { recordCanaryObservation } from '@/lib/careerDataSpineCanary/counters.server';

export type ResolvedBaseInputs = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  /** 観測用（route 挙動には影響しない）。'server_source' 以外はすべて bridge 経路。 */
  source: BaseContextDecisionReason;
  /** server Layer 1 由来か（＝bridge の同等 field を二重に使わないための判定に使う）。 */
  usedServerSource: boolean;
};

export type BridgeBaseInputs = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
};

/**
 * purpose 別に base context を解決し、canary 観測も記録する（never-throw）。
 *
 * `req` を渡すと header から Source-Sync claim を読む。渡さない場合は claim なし扱い
 * （＝必ず bridge へ倒れる＝安全側）。
 */
export async function resolveServerBaseInputs(
  purpose: CareerContextPurpose,
  body: BridgeBaseInputs,
  req?: Request,
): Promise<ResolvedBaseInputs> {
  const bridge: ResolvedBaseInputs = {
    profile: body.profile ?? null,
    activity: body.activity ?? null,
    values: body.values ?? null,
    source: 'flag_off',
    usedServerSource: false,
  };
  try {
    const server = await loadServerBaseContext(
      purpose,
      req ? readSourceSyncSignal(req) : undefined,
    );
    // 観測: server context を使ったか / なぜ bridge へ倒れたか（enum のみ・PII なし）。
    recordCanaryObservation({
      purpose,
      sync: null,
      memory: null,
      context: normalizeContextOutcome(server.reason),
      memorySectionCount: 0,
    });
    if (!server.context) return { ...bridge, source: server.reason };
    return {
      profile: server.context.profile,
      activity: server.context.activity,
      values: server.context.values,
      source: server.reason,
      usedServerSource: true,
    };
  } catch {
    return { ...bridge, source: 'source_unavailable' };
  }
}

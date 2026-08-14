/**
 * Aggregated Insight — consultation gate probe dispatcher（server-only）。
 *
 * consultation route から `void dispatchAggregatedInsightConsultationShadow()` で fire-and-forget
 * 呼び出しされる。**prompt / response には一切触れない**。never-throw・短 timeout。
 *
 * ★ Decision Resolution Batch（`D-R1`）で **privileged read を切り離した**:
 *   以前はここから `createAggregatedInsightRuntime.server` 経由で service-role read port へ
 *   到達しうる import graph があった（synthetic-only + real-mode block で囲ってはいたが、
 *   member request path に privileged 到達性がある状態だった）。
 *
 *   現在:
 *     member path  → `memberGateProbe.server`（**privileged port を import しない / DB read ゼロ**）
 *     batch path   → `batch/aggregatedInsightPrivilegedShadow.batch`（別 entrypoint・route から不可達）
 *
 *   QA `HDR-1` が app/ から `sharedServiceRolePorts` への **推移的到達性ゼロ**を固定する。
 */

import 'server-only';

import {
  isAggregatedInsightReadEnabled,
  isAggregatedInsightConsultationEnabled,
} from '@/lib/careerDataSpineGate/flags.server';
import {
  probeAggregatedInsightGates,
  type MemberGateProbeResult,
} from './server/memberGateProbe.server';

/** shadow の最大許容時間（本処理と独立・超過で打ち切り）。 */
const SHADOW_TIMEOUT_MS = 800;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    p.then((v) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    }).catch(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      }
    });
  });
}

/**
 * consultation route から fire-and-forget で呼ぶ（route は `void` する）。
 * 返り値なし・例外を投げない・本処理に影響しない。
 */
export async function dispatchAggregatedInsightConsultationShadow(input: {
  runId: string;
  timestamp: string | null;
}): Promise<void> {
  try {
    // flag OFF（default）なら runtime に入らず即 return（DB query 0・I/O 0）。
    if (!isAggregatedInsightReadEnabled() || !isAggregatedInsightConsultationEnabled()) return;

    const probe: MemberGateProbeResult | null = await withTimeout(
      probeAggregatedInsightGates({ runId: input.runId, timestamp: input.timestamp }),
      SHADOW_TIMEOUT_MS,
      null,
    );
    // gate 判定（enum + boolean のみ）。artifact / uid / secret は構造的に含まれない
    //   （`MemberGateProbeResult` にそれらの field が存在しない）。
    if (probe) console.info('[data-spine-gate-probe]', JSON.stringify(probe));
  } catch {
    // never-throw: shadow の失敗で consultation 本処理を失敗させない。
  }
}

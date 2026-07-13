/**
 * Aggregated Insight — consultation shadow dispatcher（P17-E §7-8・server-only）。
 *
 * consultation route から `void dispatchAggregatedInsightConsultationShadow()` で fire-and-forget
 * 呼び出しされる。**prompt / response には一切触れない**。never-throw・短 timeout。
 *
 * flag OFF（default）では runtime に入る前に return（DB query 0）。
 * gate 通過時のみ synthetic shadow を実行し、safe evidence を構造化ログへ出す（raw / secret を出さない）。
 */

import 'server-only';

import {
  isAggregatedInsightReadEnabled,
  isAggregatedInsightConsultationEnabled,
} from '@/lib/careerDataSpineGate/flags.server';
import { runAggregatedInsightConsultationShadow } from './server/createAggregatedInsightRuntime.server';
import { isShadowEvidenceSafe } from './shadowEvidence';

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

    const evidence = await withTimeout(
      runAggregatedInsightConsultationShadow({ runId: input.runId, timestamp: input.timestamp }),
      SHADOW_TIMEOUT_MS,
      null,
    );
    if (evidence && isShadowEvidenceSafe(evidence)) {
      // safe metadata のみ（raw artifact / uid / secret を含まない）。operator が Phase 13 で収集。
      console.info('[data-spine-shadow]', JSON.stringify(evidence));
    }
  } catch {
    // never-throw: shadow の失敗で consultation 本処理を失敗させない。
  }
}

/**
 * Offline vertical renderer — Aggregated Insight → consultation 補足 block（P17-B §13.1）。
 *
 * **offline 専用**。production prompt / route / Context Orchestrator から import しない
 * （static guard QA が import 0 を保証）。production consultation prompt は変更しない。
 *
 * 契約:
 *   - valid（available）projection のみ render。suppressed / stale / blocked / disabled /
 *     empty / unavailable は空 block。
 *   - reference_only。本人能力の断定をしない。固定 disclaimer を必ず付ける。
 *   - 最大 1 metric。byte budget 超過は空（安全側）。
 *   - loader / renderer 例外時は空。
 *
 * pure・決定論・never-throw。
 */

import { AGGREGATE_DISCLAIMER } from '@/lib/careerAggregate/policy';
import { isContextSourceAvailable } from '@/types/careerContextSource';
import type {
  AggregatedInsightProjection,
  ContextSourceResult,
} from '@/types/careerContextSource';

export type ConsultationInsightBlock = {
  /** 挿入用テキスト（空 = 何も挿入しない）。 */
  text: string;
  used: boolean;
};

// 1 metric（一般傾向文）+ 固定 disclaimer が収まる budget（日本語 ~200 字相当）。
export const CONSULTATION_INSIGHT_MAX_BYTES = 600;

const EMPTY: ConsultationInsightBlock = { text: '', used: false };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Aggregated Insight の ContextSourceResult を consultation 補足 block へ整形する（never-throw）。
 * usage が reference_only 以外、privacy が anonymous_aggregate 以外は render しない（型安全 + 実行時防御）。
 */
export function renderAggregatedInsightConsultationBlock(
  result: ContextSourceResult<AggregatedInsightProjection[]>,
  opts: { maxBytes?: number } = {},
): ConsultationInsightBlock {
  try {
    if (!isContextSourceAvailable(result)) return EMPTY;
    if (result.usage !== 'reference_only' || result.privacy !== 'anonymous_aggregate') return EMPTY;
    const items = result.data;
    if (!Array.isArray(items) || items.length === 0) return EMPTY;

    const top = items[0]; // 最大 1 metric
    if (!top || typeof top.displayText !== 'string' || top.displayText.trim() === '') return EMPTY;

    const lines = [
      '【参考: 一般的な準備傾向（匿名集計・補助情報）】',
      top.displayText.trim(),
      AGGREGATE_DISCLAIMER,
    ];
    const text = lines.join('\n');

    const maxBytes = opts.maxBytes ?? CONSULTATION_INSIGHT_MAX_BYTES;
    if (byteLength(text) > maxBytes) return EMPTY; // budget 超過は安全側で空
    return { text, used: true };
  } catch {
    return EMPTY;
  }
}

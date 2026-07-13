/**
 * Context Loader — Aggregated Insight (Layer 4)（P17-A §7・disabled）。
 *
 * 差し込み口の契約固定のみ。本 series では **常に disabled / not_connected**（副作用ゼロ）。
 * 将来 I/O を足せるよう async signature にするが、現時点では決定論的に同一結果を返す。
 *
 * 禁止（本 loader が絶対にしないこと）: Supabase read / localStorage read / fetch /
 *   production repository 実装 / app import / prompt import / route import。
 */

import type {
  AggregatedInsightProjection,
  ContextSourceResult,
} from '@/types/careerContextSource';

export type LoadAggregatedInsightInput = {
  /** consultation / mypage 等（現状は使わない・将来の projection 分岐用）。 */
  purpose: string;
  /** ai_context / user_facing 等の audience（将来用）。 */
  audience?: 'internal' | 'user_facing' | 'ai_context';
};

/**
 * 常に disabled（not_connected）を返す fail-closed loader。
 * unknown を negative evidence にしない: available を返さない = prompt へ何も投入されない。
 */
export async function loadAggregatedInsightContext(
  input: LoadAggregatedInsightInput,
): Promise<ContextSourceResult<AggregatedInsightProjection[]>> {
  void input; // 差し込み口の契約のみ。現状は入力に依らず disabled を返す。
  return { status: 'disabled', reason: 'not_connected' };
}

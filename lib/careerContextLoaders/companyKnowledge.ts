/**
 * Context Loader — Company Knowledge (Layer 5)（P17-A §7・disabled）。
 *
 * 差し込み口の契約固定のみ。本 series では **常に disabled / not_connected**（副作用ゼロ）。
 * 将来 I/O を足せるよう async signature にするが、現時点では決定論的に同一結果を返す。
 *
 * 禁止: Supabase read / localStorage read / fetch / private research storage import /
 *   production repository 実装 / app import / prompt import / route import。
 */

import type {
  CompanyKnowledgeProjection,
  ContextSourceResult,
} from '@/types/careerContextSource';

export type LoadCompanyKnowledgeInput = {
  purpose: string;
  /** canonical company id（将来の projection 用）。 */
  companyId: string;
};

/**
 * 常に disabled（not_connected）を返す fail-closed loader。
 * available を返さない = 企業集合知が prompt へ投入されない。
 */
export async function loadCompanyKnowledgeContext(
  input: LoadCompanyKnowledgeInput,
): Promise<ContextSourceResult<CompanyKnowledgeProjection>> {
  void input; // 差し込み口の契約のみ。現状は入力に依らず disabled を返す。
  return { status: 'disabled', reason: 'not_connected' };
}

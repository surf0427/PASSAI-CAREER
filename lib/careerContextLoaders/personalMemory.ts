/**
 * Context Loader — Personal Memory (Layer 2)（P17-A §7・disabled / shadow_only）。
 *
 * Layer 2 は現状 **凍結方針**（master flag OFF・read adapter 未配線・prompt 未接続）。
 * 本 loader は prompt 利用可能な `available` を **絶対に返さない**。
 * 現行契約に最も適した reason = `shadow_only`（shadow comparison 目的でのみ将来接続）。
 *
 * 禁止: Supabase read / localStorage read / fetch / readAdapter の production 呼び出し /
 *   writer / canary / flag 変更 / app import / prompt import / route import。
 */

import type { ContextSourceResult } from '@/types/careerContextSource';

/** Personal Memory read model の境界形（将来 available で運ぶ想定・現状は運ばない）。 */
export type PersonalMemoryContextProjection = {
  sectionKey: string;
  usableForPrompt: false;
};

export type LoadPersonalMemoryInput = {
  /** 将来の shadow read 対象（現状は使わない）。 */
  sections?: readonly string[];
};

/**
 * 常に disabled（shadow_only）を返す fail-closed loader。
 * prompt 利用可能な available を返さない（Layer 2 凍結方針の遵守）。
 */
export async function loadPersonalMemoryContext(
  input: LoadPersonalMemoryInput,
): Promise<ContextSourceResult<PersonalMemoryContextProjection[]>> {
  void input; // Layer 2 凍結方針: 入力に依らず shadow_only（prompt 利用可能な available を返さない）。
  return { status: 'disabled', reason: 'shadow_only' };
}

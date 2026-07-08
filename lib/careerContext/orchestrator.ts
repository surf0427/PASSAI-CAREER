// PASSAI CAREER Context Orchestrator — purpose 別 context 整形の入口（P3-A で導入）。
//
// 役割: 「purpose を渡すと、その機能向けの base career system prompt を返す」共通入口。
//   getCareerContext(purpose) 構想の骨格。P3-A では **純粋な整形レイヤ**に徹する。
//
// 厳守（P3-A の制約）:
//   - 純関数。I/O / env 参照 / secret 参照 / Supabase read を一切しない。
//   - 入力は既に request payload から組んだ CareerAiContext（profile/activity/values/userInput）。
//   - base system prompt は既存 buildCareerSystemPrompt に委譲し、**出力は現行と byte 単位で同一**。
//     → 移行 route の prompt 品質・AI 挙動・cache に影響しない（「整理と入口作成」が目的）。
//   - purpose 別の section 削減（policy の実適用）・DB/Memory 読込は P3-B 以降。
//   - route 側の cross-feature block（自己分析 / ES / 企業研究 等）は引き続き route の責務（本層は触らない）。

import type { CareerAiContext } from '@/lib/careerAi/types';
import { buildCareerSystemPrompt } from '@/lib/careerAi';
import {
  getCareerContextPolicy,
  type CareerContextPolicy,
  type CareerContextPurpose,
} from './purpose';

export type CareerPurposeContext = {
  purpose: CareerContextPurpose;
  // base career system prompt（P3-A では buildCareerSystemPrompt と同一文字列）。
  systemPrompt: string;
  // 適用された purpose policy（P3-A は宣言。実際の削減は P3-B）。
  policy: CareerContextPolicy;
  // 観測用: base context の概算文字数。
  estimatedChars: number;
  // P3-A では常に空（削減未実施）。P3-B で「省いた section」を積む。
  omitted: string[];
};

/**
 * purpose 別に base career system prompt を返す。
 * P3-A は buildCareerSystemPrompt へ委譲する identity-preserving wrapper。
 * context が空（未入力）でも buildCareerSystemPrompt 側の fallback で落ちない。
 */
export function buildCareerContextForPurpose(
  purpose: CareerContextPurpose,
  context: CareerAiContext,
): CareerPurposeContext {
  const policy = getCareerContextPolicy(purpose);
  const systemPrompt = buildCareerSystemPrompt(context);
  return {
    purpose,
    systemPrompt,
    policy,
    estimatedChars: systemPrompt.length,
    omitted: [],
  };
}

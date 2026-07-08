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
  // base career system prompt（P3-A/P3-B では buildCareerSystemPrompt と同一文字列）。
  systemPrompt: string;
  // 適用された purpose policy（宣言。実際の section 削減は P3-C 以降）。
  policy: CareerContextPolicy;
  // 観測用: base context の概算文字数。
  estimatedChars: number;
  // 観測用: policy.maxContextChars を超えているか（route 挙動には影響しない）。
  isOverPolicyBudget: boolean;
  // P3-B では削減未実施のため常に空。P3-C で「省いた section」を積む。
  omitted: string[];
  // 観測用の軽量警告（例: 'over_policy_budget'）。route 挙動・ログには影響しない。
  warnings: string[];
};

/**
 * purpose 別に base career system prompt を返す。
 * P3-B も buildCareerSystemPrompt へ委譲する identity-preserving wrapper（出力は現行と byte 一致）。
 * context が空（未入力）でも buildCareerSystemPrompt 側の fallback で落ちない純関数（非 throw）。
 * estimatedChars / isOverPolicyBudget / warnings は「観測用」であり、削減は P3-C 以降で実適用する。
 */
export function buildCareerContextForPurpose(
  purpose: CareerContextPurpose,
  context: CareerAiContext,
): CareerPurposeContext {
  const policy = getCareerContextPolicy(purpose);
  const systemPrompt = buildCareerSystemPrompt(context);
  const estimatedChars = systemPrompt.length;
  const isOverPolicyBudget = estimatedChars > policy.maxContextChars;
  return {
    purpose,
    systemPrompt,
    policy,
    estimatedChars,
    isOverPolicyBudget,
    omitted: [],
    warnings: isOverPolicyBudget ? ['over_policy_budget'] : [],
  };
}

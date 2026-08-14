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

import type { CareerAiContext, CareerProfileContext } from '@/lib/careerAi/types';
import { buildCareerSystemPrompt } from '@/lib/careerAi';
import {
  getCareerContextPolicy,
  type CareerContextPolicy,
  type CareerContextPurpose,
} from './purpose';
// P8-B: activity:'minimal' 通電時に使う matching 専用 tighter limits（formatter は既存を再利用）。
import { MATCHING_ACTIVITY_LIMITS } from './activity';
// P15-A: presentation_feedback の機能横断（cross-feature）context を orchestrator 経由で組む。
//   canonical renderer は lib/careerMemory/renderers/presentationCrossFeature（byte-identical）。
import {
  buildPresentationCrossFeatureContext,
  type PresentationCrossFeatureInput,
} from '@/lib/careerMemory/renderers/presentationCrossFeature';
// P15-B: interview_practice の機能横断 context も orchestrator 経由で組む（byte-identical）。
import {
  buildInterviewCrossFeatureContext,
  type InterviewCrossFeatureInput,
} from '@/lib/careerMemory/renderers/interviewCrossFeature';
// P15-D: consultation の Personal Memory 由来横断 context も orchestrator 経由で組む（byte-identical）。
//   ★ Event Signal は本層に一切入れない（route 側で独立処理）。consultation renderer も Event Signal 非依存。
import {
  buildConsultationCrossFeatureContext,
  type ConsultationCrossFeatureInput,
} from '@/lib/careerMemory/renderers/consultationCrossFeature';
// P17-M1: Personal Memory（Data Spine Layer 2）を purpose 別に選択・render・budget enforce する純関数。
//   read（I/O）は route 側の server loader が担い、本層へは検証済み section（optional）だけを渡す
//   （Orchestrator は純関数のまま・DB read を内部に持ち込まない）。section 無しなら出力は従来と完全互換。
import { renderPersonalMemoryForPurpose } from '@/lib/careerMemory/personalMemoryPromptContext';
import type { CareerPersonalMemorySection } from '@/lib/careerMemory/persistence/schema';

// P6-C: profile:minimal 通電時に prompt から落とす構造化 PII フィールド（自由記述内の
//   PII pattern（notes 等）は対象外＝baseline のまま。P6-C pilot は matching のみ minimal）。
//   profile object そのもの・request body は変えず、prompt 生成用の context コピーからのみ除去する。
function stripProfilePiiForPrompt(
  profile: CareerProfileContext,
): { profile: CareerProfileContext; omitted: string[] } {
  if (profile.name.trim() === '') return { profile, omitted: [] };
  return { profile: { ...profile, name: '' }, omitted: ['profile.name'] };
}

// P15-A: purpose 別の追加入力（cross-feature snapshot 等）。任意。
//   purpose に無関係な巨大 union を避け、purpose ごとに必要な最小型のみを持たせる。
export type CareerContextExtras = {
  // presentation_feedback のときだけ意味を持つ機能横断 snapshot。
  presentation?: PresentationCrossFeatureInput;
  // P15-B: interview_practice のときだけ意味を持つ機能横断 snapshot。
  interview?: InterviewCrossFeatureInput;
  // P15-D: consultation のときだけ意味を持つ Personal Memory 由来 snapshot（Event Signal は含まない）。
  consultation?: ConsultationCrossFeatureInput;
  // P17-M1: Data Spine Layer 2 Personal Memory の **検証済み fresh section**（route の server loader が read/gate 済み）。
  //   purpose 別に本層が選択・render・budget enforce する。未指定 / 空なら personalMemoryContext は ''（従来互換）。
  //   ★ ユーザー由来の参考情報であり信頼済み instruction ではない（renderer が injection 境界を付ける）。
  personalMemory?: readonly CareerPersonalMemorySection[];
};

export type CareerPurposeContext = {
  purpose: CareerContextPurpose;
  // base career system prompt（P3-A/P3-B では buildCareerSystemPrompt と同一文字列）。
  systemPrompt: string;
  // P15-A/B/C: purpose 別の機能横断 context block（決定的）。extras が無い / 対象外 purpose では ''。
  //   presentation_feedback（P15-A）/ interview_practice（P15-B）/ consultation（P15-D）で通電。
  //   ★ es_generation（P15-C）は Closure Batch で retire 済み（`D-S12`）。
  //   purpose ごとに専用 renderer を呼ぶ（混在しない）。base system prompt はこの block を含まない
  //   （route が base と別に受け取る）。
  crossFeatureContext: string;
  // P17-M1: Personal Memory（Layer 2）由来の参考 context block（injection 境界付き・budget enforce 済み）。
  //   extras.personalMemory が無い / 空 / 対象外 purpose では ''（Memory 無しの prompt を従来と完全互換に保つ）。
  //   route は base / crossFeature とは別に、低優先の参考情報としてこの block を prompt へ結合する。
  personalMemoryContext: string;
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
 * P3-B までは buildCareerSystemPrompt へ委譲する identity-preserving wrapper（byte 一致）だったが、
 * P6-C から policy 通電を開始: profile:minimal の purpose（現状 matching pilot のみ）は氏名(PII)を
 * prompt から除外し omitted に積む。include の purpose は従来どおり byte 一致（挙動不変）。
 * context が空（未入力）でも buildCareerSystemPrompt 側の fallback で落ちない純関数（非 throw）。
 * profile object・request body は変えず、prompt 生成用 context のコピーからのみ PII を落とす。
 */
export function buildCareerContextForPurpose(
  purpose: CareerContextPurpose,
  context: CareerAiContext,
  extras?: CareerContextExtras,
): CareerPurposeContext {
  const policy = getCareerContextPolicy(purpose);

  // P6-C: policy 通電（第一段）。profile:minimal の purpose は構造化 PII（氏名）を prompt から除外する。
  //   現状 minimal は matching のみ base prompt を描画する（es_review は静的 SYSTEM_PROMPT・mypage 未実装で
  //   本 builder を通らない）ため、実効は matching pilot に限定される。include の他 purpose は不変。
  let effectiveContext = context;
  let omitted: string[] = [];
  if (policy.profile === 'minimal') {
    const stripped = stripProfilePiiForPrompt(context.profile);
    if (stripped.omitted.length > 0) {
      effectiveContext = { ...context, profile: stripped.profile };
      omitted = stripped.omitted;
    }
  }

  // P8-B: activity:'minimal' の purpose（現状 matching のみ）は activity render を tighter limits で縮める。
  //   effectiveContext（＝生 activity object）・request body は不変。formatter へ渡す上限だけを差し替える
  //   （buildCareerSystemPrompt options 経由）。profile:minimal と対称の「prompt 生成側だけ」通電。
  const activityLimits = policy.activity === 'minimal' ? MATCHING_ACTIVITY_LIMITS : undefined;
  if (activityLimits) omitted = [...omitted, 'activity.compacted'];

  const systemPrompt = buildCareerSystemPrompt(effectiveContext, { activityLimits });

  // P15-A/B/C: purpose を確認し、対象 purpose かつ cross-feature 入力があるときだけ canonical renderer で
  //   機能横断 block を決定的に組む（purpose ごとに専用 renderer。混在させず、他 purpose へは投入しない）。
  //   base（systemPrompt）の byte・意味は不変。route はこの block を base とは別に受け取る。
  let crossFeatureContext = '';
  if (purpose === 'presentation_feedback' && extras?.presentation) {
    crossFeatureContext = buildPresentationCrossFeatureContext(extras.presentation);
  } else if (purpose === 'interview_practice' && extras?.interview) {
    crossFeatureContext = buildInterviewCrossFeatureContext(extras.interview);
  } else if (purpose === 'consultation' && extras?.consultation) {
    // P15-D: Personal Memory 由来のみ。Event Signal は route 側で別途 render・挿入（本層非関与）。
    crossFeatureContext = buildConsultationCrossFeatureContext(extras.consultation);
  }

  // P17-M1: Personal Memory を purpose 別に選択・render・budget enforce（純関数）。section 無しなら ''。
  //   対象 purpose（renderer 側の allowlist で判定）以外・空 section では出力ゼロ＝従来 byte 互換。
  const personalMemoryContext = renderPersonalMemoryForPurpose(
    purpose,
    extras?.personalMemory ?? null,
  ).block;

  const estimatedChars = systemPrompt.length;
  const isOverPolicyBudget = estimatedChars > policy.maxContextChars;
  return {
    purpose,
    systemPrompt,
    crossFeatureContext,
    personalMemoryContext,
    policy,
    estimatedChars,
    isOverPolicyBudget,
    omitted,
    warnings: isOverPolicyBudget ? ['over_policy_budget'] : [],
  };
}

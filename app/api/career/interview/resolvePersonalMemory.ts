// PASSAI CAREER — 面接 route 共有: Personal Memory（Data Spine Layer 2）の解決。
//
// 背景（cross-feature audit の指摘）:
//   `personalMemorySectionsForPurpose` は `interview_practice` を allowlist に持ち、
//   orchestrator も `extras.personalMemory` → `personalMemoryContext` を返せる状態だったのに、
//   `loadPersonalMemorySectionsForPrompt` を呼ぶ route が company-research の 1 本しか無く、
//   面接では **常に空**だった（read 契約はあるが未通電）。
//
// 本モジュールは company-research route の実装（load → 観測 → dedupe）を
// **雛形どおりに**共有化したもの。start / turn / complete の 3 route が同じ 1 関数を呼ぶ。
//
// ★ dedupe（重複注入をしない）が本モジュールの中核:
//   面接の base system prompt は profile/activity/values を **必ず**描画し、
//   crossFeatureContext は自己分析 / ES block を「実際に render できたときだけ」描画する。
//   したがって presence は「body に field がある」ではなく
//   **「その block を実際に描画するか」**（renderer の出力が空でないか）で判定する。
//   ＝ bridge wins / memory fills gaps。prompt は増える方向にしか変わらない。
//
// 厳守:
//   - never-throw / fail-open。失敗・flag OFF・gate deny では空配列（＝従来 prompt と byte 互換）。
//   - 新しい dedupe / loader を実装しない（既存の純関数・既存 loader を使う）。
//   - PII / 本文 / UUID を log しない。

import 'server-only';

import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerPersonalMemorySection } from '@/lib/careerMemory/persistence/schema';
import { loadPersonalMemorySectionsForPrompt } from '@/lib/careerMemory/persistence/personalMemoryReadServer.server';
// 4 手順（sync signal → loader → 観測 → dedupe）は全 route 共有の seam に集約済み。
import { resolvePersonalMemoryForPurpose } from '../resolvePersonalMemoryContext';
// bridge block の presence 判定は **prompt に実際に載る renderer** を正本にする
//   （別実装で判定すると dedupe が prompt と乖離する）。
import {
  renderSelfAnalysis,
  renderEs,
} from '@/lib/careerMemory/renderers/interviewCrossFeature';

export type InterviewPersonalMemoryInputs = {
  /** crossFeatureContext に載る自己分析（bridge / server いずれか解決済み）。 */
  selfAnalysis: CareerSelfAnalysisResult | null;
  /** crossFeatureContext に載る ES（bridge / server いずれか解決済み）。 */
  es: CareerEsResult | null;
};

/**
 * 面接 prompt へ載せてよい Personal Memory section を返す（never-throw・fail-open）。
 *
 * ★ 観測は **1 request 1 件**。面接 route は `resolveInterviewContextInputs` が既に
 *   context 観測を 1 件打っているため、こちらは `context: null` で memory / sync だけを記録する
 *   （purpose あたりの counter を二重計上しない）。
 */
export async function resolveInterviewPersonalMemory(
  inputs: InterviewPersonalMemoryInputs,
  req?: Request,
  loadSections = loadPersonalMemorySectionsForPrompt,
): Promise<readonly CareerPersonalMemorySection[]> {
  // interview の allowlist section は base / self_analysis / es（personalMemoryPromptContext）。
  //   base : base system prompt が profile/activity/values を必ず描画するため常に重複。
  //   self_analysis / es : crossFeature renderer が実際に block を出すときだけ重複。
  // `D-S13`: req を渡すことで、同 request で context resolver が読んだ kind は再 read されない。
  return resolvePersonalMemoryForPurpose({
    purpose: 'interview_practice',
    presence: {
      base: true,
      self_analysis: renderSelfAnalysis(inputs.selfAnalysis) !== '',
      es: renderEs(inputs.es) !== '',
    },
    req,
    // context 観測は resolveInterviewContextInputs 側の 1 件へ集約済み（ここでは打たない）。
    contextOutcome: null,
    loadSections,
  });
}

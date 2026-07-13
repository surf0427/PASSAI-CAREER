/**
 * Context Loaders — Data Spine 差し込み口の barrel（P17-A §7・全て disabled）。
 *
 * これらの loader は Context Orchestrator の **上流** に置かれる想定の契約であり、
 * 本 series では production / route / prompt / Orchestrator から import されない
 * （import 0 件を static guard QA が保証する）。
 *
 * Orchestrator（lib/careerContext/orchestrator.ts）は純関数のまま変更しない。
 * 将来 available を返す実装へ差し替える際も、Orchestrator へ I/O を持ち込まず
 * CareerContextExtras 経由で `available` のみを注入する（disabled/blocked/stale は空 block）。
 */

export {
  loadAggregatedInsightContext,
  type LoadAggregatedInsightInput,
} from './aggregatedInsight';
export {
  loadCompanyKnowledgeContext,
  type LoadCompanyKnowledgeInput,
} from './companyKnowledge';
export {
  loadPersonalMemoryContext,
  type LoadPersonalMemoryInput,
  type PersonalMemoryContextProjection,
} from './personalMemory';

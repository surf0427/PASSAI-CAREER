// PASSAI CAREER — 企業研究添削 route: cross-feature context の解決（Batch 2 / `D-S6`）。
//
// 残っていた bridge は 2 つだけ:
//   - `selfAnalysis`: client の `loadSelfAnalysisLogs()[0]?.result`（＝最新 1 件の result）
//   - `matching`    : client の `loadMatchingLogs()[0]?.result`（＝最新 1 件の result）
// どちらも「最新 log の result」という **同一の projection**。server 側でも同じ規則で取り出す。
//
// ★ drift 防止:
//   この "latest log result" は client（app/career/company-research/do/page.tsx）と
//   pure selector（interview projection）の両方と同じ規則である必要がある。
//   `scripts/career-server-context-batch2-qa.ts` [B2-6] が
//   「本 module の抽出結果 == selector の projection」を fixture で固定している。
//
// ★ 重複注入をしない:
//   本 route は Personal Memory も注入する。`dedupePersonalMemorySections` の `presence` は
//   **実際に描画される block の有無**で判定するため、server 由来へ切り替えても
//   「self_analysis block を描画する ⟹ memory の self_analysis section を落とす」が保たれる
//   （route 側は `selfAnalysisBlock !== ''` を渡し続ける）。
//
// 厳守: never-throw / fail-open / context を減らさない / PII・本文・UUID を log しない。

import type { CareerSelfAnalysisLog, CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerMatchingLog } from '@/types/careerMatching';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import { loadPurposeServerContext } from '@/lib/careerServerContext/purposeContext.server';
import type { CareerSourceKind } from '@/lib/careerSourceData/types';
import type { BaseContextDecisionReason } from '@/lib/careerServerContext/baseContextPolicy';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type {
  CanaryPurposeCoverage,
  CanarySourceOrigin,
} from '@/lib/careerDataSpineCanary/observation';
import {
  pickSourceOrigins,
  pickSourceVerdicts,
  toPurposeCoverage,
} from '@/lib/careerDataSpineCanary/sourceObservation';

/** company_research_review purpose が必要とする Source kind。 */
export const COMPANY_RESEARCH_SOURCE_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
  'self_analysis',
  'matching',
];

/** 「最新 log の result」（client / selector と同一規則。log 配列は新しい順）。 */
export function latestSelfAnalysisResult(
  logs: readonly CareerSelfAnalysisLog[] | null | undefined,
): CareerSelfAnalysisResult | null {
  return logs && logs.length > 0 ? logs[0].result ?? null : null;
}

export function latestMatchingResult(
  logs: readonly CareerMatchingLog[] | null | undefined,
): CareerMatchEngineResult | null {
  return logs && logs.length > 0 ? logs[0].result ?? null : null;
}

export type CompanyResearchContextField = 'base' | 'selfAnalysis' | 'matching';

export type CompanyResearchContextInputs = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  selfAnalysis: CareerSelfAnalysisResult | null;
  matching: CareerMatchEngineResult | null;
  source: BaseContextDecisionReason;
  origins: Readonly<Record<CompanyResearchContextField, 'server' | 'bridge'>>;
  /**
   * 観測用（enum のみ）。★ 本 route は Personal Memory の観測を **1 request 1 件** 記録するため、
   * resolver 側では counter を打たず、route の既存 1 件へ合流させる（二重計上を作らない）。
   */
  observation: {
    sourceOrigins: Readonly<Record<string, CanarySourceOrigin>>;
    sourceVerdicts: Readonly<Record<string, string>>;
    coverage: CanaryPurposeCoverage;
  };
};

export type CompanyResearchBridgeInputs = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  selfAnalysis?: CareerSelfAnalysisResult | null;
  matching?: CareerMatchEngineResult | null;
};

/**
 * base + selfAnalysis + matching を 1 回の Layer 1 read で解決する（never-throw・fail-open）。
 */
export async function resolveCompanyResearchContextInputs(
  b: CompanyResearchBridgeInputs,
  req?: Request,
  loadContext = loadPurposeServerContext,
): Promise<CompanyResearchContextInputs> {
  const fallback: CompanyResearchContextInputs = {
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    selfAnalysis: b.selfAnalysis ?? null,
    matching: b.matching ?? null,
    source: 'flag_off',
    origins: { base: 'bridge', selfAnalysis: 'bridge', matching: 'bridge' },
    observation: { sourceOrigins: {}, sourceVerdicts: {}, coverage: 'gated_off' },
  };
  try {
    const ctx = await loadContext('company_research_review', COMPANY_RESEARCH_SOURCE_KINDS, req);

    const serverSelfAnalysis = latestSelfAnalysisResult(ctx.sources.selfAnalysisLogs);
    const serverMatching = latestMatchingResult(ctx.sources.matchingLogs);

    const useSelfAnalysis =
      ctx.origin.self_analysis === 'server' && !(serverSelfAnalysis === null && fallback.selfAnalysis !== null);
    const useMatching =
      ctx.origin.matching === 'server' && !(serverMatching === null && fallback.matching !== null);

    return {
      profile: ctx.base ? ctx.base.profile : fallback.profile,
      activity: ctx.base ? ctx.base.activity : fallback.activity,
      values: ctx.base ? ctx.base.values : fallback.values,
      selfAnalysis: useSelfAnalysis ? serverSelfAnalysis : fallback.selfAnalysis,
      matching: useMatching ? serverMatching : fallback.matching,
      source: ctx.baseReason,
      origins: {
        base: ctx.base ? 'server' : 'bridge',
        selfAnalysis: useSelfAnalysis ? 'server' : 'bridge',
        matching: useMatching ? 'server' : 'bridge',
      },
      observation: {
        sourceOrigins: pickSourceOrigins(ctx, COMPANY_RESEARCH_SOURCE_KINDS),
        sourceVerdicts: pickSourceVerdicts(ctx, COMPANY_RESEARCH_SOURCE_KINDS),
        coverage: toPurposeCoverage(ctx.status),
      },
    };
  } catch {
    return { ...fallback, source: 'source_unavailable' };
  }
}

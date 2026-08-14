// PASSAI CAREER — 自己分析 route 共有: context 入力の解決（Closure Batch / `D-S9`）。
//
// 対象 purpose:
//   - `self_analysis`（要約生成 / route.ts → lib/careerSelfAnalysis/summaryPrompt.ts）
//   - `self_analysis_deep_dive`（深掘り質問生成 / question/route.ts → deepDivePrompt.ts）
//
// この 2 purpose が使う personal source は:
//   base（profile / activity / values）+ `pastSummaries`（＝過去の自己分析ログの軽量サマリ）
// だけで、いずれも server-readable。したがって **FULL_SERVER 到達**（`D-S8`）。
//
// ★ `pastSummaries` は client（app/career/self-analysis/run/page.tsx）が
//   `buildSelfAnalysisPastSummaries(loadSelfAnalysisLogs())` で作る。
//   server 側も **同じ pure 関数**を Layer 1 の self_analysis log に対して呼ぶため、
//   件数上限（SELF_ANALYSIS_PAST_LIMIT）・truncate 長・field 集合が完全に一致する。
//
// ★ `conversation` / `userInput` / `theme` は **その request 固有の入力**であり
//   Layer 1 の personal source ではない。server 化対象外（body のまま）。
//
// 厳守: never-throw / fail-open / context を減らさない / PII・本文・UUID を log しない。

import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import {
  buildSelfAnalysisPastSummaries,
  type SelfAnalysisPastSummary,
} from '@/lib/careerSelfAnalysis/pastLogSummary';
import { loadPurposeServerContext } from '@/lib/careerServerContext/purposeContext.server';
import type { CareerSourceKind } from '@/lib/careerSourceData/types';
import type { BaseContextDecisionReason } from '@/lib/careerServerContext/baseContextPolicy';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import { normalizeContextOutcome } from '@/lib/careerDataSpineCanary/observation';
import { recordCanaryObservation } from '@/lib/careerDataSpineCanary/counters.server';
import {
  pickSourceOrigins,
  pickSourceVerdicts,
  toPurposeCoverage,
} from '@/lib/careerDataSpineCanary/sourceObservation';

/** 自己分析系 purpose が必要とする Source kind（すべて server-readable）。 */
export const SELF_ANALYSIS_SOURCE_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
  'self_analysis',
];

export type SelfAnalysisContextField = 'base' | 'pastSummaries';

export type SelfAnalysisContextInputs = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  pastSummaries: SelfAnalysisPastSummary[];
  source: BaseContextDecisionReason;
  origins: Readonly<Record<SelfAnalysisContextField, 'server' | 'bridge'>>;
};

export type SelfAnalysisBridgeInputs = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  pastSummaries: SelfAnalysisPastSummary[];
};

/**
 * base + pastSummaries を 1 回の Layer 1 read で解決する（never-throw・fail-open）。
 *
 * `purpose` で `self_analysis` / `self_analysis_deep_dive` を切り替える
 * （canary の purpose opt-in を purpose 単位で効かせるため）。
 */
export async function resolveSelfAnalysisContextInputs(
  purpose: Extract<CareerContextPurpose, 'self_analysis' | 'self_analysis_deep_dive'>,
  b: SelfAnalysisBridgeInputs,
  req?: Request,
  loadContext = loadPurposeServerContext,
): Promise<SelfAnalysisContextInputs> {
  const fallback: SelfAnalysisContextInputs = {
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    pastSummaries: b.pastSummaries,
    source: 'flag_off',
    origins: { base: 'bridge', pastSummaries: 'bridge' },
  };
  try {
    const ctx = await loadContext(purpose, SELF_ANALYSIS_SOURCE_KINDS, req);

    recordCanaryObservation({
      purpose,
      sync: null,
      memory: null,
      context: normalizeContextOutcome(ctx.baseReason),
      memorySectionCount: 0,
      sourceOrigins: pickSourceOrigins(ctx, SELF_ANALYSIS_SOURCE_KINDS),
      sourceVerdicts: pickSourceVerdicts(ctx, SELF_ANALYSIS_SOURCE_KINDS),
      coverage: toPurposeCoverage(ctx.status),
    });

    // client と同一の pure 関数（件数上限・truncate 長・field 集合が一致する）。
    const serverPastSummaries = buildSelfAnalysisPastSummaries(ctx.sources.selfAnalysisLogs ?? []);

    // context を減らさない: server が空で bridge に中身があるなら bridge のまま。
    const usePast =
      ctx.origin.self_analysis === 'server' &&
      !(serverPastSummaries.length === 0 && fallback.pastSummaries.length > 0);

    return {
      profile: ctx.base ? ctx.base.profile : fallback.profile,
      activity: ctx.base ? ctx.base.activity : fallback.activity,
      values: ctx.base ? ctx.base.values : fallback.values,
      pastSummaries: usePast ? serverPastSummaries : fallback.pastSummaries,
      source: ctx.baseReason,
      origins: {
        base: ctx.base ? 'server' : 'bridge',
        pastSummaries: usePast ? 'server' : 'bridge',
      },
    };
  } catch {
    return { ...fallback, source: 'source_unavailable' };
  }
}

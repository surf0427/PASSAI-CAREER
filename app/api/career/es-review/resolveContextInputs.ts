// PASSAI CAREER — ES 添削 route: User Data Spine context の解決。
//
// 既存の company_research_review / interview_practice の resolver と **同型**:
//   client と同じ pure selector（`buildEsReviewRequestContext`）を、
//   Source-Sync verified な Layer 1 の生データに対して実行し、field 単位で server / bridge を択一する。
//
// ★ parity の根拠:
//   server 側は client と同じ selector を同じ生データ（verified ⟹ mirror == client canonical）へ
//   適用する。よって verified な kind の出力は request body の該当 field と意味的に同一になる。
//   ＝ server 化は出力を変えず「どこから来たか」だけを変える。
//
// ★ 重複注入をしない: field ごとに server か bridge の **どちらか一方**だけを採る。
// ★ context を減らさない: server が空で bridge に中身があるときは bridge を採る。
//
// 厳守: never-throw / fail-open（何が起きても bridge へ倒す）/ PII・本文・UUID を log しない。

import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import { latestEsSelfAnalysisResult } from '@/lib/careerEs/reviewContext';
import { loadPurposeServerContext } from '@/lib/careerServerContext/purposeContext.server';
import type { CareerSourceKind } from '@/lib/careerSourceData/types';
import type { BaseContextDecisionReason } from '@/lib/careerServerContext/baseContextPolicy';
import { normalizeContextOutcome } from '@/lib/careerDataSpineCanary/observation';
import { recordCanaryObservation } from '@/lib/careerDataSpineCanary/counters.server';
import {
  pickSourceOrigins,
  pickSourceVerdicts,
  toPurposeCoverage,
} from '@/lib/careerDataSpineCanary/sourceObservation';

/** es_review purpose が必要とする Source kind（base 3 + 自己分析）。 */
export const ES_REVIEW_SOURCE_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
  'self_analysis',
];

export type EsReviewContextField = 'base' | 'selfAnalysis';

export type EsReviewBridgeInputs = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  selfAnalysis?: CareerSelfAnalysisResult | null;
};

export type EsReviewContextInputs = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  selfAnalysis: CareerSelfAnalysisResult | null;
  /** 観測用（route 挙動には影響しない）。 */
  source: BaseContextDecisionReason;
  /** field 別の採用元（QA / 観測用・PII なし）。 */
  origins: Readonly<Record<EsReviewContextField, 'server' | 'bridge'>>;
};

const ALL_BRIDGE_ORIGINS: Readonly<Record<EsReviewContextField, 'server' | 'bridge'>> = {
  base: 'bridge',
  selfAnalysis: 'bridge',
};

/**
 * base + selfAnalysis を 1 回の Layer 1 read で解決する（never-throw・fail-open）。
 *
 * server context canary が無効な環境（既定）では I/O ゼロで bridge をそのまま返すため、
 * 出力は request body の値と完全に一致する。
 */
export async function resolveEsReviewContextInputs(
  b: EsReviewBridgeInputs,
  req?: Request,
  loadContext = loadPurposeServerContext,
): Promise<EsReviewContextInputs> {
  const bridge: EsReviewContextInputs = {
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    selfAnalysis: b.selfAnalysis ?? null,
    source: 'flag_off',
    origins: ALL_BRIDGE_ORIGINS,
  };

  try {
    const ctx = await loadContext('es_review', ES_REVIEW_SOURCE_KINDS, req);

    recordCanaryObservation({
      purpose: 'es_review',
      sync: null,
      memory: null,
      context: normalizeContextOutcome(ctx.baseReason),
      memorySectionCount: 0,
      sourceOrigins: pickSourceOrigins(ctx, ES_REVIEW_SOURCE_KINDS),
      sourceVerdicts: pickSourceVerdicts(ctx, ES_REVIEW_SOURCE_KINDS),
      coverage: toPurposeCoverage(ctx.status),
    });

    // client と同一の pure selector を server 生データで実行する（最新 1 件の規則が保存される）。
    const serverSelfAnalysis = latestEsSelfAnalysisResult(ctx.sources.selfAnalysisLogs);
    // 「server が verified」かつ「context を減らさない」ときだけ server を採る。
    const useSelfAnalysis =
      ctx.origin.self_analysis === 'server' &&
      !(serverSelfAnalysis === null && bridge.selfAnalysis !== null);

    return {
      profile: ctx.base ? ctx.base.profile : bridge.profile,
      activity: ctx.base ? ctx.base.activity : bridge.activity,
      values: ctx.base ? ctx.base.values : bridge.values,
      selfAnalysis: useSelfAnalysis ? serverSelfAnalysis : bridge.selfAnalysis,
      source: ctx.baseReason,
      origins: {
        base: ctx.base ? 'server' : 'bridge',
        selfAnalysis: useSelfAnalysis ? 'server' : 'bridge',
      },
    };
  } catch {
    return { ...bridge, source: 'source_unavailable' };
  }
}

// PASSAI CAREER — プレゼン route 共有: context 入力の解決（Closure Batch / `D-S9`）。
//
// theme / evaluate / qa の 3 route が共有する。Batch 2 と同一の形:
//   client と同じ pure selector（`buildPresentationRequestContext`）を検証済み Layer 1 の
//   生データで実行し、field 単位で server / bridge を択一する。
//
// ★ この purpose は **FULL_SERVER 到達**（`D-S8` の定義）:
//   使用する personal source（profile / activity / values / self_analysis / es / interview /
//   matching / consultation）が **すべて server-readable**。structural bridge はゼロ。
//   request body の field は canary 期間の safety fallback としてのみ残る。
//
// ★ `config.useCareerContext` は **ユーザーの明示的な同意 toggle**（お題プレゼンで
//   自分の career context を使うか）。これは personal data の source ではなく
//   **UI 上の選択**なので server 側では導出せず、body の値をそのまま尊重する。
//   toggle が false のときは renderer が cross-feature block を描画しないため、
//   server 化しても prompt は増えない。
//
// 厳守: never-throw / fail-open / context を減らさない / PII・本文・UUID を log しない。

import { buildPresentationRequestContext } from '@/lib/careerMemory/selector';
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

/** presentation purpose が必要とする Source kind（すべて server-readable）。 */
export const PRESENTATION_SOURCE_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
  'self_analysis',
  'es',
  'interview',
  'matching',
  'consultation',
];

type PresentationCross = {
  selfAnalysis: unknown;
  es: unknown;
  interview: unknown;
  matching: unknown;
  consultationInsights: string[] | null;
};

export type PresentationContextField = keyof PresentationCross | 'base';

export type PresentationContextInputs = PresentationCross & {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  source: BaseContextDecisionReason;
  origins: Readonly<Record<PresentationContextField, 'server' | 'bridge'>>;
};

const FIELD_KIND: Readonly<Record<keyof PresentationCross, CareerSourceKind>> = {
  selfAnalysis: 'self_analysis',
  es: 'es',
  interview: 'interview',
  matching: 'matching',
  consultationInsights: 'consultation',
};

export type PresentationBridgeInputs = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  selfAnalysis?: unknown;
  es?: unknown;
  interview?: unknown;
  matching?: unknown;
  consultationInsights?: string[] | null;
};

function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * base + cross-feature を 1 回の Layer 1 read で解決する（never-throw・fail-open）。
 */
export async function resolvePresentationContextInputs(
  b: PresentationBridgeInputs,
  req?: Request,
  loadContext = loadPurposeServerContext,
): Promise<PresentationContextInputs> {
  const fallback: PresentationContextInputs = {
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    selfAnalysis: b.selfAnalysis ?? null,
    es: b.es ?? null,
    interview: b.interview ?? null,
    matching: b.matching ?? null,
    consultationInsights: b.consultationInsights ?? null,
    source: 'flag_off',
    origins: {
      base: 'bridge',
      selfAnalysis: 'bridge',
      es: 'bridge',
      interview: 'bridge',
      matching: 'bridge',
      consultationInsights: 'bridge',
    },
  };
  try {
    const ctx = await loadContext('presentation_feedback', PRESENTATION_SOURCE_KINDS, req);

    recordCanaryObservation({
      purpose: 'presentation_feedback',
      sync: null,
      memory: null,
      context: normalizeContextOutcome(ctx.baseReason),
      memorySectionCount: 0,
      sourceOrigins: pickSourceOrigins(ctx, PRESENTATION_SOURCE_KINDS),
      sourceVerdicts: pickSourceVerdicts(ctx, PRESENTATION_SOURCE_KINDS),
      coverage: toPurposeCoverage(ctx.status),
    });

    const serverPayload = buildPresentationRequestContext({
      profile: ctx.sources.profile,
      activity: ctx.sources.activity,
      values: ctx.sources.values,
      selfAnalysisLogs: ctx.sources.selfAnalysisLogs ?? [],
      esLogs: ctx.sources.esLogs ?? [],
      interviewResults: ctx.sources.interviewResults ?? [],
      matchingLogs: ctx.sources.matchingLogs ?? [],
      consultationThreads: ctx.sources.consultationThreads ?? [],
    });

    const serverCross: PresentationCross = {
      selfAnalysis: serverPayload.selfAnalysis,
      es: serverPayload.es,
      interview: serverPayload.interview,
      matching: serverPayload.matching,
      consultationInsights: serverPayload.consultationInsights,
    };

    const out = { ...fallback, source: ctx.baseReason } as PresentationContextInputs;
    const origins = { ...fallback.origins } as Record<PresentationContextField, 'server' | 'bridge'>;

    if (ctx.base) {
      out.profile = ctx.base.profile;
      out.activity = ctx.base.activity;
      out.values = ctx.base.values;
      origins.base = 'server';
    }

    for (const field of Object.keys(FIELD_KIND) as (keyof PresentationCross)[]) {
      const kind = FIELD_KIND[field];
      if (ctx.origin[kind] !== 'server') continue;
      const serverValue = serverCross[field];
      if (!present(serverValue) && present(fallback[field])) continue;
      (out as Record<string, unknown>)[field] = serverValue;
      origins[field] = 'server';
    }

    out.origins = origins;
    return out;
  } catch {
    return { ...fallback, source: 'source_unavailable' };
  }
}

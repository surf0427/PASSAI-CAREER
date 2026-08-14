// PASSAI CAREER — マッチング route: context 入力の解決（Closure Batch / `D-S9`）。
//
// Batch 2 と同じ形。client と同じ pure selector（`buildMatchingRequestContext`）を、
// 検証済み Layer 1 の生データで実行し、field 単位で server / bridge を択一する。
//
// ★ 本 route に固有の注意（決定的エンジン）:
//   matching は prompt だけでなく **決定的スコアエンジン**（`buildMeasuredReadiness` /
//   `runCareerMatch`）にも同じ personal data を渡す。したがって server 化は
//   「AI の入力」だけでなく「スコアの入力」も切り替えることになる。
//   これが安全なのは Batch 2 と同じ理由による:
//     verified ⟹ mirror == client canonical ⟹ 同じ selector が同じ値を返す
//   ＝ engine 入力も byte 一致する。QA `POC-3` / `C-4` が固定する。
//
// ★ server 化しないもの:
//   - `gd`（ソロ GD）: server-readable representation が存在しない（**structural bridge** / `D-S11`）。
//   - `gdRoom` は server-authoritative（class 2）として server 化する（`D-S10`）。
//
// 厳守: never-throw / fail-open / context を減らさない / PII・本文・UUID を log しない。

import { buildMatchingRequestContext } from '@/lib/careerMemory/selector';
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
  markStructuralBridges,
  pickSourceOrigins,
  pickSourceVerdicts,
  toPurposeCoverage,
} from '@/lib/careerDataSpineCanary/sourceObservation';

/** matching purpose が必要とする Source kind（solo gd は server-readable でないため含めない）。 */
export const MATCHING_SOURCE_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
  'self_analysis',
  'es',
  'interview',
  'consultation',
  'gd_room',
];

type MatchingCross = {
  selfAnalysis: unknown;
  es: unknown;
  interviewResult: unknown;
  consultation: unknown;
  gdRoomSignals: unknown[];
};

export type MatchingContextField = keyof MatchingCross | 'base';

export type MatchingContextInputs = MatchingCross & {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  source: BaseContextDecisionReason;
  origins: Readonly<Record<MatchingContextField, 'server' | 'bridge'>>;
};

/** cross field → 由来 Source kind。 */
const FIELD_KIND: Readonly<Record<keyof MatchingCross, CareerSourceKind>> = {
  selfAnalysis: 'self_analysis',
  es: 'es',
  interviewResult: 'interview',
  consultation: 'consultation',
  gdRoomSignals: 'gd_room',
};

export type MatchingBridgeInputs = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  selfAnalysis?: unknown;
  es?: unknown;
  interviewResult?: unknown;
  consultation?: unknown;
  gdRoomSignals: unknown[];
};

/** 中身のある値か（null / undefined / 空配列は「無い」）。 */
function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * base + cross-feature を 1 回の Layer 1 read で解決する（never-throw・fail-open）。
 */
export async function resolveMatchingContextInputs(
  b: MatchingBridgeInputs,
  req?: Request,
  loadContext = loadPurposeServerContext,
): Promise<MatchingContextInputs> {
  const fallback: MatchingContextInputs = {
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    selfAnalysis: b.selfAnalysis ?? null,
    es: b.es ?? null,
    interviewResult: b.interviewResult ?? null,
    consultation: b.consultation ?? null,
    gdRoomSignals: b.gdRoomSignals,
    source: 'flag_off',
    origins: {
      base: 'bridge',
      selfAnalysis: 'bridge',
      es: 'bridge',
      interviewResult: 'bridge',
      consultation: 'bridge',
      gdRoomSignals: 'bridge',
    },
  };
  try {
    const ctx = await loadContext('matching', MATCHING_SOURCE_KINDS, req);

    recordCanaryObservation({
      purpose: 'matching',
      sync: null,
      memory: null,
      context: normalizeContextOutcome(ctx.baseReason),
      memorySectionCount: 0,
      sourceOrigins: {
        ...pickSourceOrigins(ctx, MATCHING_SOURCE_KINDS),
        // ★ solo GD は server-readable representation が無い **structural bridge**。
        //   safety fallback bridge と混同しないよう別値で数える（`D-S11`）。
        ...markStructuralBridges(['gd_solo']),
      },
      sourceVerdicts: pickSourceVerdicts(ctx, MATCHING_SOURCE_KINDS),
      coverage: toPurposeCoverage(ctx.status),
    });

    // client と同一の pure selector（latest 選択・件数上限・圧縮が保存される）。
    // solo gd は server 化対象外なので空で渡し、bridge 側の値を route が使い続ける。
    const serverPayload = buildMatchingRequestContext({
      profile: ctx.sources.profile,
      activity: ctx.sources.activity,
      values: ctx.sources.values,
      selfAnalysisLogs: ctx.sources.selfAnalysisLogs ?? [],
      esLogs: ctx.sources.esLogs ?? [],
      interviewResults: ctx.sources.interviewResults ?? [],
      consultationThreads: ctx.sources.consultationThreads ?? [],
      gdResults: [],
      gdRoomLogs: ctx.sources.gdRoomLogs ?? [],
      gdResultId: null,
    });

    const serverCross: MatchingCross = {
      selfAnalysis: serverPayload.selfAnalysis,
      es: serverPayload.es,
      interviewResult: serverPayload.interviewResult,
      consultation: serverPayload.consultation,
      gdRoomSignals: serverPayload.gdRoomSignals,
    };

    const out = { ...fallback, source: ctx.baseReason } as MatchingContextInputs;
    const origins = { ...fallback.origins } as Record<MatchingContextField, 'server' | 'bridge'>;

    if (ctx.base) {
      out.profile = ctx.base.profile;
      out.activity = ctx.base.activity;
      out.values = ctx.base.values;
      origins.base = 'server';
    }

    for (const field of Object.keys(FIELD_KIND) as (keyof MatchingCross)[]) {
      const kind = FIELD_KIND[field];
      if (ctx.origin[kind] !== 'server') continue;
      const serverValue = serverCross[field];
      // context を減らさない: server が空で bridge に中身があるなら bridge のまま。
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

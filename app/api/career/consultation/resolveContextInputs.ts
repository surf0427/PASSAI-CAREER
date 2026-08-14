// PASSAI CAREER — 相談 route: cross-feature context の解決（Batch 2 / `D-S6`）。
//
// Batch 1 では base（profile/activity/values）だけを server 化していた。Batch 2 は同じ 1 回の
// Layer 1 read で cross-feature（selfAnalysisHistory / esHistory / interviewHistory /
// presentationHistory / companyResearch / matching）も **kind 単位**で server 化する。
//
// ★ server 化しないもの（意図的・`D-S6`）:
//   - `gd`（ソロ GD）: Supabase mirror が存在しない → server から読めない。永続 bridge。
//   - `gdRoom`: mirror はあるが **server 側が書く**データで canonical 前提が異なる。永続 bridge。
//   - `eventSignals`: Layer 3 由来。route が現行位置で resolve する（`D-L3` の層分離）。触らない。
//   - 旧 client 互換の単数 field（`selfAnalysis` / `es` / `interviewResult` / `presentationResult`）:
//     renderer が「history があれば history、無ければ単数」を選ぶため、
//     server history を採用したときは単数 block は **描画されない**（重複しない）。
//
// parity の根拠は interview 側と同一: client と同じ pure selector を、verified な
// （＝client canonical と一致する）server 生データで実行する。
//
// 厳守: never-throw / fail-open / context を減らさない / PII・本文・UUID を log しない。

import { buildConsultationRequestContext } from '@/lib/careerMemory/selector';
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

/** consultation purpose が必要とする Source kind（gd / gd_room は mirror 非対象のため含めない）。 */
export const CONSULTATION_SOURCE_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
  'self_analysis',
  'es',
  'interview',
  'presentation',
  'company_research',
  'matching',
];

type ConsultationCross = {
  selfAnalysisHistory: unknown[];
  esHistory: unknown[];
  interviewHistory: unknown[];
  presentationHistory: unknown[];
  companyResearch: unknown[];
  matching: unknown[];
};

export type ConsultationContextField = keyof ConsultationCross | 'base';

export type ConsultationContextInputs = ConsultationCross & {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  source: BaseContextDecisionReason;
  origins: Readonly<Record<ConsultationContextField, 'server' | 'bridge'>>;
};

/** cross field → 由来 Source kind。 */
const FIELD_KIND: Readonly<Record<keyof ConsultationCross, CareerSourceKind>> = {
  selfAnalysisHistory: 'self_analysis',
  esHistory: 'es',
  interviewHistory: 'interview',
  presentationHistory: 'presentation',
  companyResearch: 'company_research',
  matching: 'matching',
};

export type ConsultationBridgeInputs = ConsultationCross & {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
};

/**
 * base + cross-feature を 1 回の Layer 1 read で解決する（never-throw・fail-open）。
 *
 * `bridge` には route が既に normalize 済みの request body 由来の値を渡すこと
 * （server が使えない field はそのまま返る＝従来挙動）。
 */
export async function resolveConsultationContextInputs(
  bridge: ConsultationBridgeInputs,
  req?: Request,
  loadContext = loadPurposeServerContext,
): Promise<ConsultationContextInputs> {
  const fallback: ConsultationContextInputs = {
    profile: bridge.profile ?? null,
    activity: bridge.activity ?? null,
    values: bridge.values ?? null,
    selfAnalysisHistory: bridge.selfAnalysisHistory,
    esHistory: bridge.esHistory,
    interviewHistory: bridge.interviewHistory,
    presentationHistory: bridge.presentationHistory,
    companyResearch: bridge.companyResearch,
    matching: bridge.matching,
    source: 'flag_off',
    origins: {
      base: 'bridge',
      selfAnalysisHistory: 'bridge',
      esHistory: 'bridge',
      interviewHistory: 'bridge',
      presentationHistory: 'bridge',
      companyResearch: 'bridge',
      matching: 'bridge',
    },
  };
  try {
    const ctx = await loadContext('consultation', CONSULTATION_SOURCE_KINDS, req);

    recordCanaryObservation({
      purpose: 'consultation',
      sync: null,
      memory: null,
      context: normalizeContextOutcome(ctx.baseReason),
      memorySectionCount: 0,
      // Batch 2: source kind 別の採用元 / verdict / coverage（enum のみ）。
      sourceOrigins: pickSourceOrigins(ctx, CONSULTATION_SOURCE_KINDS),
      sourceVerdicts: pickSourceVerdicts(ctx, CONSULTATION_SOURCE_KINDS),
      coverage: toPurposeCoverage(ctx.status),
    });

    // client と同一の pure selector（履歴件数上限・圧縮・fallback がそのまま保存される）。
    // gd / gdRoom は server 化対象外なので空配列で渡す（bridge 側の値を後段で使う）。
    const serverPayload = buildConsultationRequestContext({
      profile: ctx.sources.profile,
      activity: ctx.sources.activity,
      values: ctx.sources.values,
      selfAnalysisLogs: ctx.sources.selfAnalysisLogs ?? [],
      esLogs: ctx.sources.esLogs ?? [],
      interviewResults: ctx.sources.interviewResults ?? [],
      presentationResults: ctx.sources.presentationResults ?? [],
      companyResearchLogs: ctx.sources.companyResearchLogs ?? [],
      gdResults: [],
      gdRoomLogs: [],
      matchingLogs: ctx.sources.matchingLogs ?? [],
      gdResultId: null,
    });

    const serverCross: ConsultationCross = {
      selfAnalysisHistory: serverPayload.selfAnalysisHistory,
      esHistory: serverPayload.esHistory,
      interviewHistory: serverPayload.interviewHistory,
      presentationHistory: serverPayload.presentationHistory,
      companyResearch: serverPayload.companyResearch,
      matching: serverPayload.matching,
    };

    const out = { ...fallback, source: ctx.baseReason } as ConsultationContextInputs;
    const origins = { ...fallback.origins } as Record<ConsultationContextField, 'server' | 'bridge'>;

    if (ctx.base) {
      out.profile = ctx.base.profile;
      out.activity = ctx.base.activity;
      out.values = ctx.base.values;
      origins.base = 'server';
    }

    for (const field of Object.keys(FIELD_KIND) as (keyof ConsultationCross)[]) {
      const kind = FIELD_KIND[field];
      if (ctx.origin[kind] !== 'server') continue;
      const serverValue = serverCross[field];
      const bridgeValue = fallback[field];
      // context を減らさない: server が空で bridge に中身があるなら bridge のまま。
      if (serverValue.length === 0 && bridgeValue.length > 0) continue;
      out[field] = serverValue;
      origins[field] = 'server';
    }

    out.origins = origins;
    return out;
  } catch {
    return { ...fallback, source: 'source_unavailable' };
  }
}

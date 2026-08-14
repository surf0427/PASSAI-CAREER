// PASSAI CAREER — 面接 route 共有: context 入力の解決（Batch 2 / `D-S6`）。
//
// Batch 1 では base（profile/activity/values）だけを server 化していた（resolveBaseInputs.ts）。
// Batch 2 は同じ 1 回の Layer 1 read で **cross-feature bridge（selfAnalysis / es / matching /
// consultationInsights / companyResearch）も kind 単位で server 化**する。
//
// ★ parity の根拠（ここが本 slice の安全性の中核）:
//   server 側は client と **同じ pure selector**（`buildInterviewRequestContext`）を、
//   **同じ生データ**（Source-Sync verified ⟹ mirror == client canonical）に対して実行する。
//   よって verified な kind の出力は request body の該当 field と **意味的に同一**になる。
//   ＝ server 化は出力を変えずに「どこから来たか」だけを変える。
//
// ★ 重複注入をしない:
//   field ごとに server か bridge の **どちらか一方**を選ぶ。両方を prompt へ入れる経路は存在しない
//   （payload は 1 つしか組み立てられない）。
//
// ★ companyResearch の logId について:
//   どの企業研究を面接に紐づけるかは **UI 上のユーザー選択**であり server からは導出できない。
//   そのため body の `companyResearch.logId` を **selection input** としてのみ使い、
//   中身（content）は server 側の owner-scoped read から取り直す。
//   logId は identity 権限を持たない: RLS により **その user 自身の行しか解決できない**。
//   （selector の `gdResultId` と同じ扱い。`D-S6` 参照）
//
// 厳守:
//   - never-throw / fail-open: 失敗・未 verify・解決不能はすべて request body へ倒す。
//   - context を減らさない: server 側が空で bridge に中身がある場合は bridge を使う。
//   - 本文 / PII / UUID を log しない。

import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import type { CareerCompanyResearchLog } from '@/types/careerCompanyResearch';
import type { InterviewCompanyResearchContext } from '@/lib/careerCompanyResearch/context';
import { buildInterviewRequestContext } from '@/lib/careerMemory/selector';
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

/** interview purpose が必要とする Source kind（base 3 + cross-feature 5）。 */
export const INTERVIEW_SOURCE_KINDS: readonly CareerSourceKind[] = [
  'profile',
  'activity',
  'values',
  'self_analysis',
  'es',
  'matching',
  'consultation',
  'company_research',
];

export type InterviewBodyContext = {
  profile?: CareerProfileInput | null;
  activity?: CareerActivityInput | null;
  values?: CareerValuesInput | null;
  selfAnalysis?: CareerSelfAnalysisResult | null;
  es?: CareerEsResult | null;
  matching?: CareerMatchEngineResult | null;
  consultationInsights?: string[] | null;
  companyResearch?: InterviewCompanyResearchContext | null;
};

export type InterviewContextInputs = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  selfAnalysis: CareerSelfAnalysisResult | null;
  es: CareerEsResult | null;
  matching: CareerMatchEngineResult | null;
  consultationInsights: string[] | null;
  companyResearch: InterviewCompanyResearchContext | null;
  /** 観測用（route 挙動には影響しない）。 */
  source: BaseContextDecisionReason;
  /** field 別の採用元（QA / 観測用・PII なし）。 */
  origins: Readonly<Record<InterviewContextField, 'server' | 'bridge'>>;
};

export type InterviewContextField =
  | 'base'
  | 'selfAnalysis'
  | 'es'
  | 'matching'
  | 'consultationInsights'
  | 'companyResearch';

const ALL_BRIDGE_ORIGINS: Readonly<Record<InterviewContextField, 'server' | 'bridge'>> = {
  base: 'bridge',
  selfAnalysis: 'bridge',
  es: 'bridge',
  matching: 'bridge',
  consultationInsights: 'bridge',
  companyResearch: 'bridge',
};

/** 中身のある値か（null / 空配列は「無い」）。 */
function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * base + cross-feature を 1 回の Layer 1 read で解決する（never-throw・fail-open）。
 */
export async function resolveInterviewContextInputs(
  b: InterviewBodyContext,
  req?: Request,
  loadContext = loadPurposeServerContext,
): Promise<InterviewContextInputs> {
  const bridge: InterviewContextInputs = {
    profile: b.profile ?? null,
    activity: b.activity ?? null,
    values: b.values ?? null,
    selfAnalysis: b.selfAnalysis ?? null,
    es: b.es ?? null,
    matching: b.matching ?? null,
    consultationInsights: b.consultationInsights ?? null,
    companyResearch: b.companyResearch ?? null,
    source: 'flag_off',
    origins: ALL_BRIDGE_ORIGINS,
  };
  try {
    const ctx = await loadContext('interview_practice', INTERVIEW_SOURCE_KINDS, req);

    recordCanaryObservation({
      purpose: 'interview_practice',
      sync: null,
      memory: null,
      context: normalizeContextOutcome(ctx.baseReason),
      memorySectionCount: 0,
      // Batch 2: source kind 別の採用元 / verdict / coverage（enum のみ）。
      sourceOrigins: pickSourceOrigins(ctx, INTERVIEW_SOURCE_KINDS),
      sourceVerdicts: pickSourceVerdicts(ctx, INTERVIEW_SOURCE_KINDS),
      coverage: toPurposeCoverage(ctx.status),
    });

    // 選択された企業研究ログを server 側 source から解決する（selection input は body の logId）。
    const selectedId = b.companyResearch?.logId ?? null;
    const serverResearchLog: CareerCompanyResearchLog | null = selectedId
      ? (ctx.sources.companyResearchLogs ?? []).find((l) => l?.id === selectedId) ?? null
      : null;

    // client と同一の pure selector を server 生データで実行する（history / cap / dedup 意味論が保存される）。
    const serverPayload = buildInterviewRequestContext({
      profile: ctx.sources.profile,
      activity: ctx.sources.activity,
      values: ctx.sources.values,
      selfAnalysisLogs: ctx.sources.selfAnalysisLogs ?? [],
      esLogs: ctx.sources.esLogs ?? [],
      matchingLogs: ctx.sources.matchingLogs ?? [],
      consultationThreads: ctx.sources.consultationThreads ?? [],
      companyResearchLog: serverResearchLog,
    });

    // field 単位で採用元を決める。「server が verified」かつ「context を減らさない」ときだけ server。
    const pick = <T,>(
      kind: CareerSourceKind,
      serverValue: T,
      bridgeValue: T,
    ): { value: T; origin: 'server' | 'bridge' } => {
      if (ctx.origin[kind] !== 'server') return { value: bridgeValue, origin: 'bridge' };
      // verified ⟹ 内容一致なので通常ここは同値。万一 server が空で bridge に中身があるなら bridge。
      if (!present(serverValue) && present(bridgeValue)) {
        return { value: bridgeValue, origin: 'bridge' };
      }
      return { value: serverValue, origin: 'server' };
    };

    const selfAnalysis = pick('self_analysis', serverPayload.selfAnalysis, bridge.selfAnalysis);
    const es = pick('es', serverPayload.es, bridge.es);
    const matching = pick('matching', serverPayload.matching, bridge.matching);
    // ★ null 化しない: selector は常に `string[]` を返す。`[]` を `null` へ潰すと
    //   bridge（`[]`）と server（`null`）で表現が変わり、parity が崩れる。
    const consultationInsights = pick<string[] | null>(
      'consultation',
      serverPayload.consultationInsights,
      bridge.consultationInsights,
    );
    const companyResearch = pick(
      'company_research',
      serverPayload.companyResearch,
      bridge.companyResearch,
    );

    return {
      profile: ctx.base ? ctx.base.profile : bridge.profile,
      activity: ctx.base ? ctx.base.activity : bridge.activity,
      values: ctx.base ? ctx.base.values : bridge.values,
      selfAnalysis: selfAnalysis.value,
      es: es.value,
      matching: matching.value,
      consultationInsights: consultationInsights.value,
      companyResearch: companyResearch.value,
      source: ctx.baseReason,
      origins: {
        base: ctx.base ? 'server' : 'bridge',
        selfAnalysis: selfAnalysis.origin,
        es: es.origin,
        matching: matching.origin,
        consultationInsights: consultationInsights.origin,
        companyResearch: companyResearch.origin,
      },
    };
  } catch {
    return { ...bridge, source: 'source_unavailable' };
  }
}

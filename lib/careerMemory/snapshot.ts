// PASSAI CAREER — additive Career Memory snapshot + projection（P5-B: 地ならし / production 未接続）。
//
// 目的（P5-A の設計監査を受けた byte 不変の準備工程）:
//   「raw を 1 度 assemble（snapshot）→ purpose 別に project（既存 selector body へ復元）」の
//   2 段パイプラインを **additive** に用意する。既存 selector / route / prompt は一切変更しない。
//   将来 selector 内部を snapshot 経由へ置換する際の byte-safe な足場（harness で一致検証済み）。
//
// 設計判断（重要 / P5-A の結論を実装に反映）:
//   - 本 snapshot は **byte-faithful な interim carrier** である。各 purpose が必要とする block を、
//     既存 selector と **同一の build* 呼び出し**で計算して保持する。projection はそれを既存 body の
//     key 順どおりに並べ替えるだけ。→ 出力は既存 selector と byte 一致する（harness で確認）。
//   - lib/careerMemory/types.ts の設計型（CareerMemorySnapshot / BaseMemorySummary /
//     *MemorySummary）は **要約・PII 除外の別形状**であり、既存 body を byte 復元できない
//     （interview/presentation/matching は latest の **full result** を、consultation は
//     *HistorySnapshot を運ぶため、要約型では欠損する）。よって本 interim では設計型に **寄せた
//     block 構造**を採り、strict な *MemorySummary 変換は byte-breaking な後続フェーズへ繰り延べる。
//   - selected id / 選択 companyResearchLog は **snapshot 外 input**（builder への引数）として扱い、
//     snapshot 内には計算結果のみを保持する（projection は外部 id を必要としない）。
//
// 厳守（P5-B）:
//   - 純関数。I/O / localStorage / Supabase / env / secret に触れない。
//   - 既存 selector / page / contextSource / route の body・挙動を変更しない（本ファイルは未接続）。
//   - base（profile/activity/values）は raw のまま carry（既存 base prompt へ BaseMemorySummary を接続しない）。

import type { CareerProfile } from '@/types/careerProfile';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerEsLog } from '@/types/careerEs';
import type { CareerInterviewResult } from '@/types/careerInterview';
import type { CareerPresentationResult } from '@/types/careerPresentation';
import type { CareerCompanyResearchLog } from '@/types/careerCompanyResearch';
import type { CareerGdResult, CareerGdRoomLog } from '@/types/careerGd';
import type { CareerMatchingLog } from '@/types/careerMatching';
import type { CareerConsultationThread } from '@/types/careerConsultation';
import {
  buildSelfAnalysisHistory,
  buildEsHistory,
  buildInterviewHistory,
  buildPresentationHistory,
} from '@/lib/careerConsultation/historySnapshots';
import {
  buildCompanyResearchContext,
  buildInterviewCompanyResearchContext,
} from '@/lib/careerCompanyResearch/context';
import {
  buildLatestGdConsultationSnapshots,
  buildGdConsultationSnapshotById,
  buildLatestGdRoomSignals,
  buildLatestGdMatchingSnapshot,
  buildGdMatchingSnapshotById,
} from '@/lib/careerGd/context';
import { buildLatestMatchingConsultationSnapshots } from '@/lib/careerMatching/consultationContext';
import type {
  CareerInterviewContextPayload,
  CareerPresentationContextPayload,
} from './selector';

// ── raw input（4 selector 入力の superset。selector 自身は読まない生データ） ──────────────
export type CareerMemorySnapshotInput = {
  profile: CareerProfile | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysisLogs: CareerSelfAnalysisLog[];
  esLogs: CareerEsLog[];
  interviewResults: CareerInterviewResult[];
  presentationResults: CareerPresentationResult[];
  companyResearchLogs: CareerCompanyResearchLog[];
  gdResults: CareerGdResult[];
  gdRoomLogs: CareerGdRoomLog[];
  matchingLogs: CareerMatchingLog[];
  consultationThreads: CareerConsultationThread[];
};

// ── snapshot 外 input（selected id / 選択ログ）。builder への引数として渡し snapshot に保持しない ──
export type CareerMemorySnapshotExternals = {
  // GD 結果の深リンク（?gdResultId）。consultation / matching が使用。
  gdResultId?: string | null;
  // 選択された企業研究ログ（interview のみ。id→log 解決は呼び出し側の責務）。
  companyResearchLog?: CareerCompanyResearchLog | null;
};

// ── 既存 selector の private helper を byte 一致で複製（selector.ts と 1:1） ───────────────

// consultation: gdResultId 指定時はその1件、無ければ最新2件（selector.gdConsultationContext と同一）。
function gdConsultationContext(results: CareerGdResult[], gdResultId?: string | null) {
  if (gdResultId) {
    const byId = buildGdConsultationSnapshotById(results, gdResultId);
    if (byId) return [byId];
  }
  return buildLatestGdConsultationSnapshots(results, 2);
}

// interview/presentation: 相談スレッドから keyInsights を最大 maxItems 件・新しい順・dedup
// （selector.collectConsultationInsights と 1:1）。
function collectConsultationInsights(
  threads: CareerConsultationThread[],
  maxItems = 5,
): string[] {
  const sorted = [...threads].sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  );
  const insights: string[] = [];
  for (const thread of sorted) {
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const msg = thread.messages[i];
      const items = msg.role === 'assistant' ? msg.result?.keyInsights : undefined;
      if (Array.isArray(items)) {
        for (const it of items) {
          const t = typeof it === 'string' ? it.trim() : '';
          if (t && !insights.includes(t)) insights.push(t);
          if (insights.length >= maxItems) return insights;
        }
      }
    }
  }
  return insights;
}

// interview: 選択された企業研究ログ→面接用 context（build 失敗時 null）。selector と 1:1。
function resolveInterviewCompanyResearch(
  log: CareerCompanyResearchLog | null,
): CareerInterviewContextPayload['companyResearch'] {
  if (!log) return null;
  try {
    return buildInterviewCompanyResearchContext(log);
  } catch {
    return null;
  }
}

// matching: 最新スレッド末尾の assistant 結果（selector.latestConsultationResult と 1:1）。
function latestConsultationResult(
  threads: CareerConsultationThread[],
): CareerMatchingRequestContext['consultation'] {
  if (threads.length === 0) return null;
  const messages = threads[0].messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.result) return m.result;
  }
  return null;
}

// consultation / matching selector は匿名 object を返すため、body 型を本ファイルで宣言する
// （selector.buildConsultationRequestContext / buildMatchingRequestContext の返り値と構造一致）。
export type CareerConsultationRequestContext = {
  profile: CareerProfile | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysisHistory: ReturnType<typeof buildSelfAnalysisHistory>;
  esHistory: ReturnType<typeof buildEsHistory>;
  interviewHistory: ReturnType<typeof buildInterviewHistory>;
  presentationHistory: ReturnType<typeof buildPresentationHistory>;
  companyResearch: ReturnType<typeof buildCompanyResearchContext>;
  gd: ReturnType<typeof gdConsultationContext>;
  gdRoom: ReturnType<typeof buildLatestGdRoomSignals>;
  matching: ReturnType<typeof buildLatestMatchingConsultationSnapshots>;
};

export type CareerMatchingRequestContext = {
  profile: CareerProfile | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysis: CareerSelfAnalysisLog['result'] | null;
  es: CareerEsLog['result'] | null;
  interviewResult: CareerInterviewResult['result'] | null;
  consultation: NonNullable<CareerConsultationThread['messages'][number]['result']> | null;
  gdSnapshot: ReturnType<typeof buildLatestGdMatchingSnapshot>;
  gdRoomSignals: ReturnType<typeof buildLatestGdRoomSignals>;
};

// ── purpose 別 faithful snapshot（byte-faithful interim。block は既存 build* の結果を保持） ─────
// 設計型 CareerMemorySnapshot（要約・PII 除外）に **寄せた** block 構造。strict 変換は後続フェーズ。

type SnapshotBase = {
  profile: CareerProfile | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
};

export type ConsultationMemorySnapshot = {
  purpose: 'consultation';
  base: SnapshotBase;
  selfAnalysisHistory: CareerConsultationRequestContext['selfAnalysisHistory'];
  esHistory: CareerConsultationRequestContext['esHistory'];
  interviewHistory: CareerConsultationRequestContext['interviewHistory'];
  presentationHistory: CareerConsultationRequestContext['presentationHistory'];
  companyResearch: CareerConsultationRequestContext['companyResearch'];
  gd: CareerConsultationRequestContext['gd'];
  gdRoom: CareerConsultationRequestContext['gdRoom'];
  matching: CareerConsultationRequestContext['matching'];
};

export type InterviewMemorySnapshot = {
  purpose: 'interview';
  base: SnapshotBase;
  selfAnalysis: CareerInterviewContextPayload['selfAnalysis'];
  es: CareerInterviewContextPayload['es'];
  matching: CareerInterviewContextPayload['matching'];
  consultationInsights: string[];
  companyResearch: CareerInterviewContextPayload['companyResearch'];
};

export type PresentationMemorySnapshot = {
  purpose: 'presentation';
  base: SnapshotBase;
  selfAnalysis: CareerPresentationContextPayload['selfAnalysis'];
  es: CareerPresentationContextPayload['es'];
  interview: CareerPresentationContextPayload['interview'];
  matching: CareerPresentationContextPayload['matching'];
  consultationInsights: string[];
};

export type MatchingMemorySnapshot = {
  purpose: 'matching';
  base: SnapshotBase;
  selfAnalysis: CareerMatchingRequestContext['selfAnalysis'];
  es: CareerMatchingRequestContext['es'];
  interviewResult: CareerMatchingRequestContext['interviewResult'];
  consultation: CareerMatchingRequestContext['consultation'];
  gdSnapshot: CareerMatchingRequestContext['gdSnapshot'];
  gdRoomSignals: CareerMatchingRequestContext['gdRoomSignals'];
};

export type CareerMemorySnapshot =
  | ConsultationMemorySnapshot
  | InterviewMemorySnapshot
  | PresentationMemorySnapshot
  | MatchingMemorySnapshot;

export type CareerMemorySnapshotPurpose = CareerMemorySnapshot['purpose'];

// ── builders（raw input + 外部 id → faithful snapshot。block 計算は selector と同一 build* 呼び出し） ──

export function buildConsultationSnapshot(
  input: CareerMemorySnapshotInput,
  externals: CareerMemorySnapshotExternals = {},
): ConsultationMemorySnapshot {
  return {
    purpose: 'consultation',
    base: { profile: input.profile, activity: input.activity, values: input.values },
    selfAnalysisHistory: buildSelfAnalysisHistory(input.selfAnalysisLogs, 3),
    esHistory: buildEsHistory(input.esLogs, 3),
    interviewHistory: buildInterviewHistory(input.interviewResults, 3),
    presentationHistory: buildPresentationHistory(input.presentationResults, 3),
    companyResearch: buildCompanyResearchContext(input.companyResearchLogs, { limit: 5 }),
    gd: gdConsultationContext(input.gdResults, externals.gdResultId),
    gdRoom: buildLatestGdRoomSignals(input.gdRoomLogs, 3),
    matching: buildLatestMatchingConsultationSnapshots(input.matchingLogs, 2),
  };
}

export function buildInterviewSnapshot(
  input: CareerMemorySnapshotInput,
  externals: CareerMemorySnapshotExternals = {},
): InterviewMemorySnapshot {
  const { selfAnalysisLogs, esLogs, matchingLogs } = input;
  return {
    purpose: 'interview',
    base: { profile: input.profile, activity: input.activity, values: input.values },
    selfAnalysis: selfAnalysisLogs.length > 0 ? selfAnalysisLogs[0].result : null,
    es: esLogs.length > 0 ? esLogs[0].result : null,
    matching: matchingLogs.length > 0 ? matchingLogs[0].result : null,
    consultationInsights: collectConsultationInsights(input.consultationThreads),
    companyResearch: resolveInterviewCompanyResearch(externals.companyResearchLog ?? null),
  };
}

export function buildPresentationSnapshot(
  input: CareerMemorySnapshotInput,
): PresentationMemorySnapshot {
  const { selfAnalysisLogs, esLogs, interviewResults, matchingLogs } = input;
  return {
    purpose: 'presentation',
    base: { profile: input.profile, activity: input.activity, values: input.values },
    selfAnalysis: selfAnalysisLogs.length > 0 ? selfAnalysisLogs[0].result : null,
    es: esLogs.length > 0 ? esLogs[0].result : null,
    interview: interviewResults.length > 0 ? interviewResults[0].result : null,
    matching: matchingLogs.length > 0 ? matchingLogs[0].result : null,
    consultationInsights: collectConsultationInsights(input.consultationThreads),
  };
}

export function buildMatchingSnapshot(
  input: CareerMemorySnapshotInput,
  externals: CareerMemorySnapshotExternals = {},
): MatchingMemorySnapshot {
  const { selfAnalysisLogs, esLogs, interviewResults, gdResults } = input;
  const gdSnapshot =
    (externals.gdResultId ? buildGdMatchingSnapshotById(gdResults, externals.gdResultId) : null) ??
    buildLatestGdMatchingSnapshot(gdResults);
  return {
    purpose: 'matching',
    base: { profile: input.profile, activity: input.activity, values: input.values },
    selfAnalysis: selfAnalysisLogs.length > 0 ? selfAnalysisLogs[0].result : null,
    es: esLogs.length > 0 ? esLogs[0].result : null,
    interviewResult: interviewResults.length > 0 ? interviewResults[0].result : null,
    consultation: latestConsultationResult(input.consultationThreads),
    gdSnapshot,
    gdRoomSignals: buildLatestGdRoomSignals(input.gdRoomLogs, 3),
  };
}

// umbrella dispatcher（「1 つの入口」要件用）。purpose を渡すと purpose 別 snapshot を返す。
export function buildCareerMemorySnapshot(
  purpose: CareerMemorySnapshotPurpose,
  input: CareerMemorySnapshotInput,
  externals: CareerMemorySnapshotExternals = {},
): CareerMemorySnapshot {
  switch (purpose) {
    case 'consultation':
      return buildConsultationSnapshot(input, externals);
    case 'interview':
      return buildInterviewSnapshot(input, externals);
    case 'presentation':
      return buildPresentationSnapshot(input);
    case 'matching':
      return buildMatchingSnapshot(input, externals);
  }
}

// ── projections（snapshot → 既存 selector body。key 順・undefined/null・latest・fallback を一致） ──

export function projectConsultationRequestContext(
  s: ConsultationMemorySnapshot,
): CareerConsultationRequestContext {
  return {
    profile: s.base.profile,
    activity: s.base.activity,
    values: s.base.values,
    selfAnalysisHistory: s.selfAnalysisHistory,
    esHistory: s.esHistory,
    interviewHistory: s.interviewHistory,
    presentationHistory: s.presentationHistory,
    companyResearch: s.companyResearch,
    gd: s.gd,
    gdRoom: s.gdRoom,
    matching: s.matching,
  };
}

export function projectInterviewRequestContext(
  s: InterviewMemorySnapshot,
): CareerInterviewContextPayload {
  return {
    profile: s.base.profile,
    activity: s.base.activity,
    values: s.base.values,
    selfAnalysis: s.selfAnalysis,
    es: s.es,
    matching: s.matching,
    consultationInsights: s.consultationInsights,
    companyResearch: s.companyResearch,
  };
}

export function projectPresentationRequestContext(
  s: PresentationMemorySnapshot,
): CareerPresentationContextPayload {
  return {
    profile: s.base.profile,
    activity: s.base.activity,
    values: s.base.values,
    selfAnalysis: s.selfAnalysis,
    es: s.es,
    interview: s.interview,
    matching: s.matching,
    consultationInsights: s.consultationInsights,
  };
}

export function projectMatchingRequestContext(
  s: MatchingMemorySnapshot,
): CareerMatchingRequestContext {
  return {
    profile: s.base.profile,
    activity: s.base.activity,
    values: s.base.values,
    selfAnalysis: s.selfAnalysis,
    es: s.es,
    interviewResult: s.interviewResult,
    consultation: s.consultation,
    gdSnapshot: s.gdSnapshot,
    gdRoomSignals: s.gdRoomSignals,
  };
}

// umbrella dispatcher（snapshot → 対応する selector body）。
export function projectRequestContext(
  s: CareerMemorySnapshot,
): CareerConsultationRequestContext | CareerInterviewContextPayload | CareerPresentationContextPayload | CareerMatchingRequestContext {
  switch (s.purpose) {
    case 'consultation':
      return projectConsultationRequestContext(s);
    case 'interview':
      return projectInterviewRequestContext(s);
    case 'presentation':
      return projectPresentationRequestContext(s);
    case 'matching':
      return projectMatchingRequestContext(s);
  }
}

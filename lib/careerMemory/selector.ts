// PASSAI CAREER — Central Memory selector（P4-C: consultation 先行抽出）。
//
// 役割: consultation page が localStorage から load* した生データを受け取り、相談AI
//   (/api/career/consultation) へ渡す横断 context（request body の message/history を除く部分）を
//   組み立てる **純関数**。app/career/consultation/page.tsx の page-local proto-selector
//   (buildConsultationContext) を「出力 byte 不変」で抽出したもの。将来の route 別 selector の土台。
//
// 厳守（P4-C）:
//   - 純関数。localStorage / Supabase / fetch / window / document に触れない（読み出しは page の責務）。
//   - 既存 build*/normalize* を呼ぶだけ。新しい要約ロジック・件数上限・truncate 挙動は追加しない。
//   - 返す object の key 順・件数上限・fallback は旧 buildConsultationContext と完全一致。
//   - request body / prompt / AI schema / server route は変えない（本層は body の一部を作るだけ）。

import type { CareerProfile } from '@/types/careerProfile';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type { CareerSelfAnalysisLog, CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsLog, CareerEsResult } from '@/types/careerEs';
import type { CareerInterviewResult } from '@/types/careerInterview';
import type { CareerPresentationResult } from '@/types/careerPresentation';
import type { CareerCompanyResearchLog } from '@/types/careerCompanyResearch';
import type { CareerGdResult, CareerGdRoomLog } from '@/types/careerGd';
import type { CareerMatchingLog } from '@/types/careerMatching';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
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
  type InterviewCompanyResearchContext,
} from '@/lib/careerCompanyResearch/context';
import {
  buildLatestGdConsultationSnapshots,
  buildGdConsultationSnapshotById,
  buildLatestGdRoomSignals,
} from '@/lib/careerGd/context';
import { buildLatestMatchingConsultationSnapshots } from '@/lib/careerMatching/consultationContext';

// page が load* で読み出して渡す生データ（selector 自身は読まない）。
// 各フィールドの型は対応する load* 関数の戻り値と一致する（page 側が cast 無しで渡せる）。
export type ConsultationSelectorInput = {
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
  // GD結果の深リンク（?gdResultId）。指定時はその1件を優先。
  gdResultId?: string | null;
};

// gdResultId 指定時はその GD 結果を優先、無ければ最新2件（旧 page-local gdConsultationContext と同一）。
function gdConsultationContext(results: CareerGdResult[], gdResultId?: string | null) {
  if (gdResultId) {
    const byId = buildGdConsultationSnapshotById(results, gdResultId);
    if (byId) return [byId];
  }
  return buildLatestGdConsultationSnapshots(results, 2);
}

// 相談AIへ渡す横断 context（request body の message/history を除く部分）を組み立てる。
// 返す object の key 順・件数上限は旧 buildConsultationContext と byte 一致。
export function buildConsultationRequestContext(input: ConsultationSelectorInput) {
  return {
    profile: input.profile,
    // activity は全量ではなく相談用ダイジェスト（route 側で圧縮）。生データを渡し、route が truncate する。
    activity: input.activity,
    values: input.values,
    // STEP-CONSULT-06: 最新1件ではなく「軽量な複数件＋推移」を渡す（最新3件まで・圧縮済み）。
    selfAnalysisHistory: buildSelfAnalysisHistory(input.selfAnalysisLogs, 3),
    esHistory: buildEsHistory(input.esLogs, 3),
    interviewHistory: buildInterviewHistory(input.interviewResults, 3),
    presentationHistory: buildPresentationHistory(input.presentationResults, 3),
    // 保存済み企業研究（最新更新順・最大5件の軽量スナップショット）。
    companyResearch: buildCompanyResearchContext(input.companyResearchLogs, { limit: 5 }),
    // GD練習結果。gdResultId があればその1件を優先、無い/見つからない場合は最新2件。
    gd: gdConsultationContext(input.gdResults, input.gdResultId),
    // STEP-GD-17: マルチGD の 6 軸評価を参考シグナルとして追加（最新3件・採点済みのみ）。
    gdRoom: buildLatestGdRoomSignals(input.gdRoomLogs, 3),
    // STEP-CONSULT-03: 企業マッチング結果（最新2件・軽量スナップショット）。
    matching: buildLatestMatchingConsultationSnapshots(input.matchingLogs, 2),
  };
}

// ── interview（P4-D: app/career/interview/contextSource.ts の proto-selector を抽出） ──────

// 面接AI API に渡す入力コンテキスト（旧 contextSource.ts の同名型を移設。importer 互換のため
// contextSource が本型を re-export する）。key 順は旧実装と一致。
export type CareerInterviewContextPayload = {
  profile: CareerProfile | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysis: CareerSelfAnalysisResult | null;
  es: CareerEsResult | null;
  // 任意の参考データ（存在しないユーザーでは null / 空配列。プロンプトに出さないだけで落ちない）。
  matching: CareerMatchEngineResult | null;
  consultationInsights: string[];
  // 選択された企業研究ログの面接用コンテキスト（未選択なら null）。
  companyResearch: InterviewCompanyResearchContext | null;
};

// contextSource(client) が load* / guarded read して渡す生データ（selector 自身は読まない）。
export type InterviewSelectorInput = {
  profile: CareerProfile | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysisLogs: CareerSelfAnalysisLog[];
  esLogs: CareerEsLog[];
  matchingLogs: CareerMatchingLog[];
  // 相談スレッド（guarded read 済み。読めなければ空配列で渡す）。
  consultationThreads: CareerConsultationThread[];
  // 選択された企業研究ログ（id 解決済み。未選択/不存在/読取失敗なら null で渡す）。
  companyResearchLog: CareerCompanyResearchLog | null;
};

// 相談スレッドから最近の気づき（keyInsights）を最大 maxItems 件・新しい順に集める純関数。
// （旧 contextSource.collectConsultationInsights の load を除いたロジックと 1:1）。
function collectConsultationInsights(
  threads: CareerConsultationThread[],
  maxItems = 5,
): string[] {
  const sorted = [...threads].sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  );
  const insights: string[] = [];
  for (const thread of sorted) {
    // 新しいメッセージから走査し、assistant の result.keyInsights を拾う。
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

// 選択された企業研究ログを面接用コンテキストへ変換（build 失敗時は null）。
// （旧 contextSource.resolveCompanyResearch の build 部分と 1:1。id→log 解決は contextSource が担う）。
function resolveInterviewCompanyResearch(
  log: CareerCompanyResearchLog | null,
): InterviewCompanyResearchContext | null {
  if (!log) return null;
  try {
    return buildInterviewCompanyResearchContext(log);
  } catch {
    return null;
  }
}

// 面接AI API に渡す入力コンテキストを、contextSource が読み込んだ生データから組み立てる純関数。
// 返す object の key 順・latest 選択（最新1件）・fallback は旧 buildInterviewContextPayload と byte 一致。
export function buildInterviewRequestContext(
  input: InterviewSelectorInput,
): CareerInterviewContextPayload {
  const { selfAnalysisLogs, esLogs, matchingLogs } = input;
  const matching = matchingLogs.length > 0 ? matchingLogs[0].result : null;
  return {
    profile: input.profile,
    activity: input.activity,
    values: input.values,
    selfAnalysis: selfAnalysisLogs.length > 0 ? selfAnalysisLogs[0].result : null,
    es: esLogs.length > 0 ? esLogs[0].result : null,
    matching,
    consultationInsights: collectConsultationInsights(input.consultationThreads),
    companyResearch: resolveInterviewCompanyResearch(input.companyResearchLog),
  };
}

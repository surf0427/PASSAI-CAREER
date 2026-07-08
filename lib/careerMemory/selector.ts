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
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerEsLog } from '@/types/careerEs';
import type { CareerInterviewResult } from '@/types/careerInterview';
import type { CareerPresentationResult } from '@/types/careerPresentation';
import type { CareerCompanyResearchLog } from '@/types/careerCompanyResearch';
import type { CareerGdResult, CareerGdRoomLog } from '@/types/careerGd';
import type { CareerMatchingLog } from '@/types/careerMatching';
import {
  buildSelfAnalysisHistory,
  buildEsHistory,
  buildInterviewHistory,
  buildPresentationHistory,
} from '@/lib/careerConsultation/historySnapshots';
import { buildCompanyResearchContext } from '@/lib/careerCompanyResearch/context';
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

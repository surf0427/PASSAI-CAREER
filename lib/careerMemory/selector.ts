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
import type { CareerInterviewResult, CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerPresentationResult } from '@/types/careerPresentation';
import type { CareerCompanyResearchLog } from '@/types/careerCompanyResearch';
import type { CareerGdResult, CareerGdRoomLog } from '@/types/careerGd';
import type { CareerMatchingLog } from '@/types/careerMatching';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import type { CareerConsultationThread } from '@/types/careerConsultation';
import type { InterviewCompanyResearchContext } from '@/lib/careerCompanyResearch/context';
// P7-F: presentation のみ ES を presentation-local strict summary で carry する（interview は full のまま）。
import type { PresentationEsSummary } from './presentationEs';
// P5-C〜F: 4 selector すべてを snapshot→projection 経路へ接続（返り値 byte 不変・常設 harness で担保）。
//   selector は snapshot builder + projection への薄い委譲層になり、build*/normalize* の直接呼び出しは
//   lib/careerMemory/snapshot.ts 側へ集約した（本ファイルからの直接 import は不要になった）。
import {
  buildConsultationSnapshot,
  projectConsultationRequestContext,
  buildMatchingSnapshot,
  projectMatchingRequestContext,
  buildPresentationSnapshot,
  projectPresentationRequestContext,
  buildInterviewSnapshot,
  projectInterviewRequestContext,
} from './snapshot';

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

// 相談AIへ渡す横断 context（request body の message/history を除く部分）を組み立てる純関数。
// P5-F: 内部を additive snapshot→projection 経路へ接続した（P5-B で追加した
//   buildConsultationSnapshot / projectConsultationRequestContext を経由）。返す object の
//   key 順・各 history 件数上限（3）・companyResearch(5)・GD id fallback・gdRoom(3)・matching(2)は
//   旧実装と byte 一致（常設 harness scripts/career-memory-consultation-byte-qa.ts で担保）。外部
//   インターフェース（ConsultationSelectorInput / 返り値形状）は不変で、page 側 body・route は変わらない。
//   - gdResultId は snapshot externals として渡す（selected id は snapshot 外 input）。
//   - userInput は従来どおり selector 返り値の外で page が body へ付与する（本層は非関与）。
//   - base(profile/activity/values) は raw のまま carry（BaseMemorySummary は使わない）。
//   - consultation snapshot が使わない consultationThreads は空配列で渡す（snapshot は未参照）。
export function buildConsultationRequestContext(input: ConsultationSelectorInput) {
  const snapshot = buildConsultationSnapshot(
    {
      profile: input.profile,
      activity: input.activity,
      values: input.values,
      selfAnalysisLogs: input.selfAnalysisLogs,
      esLogs: input.esLogs,
      interviewResults: input.interviewResults,
      presentationResults: input.presentationResults,
      companyResearchLogs: input.companyResearchLogs,
      gdResults: input.gdResults,
      gdRoomLogs: input.gdRoomLogs,
      matchingLogs: input.matchingLogs,
      consultationThreads: [],
    },
    { gdResultId: input.gdResultId },
  );
  return projectConsultationRequestContext(snapshot);
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

// 面接AI API に渡す入力コンテキストを、contextSource が読み込んだ生データから組み立てる純関数。
// P5-E: 内部を additive snapshot→projection 経路へ接続した（P5-B で追加した
//   buildInterviewSnapshot / projectInterviewRequestContext を経由）。返す object の
//   key 順・latest 選択（最新1件）・consultationInsights の dedup・companyResearch の
//   成功/throw→null/未選択→null fallback は旧実装と byte 一致（常設 harness
//   scripts/career-memory-interview-byte-qa.ts で担保）。外部インターフェース
//   （InterviewSelectorInput / 返り値形状）は不変で、contextSource 側 payload・start/turn/complete
//   の3 route は変わらない。
//   - selected companyResearchLog は snapshot externals として渡す（selected は snapshot 外 input）。
//   - base(profile/activity/values) は raw のまま carry（BaseMemorySummary は使わない）。
//   - interview 固有の type/target/turn/answer は selector 返り値の外のまま（本層は非関与）。
//   - interview が使わない presentation/companyResearch/gd/matching-history 系は空配列で渡す（snapshot は未参照）。
export function buildInterviewRequestContext(
  input: InterviewSelectorInput,
): CareerInterviewContextPayload {
  const snapshot = buildInterviewSnapshot(
    {
      profile: input.profile,
      activity: input.activity,
      values: input.values,
      selfAnalysisLogs: input.selfAnalysisLogs,
      esLogs: input.esLogs,
      interviewResults: [],
      presentationResults: [],
      companyResearchLogs: [],
      gdResults: [],
      gdRoomLogs: [],
      matchingLogs: input.matchingLogs,
      consultationThreads: input.consultationThreads,
    },
    { companyResearchLog: input.companyResearchLog },
  );
  return projectInterviewRequestContext(snapshot);
}

// ── presentation（P4-E1: app/career/presentation/contextSource.ts の proto-selector を抽出） ──

// プレゼン対策AI API に渡す入力コンテキスト（旧 contextSource.ts の同名型を移設。importer 互換のため
// contextSource が本型を re-export する）。key 順は旧実装と一致。
export type CareerPresentationContextPayload = {
  profile: CareerProfile | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysis: CareerSelfAnalysisResult | null;
  // P7-F: presentation は ES を presentation-local strict summary（headline/gakuchika/selfPr/
  //   motivation・cap 済み）で carry する。full CareerEsResult は使わない（未使用 field は body から除外）。
  es: PresentationEsSummary | null;
  // 任意の参考データ（存在しないユーザーでは null / 空配列。プロンプトに出さないだけで落ちない）。
  interview: CareerInterviewFinalResult | null;
  matching: CareerMatchEngineResult | null;
  consultationInsights: string[];
};

// contextSource(client) が load* / guarded read して渡す生データ（selector 自身は読まない）。
export type PresentationSelectorInput = {
  profile: CareerProfile | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysisLogs: CareerSelfAnalysisLog[];
  esLogs: CareerEsLog[];
  interviewResults: CareerInterviewResult[];
  matchingLogs: CareerMatchingLog[];
  // 相談スレッド（guarded read 済み。読めなければ空配列で渡す）。
  consultationThreads: CareerConsultationThread[];
};

// プレゼンAI API に渡す入力コンテキストを、contextSource が読み込んだ生データから組み立てる純関数。
// P5-D: 内部を additive snapshot→projection 経路へ接続した（P5-B で追加した
//   buildPresentationSnapshot / projectPresentationRequestContext を経由）。返す object の
//   key 順・latest 選択（最新1件）・fallback・consultationInsights の dedup は旧実装と byte 一致
//   （常設 harness scripts/career-memory-presentation-byte-qa.ts で担保）。外部インターフェース
//   （PresentationSelectorInput / 返り値形状）は不変で、contextSource 側 payload・route は変わらない。
//   - presentation は externals 不要（gdResultId も選択ログも無い）。
//   - base(profile/activity/values) は raw のまま carry（BaseMemorySummary は使わない）。
//   - presentation 固有の config/mode/transcript/answer/question は selector 返り値の外のまま（本層は非関与）。
//   - presentation が使わない companyResearch/gd/matching-history 系は空配列で渡す（snapshot は未参照）。
export function buildPresentationRequestContext(
  input: PresentationSelectorInput,
): CareerPresentationContextPayload {
  const snapshot = buildPresentationSnapshot({
    profile: input.profile,
    activity: input.activity,
    values: input.values,
    selfAnalysisLogs: input.selfAnalysisLogs,
    esLogs: input.esLogs,
    interviewResults: input.interviewResults,
    presentationResults: [],
    companyResearchLogs: [],
    gdResults: [],
    gdRoomLogs: [],
    matchingLogs: input.matchingLogs,
    consultationThreads: input.consultationThreads,
  });
  return projectPresentationRequestContext(snapshot);
}

// ── matching（P4-E2: app/career/matching/page.tsx の page-local proto-selector を抽出） ──────

// matching page(client) が load* して渡す生データ（selector 自身は読まない）。
export type MatchingSelectorInput = {
  profile: CareerProfile | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysisLogs: CareerSelfAnalysisLog[];
  esLogs: CareerEsLog[];
  interviewResults: CareerInterviewResult[];
  // 相談スレッド（旧実装は guarded read せず直接読むため、page 側もガードしない）。
  consultationThreads: CareerConsultationThread[];
  gdResults: CareerGdResult[];
  gdRoomLogs: CareerGdRoomLog[];
  // GD結果の深リンク（?gdResultId）。指定時はその1件を優先。
  gdResultId?: string | null;
};

// マッチングAIに渡す統合コンテキストを、page が読み込んだ生データから組み立てる純関数。
// P5-C: 内部を additive snapshot→projection 経路へ pilot 接続した（P5-B で追加した
//   buildMatchingSnapshot / projectMatchingRequestContext を経由）。返す object の
//   key 順・latest 選択・GD id fallback・件数上限は旧実装と byte 一致（常設 harness
//   scripts/career-memory-matching-byte-qa.ts で担保）。外部インターフェース
//   （MatchingSelectorInput / 返り値形状）は不変で、page 側 body・route は変わらない。
//   - gdResultId は snapshot externals として渡す（selected id は snapshot 外 input）。
//   - base(profile/activity/values) は raw のまま carry（BaseMemorySummary は使わない）。
//   - matching が使わない presentation/companyResearch/matching logs は空配列で渡す（snapshot は未参照）。
export function buildMatchingRequestContext(input: MatchingSelectorInput) {
  const snapshot = buildMatchingSnapshot(
    {
      profile: input.profile,
      activity: input.activity,
      values: input.values,
      selfAnalysisLogs: input.selfAnalysisLogs,
      esLogs: input.esLogs,
      interviewResults: input.interviewResults,
      presentationResults: [],
      companyResearchLogs: [],
      gdResults: input.gdResults,
      gdRoomLogs: input.gdRoomLogs,
      matchingLogs: [],
      consultationThreads: input.consultationThreads,
    },
    { gdResultId: input.gdResultId },
  );
  return projectMatchingRequestContext(snapshot);
}

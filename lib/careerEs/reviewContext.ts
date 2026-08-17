// PASSAI 就活版 — ES 添削（/api/career/es-review）の User Data Spine payload 選択（純関数）。
//
// 役割:
//   ES 添削が必要とする User Data Spine の断面（profile / activity / values / 最新の自己分析）を、
//   生の Layer 1 データ（localStorage canonical、または server が読んだ mirror）から
//   **同一規則で**取り出す単一の selector。
//
// ★ なぜ client / server の両方から本 module を使うか（parity の根拠）:
//   他 purpose（interview / presentation / company_research）と同じ契約に揃えるため。
//   client は localStorage を、server は owner-scoped RLS で読んだ mirror を渡すが、
//   **選択規則（最新 1 件・null fallback）が同じ関数**なので、Source-Sync verified なら
//   両者の出力は意味的に同一になる。＝ server 化は出力を変えず「どこから来たか」だけを変える。
//
// ★ 「最新 log の result」規則は company_research_review の server resolver
//   （app/api/career/company-research/resolveContextInputs.ts の latestSelfAnalysisResult）と同一。
//   log 配列は新しい順に並んでいる前提（既存 storage 契約）。
//
// 厳守: I/O ゼロ（localStorage / fetch / Supabase に触れない）。never-throw。

import type {
  CareerProfileInput,
  CareerActivityInput,
  CareerValuesInput,
} from '@/lib/careerAi';
import type {
  CareerSelfAnalysisLog,
  CareerSelfAnalysisResult,
} from '@/types/careerSelfAnalysis';

/** ES 添削 API の body に載る User Data Spine 断面（route の受け口と 1:1）。 */
export type CareerEsReviewContextPayload = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  selfAnalysis: CareerSelfAnalysisResult | null;
};

/** selector が受け取る生データ（読み出しは呼び出し側の責務）。 */
export type EsReviewSelectorInput = {
  profile: CareerProfileInput | null;
  activity: CareerActivityInput | null;
  values: CareerValuesInput | null;
  selfAnalysisLogs: readonly CareerSelfAnalysisLog[] | null | undefined;
};

/** 空 payload（読めなかった・未入力のときの安全な既定）。 */
export const EMPTY_ES_REVIEW_CONTEXT: CareerEsReviewContextPayload = {
  profile: null,
  activity: null,
  values: null,
  selfAnalysis: null,
};

/**
 * 「最新 log の result」（company_research_review の server resolver と同一規則）。
 * log 配列は新しい順。空・不正なら null。
 */
export function latestEsSelfAnalysisResult(
  logs: readonly CareerSelfAnalysisLog[] | null | undefined,
): CareerSelfAnalysisResult | null {
  if (!Array.isArray(logs) || logs.length === 0) return null;
  return logs[0]?.result ?? null;
}

/** 生データ → ES 添削用 payload（純関数・never-throw）。 */
export function buildEsReviewRequestContext(
  input: EsReviewSelectorInput,
): CareerEsReviewContextPayload {
  return {
    profile: input.profile ?? null,
    activity: input.activity ?? null,
    values: input.values ?? null,
    selfAnalysis: latestEsSelfAnalysisResult(input.selfAnalysisLogs),
  };
}

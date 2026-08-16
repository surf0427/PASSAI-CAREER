"use client";

/**
 * career_self_analysis_results / career_self_prs — 自己分析（/career/self-analysis）の
 * auth-scoped durable mirror。
 *
 * 役割（lib/supabase/interviewPracticeRecords.ts と同形）:
 *   - localStorage（app/career/self-analysis/selfAnalysisStorage.ts）が canonical。
 *     key='careerSelfAnalysisLogs'（結果履歴）/ 'careerSelfPRs'（自己 PR）。
 *     'careerAnalyzeState'（壁打ち作業中メモリ）は ephemeral のため永続化対象外。
 *   - 本 table はログイン済み（member）の durable mirror。natural key=(user_id, client_id)。
 *   - never throw。upsert は void、list は空配列を返す（best-effort）。
 *
 * 受験版 self_analysis_logs §32 / self_prs §35 とは別テーブル（就活データを混ぜない）。
 */

import { devWarn } from "@/lib/devLog";
import { getCareerBrowserSupabaseClient } from "@/lib/careerSupabase/browserClient";
import type { CareerSelfAnalysisLog } from "@/types/careerSelfAnalysis";
// row→domain の変換は Layer 1 共有 mapper（server reader と同一実装）へ委譲する。
import {
  CAREER_SELF_ANALYSIS_SELECT_COLUMNS,
  rowToCareerSelfAnalysisLog,
  type CareerSelfAnalysisResultRow,
} from "@/lib/careerSourceData/rowMappers";
import type { SelfPR } from "@/types/selfPR";

const RESULTS_TABLE = "career_self_analysis_results";
const SELF_PRS_TABLE = "career_self_prs";

// ── 自己分析 結果履歴 ────────────────────────────────────────────────

/** 自己分析の結果ログを upsert（best-effort）。1 件保存・backfill 兼用で配列を受ける。 */
export async function upsertCareerSelfAnalysisResultsToSupabase(
  userId: string,
  logs: CareerSelfAnalysisLog[],
): Promise<void> {
  if (!userId || logs.length === 0) return;
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return;

  const rows = logs.map((log) => ({
    user_id: userId,
    client_id: log.id,
    user_input: log.userInput ?? "",
    result: log.result ?? {},
    created_at: log.createdAt,
  }));

  try {
    const { error } = await supabase
      .from(RESULTS_TABLE)
      .upsert(rows, { onConflict: "user_id,client_id" });
    if (error) devWarn("[careerSelfAnalysis] results upsert error", error);
  } catch (err) {
    devWarn("[careerSelfAnalysis] results upsert threw", err);
  }
}

/** 自分の自己分析結果を created_at 降順で返す（never throw / 失敗時は []）。 */
export async function listCareerSelfAnalysisResultsFromSupabase(
  userId: string,
): Promise<CareerSelfAnalysisLog[]> {
  if (!userId) return [];
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(RESULTS_TABLE)
      .select(CAREER_SELF_ANALYSIS_SELECT_COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      devWarn("[careerSelfAnalysis] results list error", error);
      return [];
    }
    return ((data ?? []) as CareerSelfAnalysisResultRow[]).map(rowToCareerSelfAnalysisLog);
  } catch (err) {
    devWarn("[careerSelfAnalysis] results list threw", err);
    return [];
  }
}

// ── 自己 PR カード ───────────────────────────────────────────────────

type SelfPrRow = {
  data: unknown;
};

/** 自己 PR カードを upsert（best-effort）。data に SelfPR 全体を入れる。 */
export async function upsertCareerSelfPRsToSupabase(
  userId: string,
  prs: SelfPR[],
): Promise<void> {
  if (!userId || prs.length === 0) return;
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return;

  const rows = prs.map((pr) => ({
    user_id: userId,
    client_id: pr.id,
    data: pr,
    ...(pr.createdAt ? { created_at: pr.createdAt } : {}),
  }));

  try {
    const { error } = await supabase
      .from(SELF_PRS_TABLE)
      .upsert(rows, { onConflict: "user_id,client_id" });
    if (error) devWarn("[careerSelfAnalysis] selfPRs upsert error", error);
  } catch (err) {
    devWarn("[careerSelfAnalysis] selfPRs upsert threw", err);
  }
}

/** 自分の自己 PR カードを created_at 降順で返す（never throw / 失敗時は []）。 */
export async function listCareerSelfPRsFromSupabase(userId: string): Promise<SelfPR[]> {
  if (!userId) return [];
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(SELF_PRS_TABLE)
      .select("data")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      devWarn("[careerSelfAnalysis] selfPRs list error", error);
      return [];
    }
    return ((data ?? []) as SelfPrRow[])
      .map((row) => row.data)
      .filter((d): d is SelfPR => !!d && typeof d === "object");
  } catch (err) {
    devWarn("[careerSelfAnalysis] selfPRs list threw", err);
    return [];
  }
}

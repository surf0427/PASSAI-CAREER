"use client";

/**
 * career_company_research_logs — 企業研究ログ（/career/company-research）の durable mirror。
 *
 *   - localStorage（app/career/company-research/companyResearchStorage.ts,
 *     key='careerCompanyResearchLogs'）が canonical。本 table はログイン済み（member）の
 *     durable mirror。natural key=(user_id, client_id)。
 *   - company_name / industry / interest_level / favorite は絞り込み用に列へ昇格。
 *   - input / review / fit_analysis は jsonb。interview_context_summary は text。
 *   - never throw（best-effort）。env 未設定 / 未ログイン時は client=null で no-op。
 *
 * 受験版のテーブルには一切依存しない。lib/supabase/careerEs.ts と同形。
 */

import { devWarn } from "@/lib/devLog";
import { getCareerBrowserSupabaseClient } from "@/lib/careerSupabase/browserClient";
import type {
  CareerCompanyResearchLog,
  CareerCompanyResearchInput,
  CareerCompanyResearchReview,
  CareerCompanyResearchFitAnalysis,
  CareerCompanyResearchRevision,
  CareerCompanyInterestLevel,
} from "@/types/careerCompanyResearch";

const TABLE = "career_company_research_logs";

type CompanyResearchRow = {
  client_id: string;
  company_name: string;
  // Company Data Spine の canonical key（Phase A / R3）。旧行では null。
  company_id: string | null;
  industry: string;
  interest_level: string | null;
  input: unknown;
  review: unknown;
  fit_analysis: unknown;
  interview_context_summary: string | null;
  revision_history: unknown;
  favorite: boolean;
  created_at: string;
  updated_at: string;
};

function interestLevel(value: unknown): CareerCompanyInterestLevel | null {
  return value === "high" || value === "mid" || value === "low" || value === "watch"
    ? value
    : null;
}

/** 企業研究ログを upsert（1 件保存・backfill 兼用で配列を受ける / best-effort）。 */
export async function upsertCareerCompanyResearchLogsToSupabase(
  userId: string,
  logs: CareerCompanyResearchLog[],
): Promise<void> {
  if (!userId || logs.length === 0) return;
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return;

  const rows = logs.map((log) => ({
    user_id: userId,
    client_id: log.id,
    company_name: log.companyName ?? "",
    company_id: log.companyId ?? null,
    industry: log.industry ?? "",
    interest_level: log.interestLevel ?? null,
    input: log.input ?? {},
    review: log.review ?? {},
    fit_analysis: log.fitAnalysis ?? {},
    interview_context_summary: log.interviewContextSummary ?? "",
    revision_history: log.revisionHistory ?? [],
    favorite: !!log.favorite,
    created_at: log.createdAt,
    updated_at: log.updatedAt,
  }));

  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert(rows, { onConflict: "user_id,client_id" });
    if (error) devWarn("[careerCompanyResearch] upsert error", error);
  } catch (err) {
    devWarn("[careerCompanyResearch] upsert threw", err);
  }
}

/** 自分の企業研究ログを created_at 降順で返す（never throw / 失敗時は []）。 */
export async function listCareerCompanyResearchLogsFromSupabase(
  userId: string,
): Promise<CareerCompanyResearchLog[]> {
  if (!userId) return [];
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select(
        "client_id, company_name, company_id, industry, interest_level, input, review, fit_analysis, interview_context_summary, revision_history, favorite, created_at, updated_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      devWarn("[careerCompanyResearch] list error", error);
      return [];
    }
    return ((data ?? []) as CompanyResearchRow[]).map((row) => ({
      id: row.client_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      companyName: row.company_name ?? "",
      // 旧行は null。欠損のまま返して呼び出し側の defensive normalize に任せる。
      ...(typeof row.company_id === "string" && row.company_id !== ""
        ? { companyId: row.company_id }
        : {}),
      industry: row.industry ?? "",
      interestLevel: interestLevel(row.interest_level),
      input: (row.input ?? {}) as CareerCompanyResearchInput,
      review: (row.review ?? {}) as CareerCompanyResearchReview,
      fitAnalysis: (row.fit_analysis ?? {}) as CareerCompanyResearchFitAnalysis,
      interviewContextSummary:
        typeof row.interview_context_summary === "string"
          ? row.interview_context_summary
          : "",
      revisionHistory: Array.isArray(row.revision_history)
        ? (row.revision_history as CareerCompanyResearchRevision[])
        : [],
      favorite: row.favorite,
    }));
  } catch (err) {
    devWarn("[careerCompanyResearch] list threw", err);
    return [];
  }
}

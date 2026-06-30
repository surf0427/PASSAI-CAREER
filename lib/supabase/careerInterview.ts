"use client";

/**
 * career_interview_sessions / career_interview_results — 面接（/career/interview）の
 * auth-scoped durable mirror。
 *
 *   - localStorage（app/career/interview/interviewStorage.ts）が canonical。
 *     key='careerInterviewSessions'（進行中 upsert）/ 'careerInterviewResults'（最終評価履歴）。
 *   - 本 table はログイン済み（member）の durable mirror。natural key=(user_id, client_id)。
 *   - never throw（best-effort）。受験版 interview_ai_* §56–§62 とは別テーブル。
 */

import { devWarn } from "@/lib/devLog";
import { getBrowserSupabaseClient } from "./browserClient";
import type {
  CareerInterviewFinalResult,
  CareerInterviewMode,
  CareerInterviewResult,
  CareerInterviewSession,
  CareerInterviewTurn,
  CareerInterviewType,
} from "@/types/careerInterview";
import type { CompanyResearchSnapshot } from "@/types/careerCompanyResearch";

// jsonb 列に保存した企業研究スナップショットを防御的に取り出す。
function snapshotOf(value: unknown): CompanyResearchSnapshot | undefined {
  return value && typeof value === "object" ? (value as CompanyResearchSnapshot) : undefined;
}

const SESSIONS_TABLE = "career_interview_sessions";
const RESULTS_TABLE = "career_interview_results";

// ── セッション ───────────────────────────────────────────────────────

type InterviewSessionRow = {
  client_id: string;
  status: string;
  mode: string;
  interview_type: string;
  turns: unknown;
  max_turns: number | null;
  company_research_log_id: string | null;
  company_research_snapshot: unknown;
  created_at: string;
  updated_at: string;
};

function turnsOf(value: unknown): CareerInterviewTurn[] {
  return Array.isArray(value) ? (value as CareerInterviewTurn[]) : [];
}

/** 面接セッションを upsert（進行中の in-place 更新・backfill 兼用 / best-effort）。 */
export async function upsertCareerInterviewSessionsToSupabase(
  userId: string,
  sessions: CareerInterviewSession[],
): Promise<void> {
  if (!userId || sessions.length === 0) return;
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return;

  const rows = sessions.map((s) => ({
    user_id: userId,
    client_id: s.id,
    status: s.status,
    mode: s.mode,
    interview_type: s.interviewType ?? "real",
    turns: s.turns ?? [],
    max_turns: s.maxTurns,
    company_research_log_id: s.companyResearchLogId ?? null,
    company_research_snapshot: s.companyResearchSnapshot ?? null,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  }));

  try {
    const { error } = await supabase
      .from(SESSIONS_TABLE)
      .upsert(rows, { onConflict: "user_id,client_id" });
    if (error) devWarn("[careerInterview] sessions upsert error", error);
  } catch (err) {
    devWarn("[careerInterview] sessions upsert threw", err);
  }
}

/** 自分の面接セッションを updated_at 降順で返す（never throw / 失敗時は []）。 */
export async function listCareerInterviewSessionsFromSupabase(
  userId: string,
): Promise<CareerInterviewSession[]> {
  if (!userId) return [];
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(SESSIONS_TABLE)
      .select(
        "client_id, status, mode, interview_type, turns, max_turns, company_research_log_id, company_research_snapshot, created_at, updated_at",
      )
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) {
      devWarn("[careerInterview] sessions list error", error);
      return [];
    }
    return ((data ?? []) as InterviewSessionRow[]).map((row) => {
      const session: CareerInterviewSession = {
        id: row.client_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: row.status === "completed" ? "completed" : "in_progress",
        mode: row.mode as CareerInterviewMode,
        interviewType: row.interview_type as CareerInterviewType,
        turns: turnsOf(row.turns),
        maxTurns: row.max_turns ?? 0,
      };
      if (typeof row.company_research_log_id === "string") {
        session.companyResearchLogId = row.company_research_log_id;
      }
      const snap = snapshotOf(row.company_research_snapshot);
      if (snap) session.companyResearchSnapshot = snap;
      return session;
    });
  } catch (err) {
    devWarn("[careerInterview] sessions list threw", err);
    return [];
  }
}

// ── 最終評価結果 ─────────────────────────────────────────────────────

type InterviewResultRow = {
  client_id: string;
  mode: string;
  interview_type: string;
  turns: unknown;
  result: unknown;
  company_research_log_id: string | null;
  company_research_snapshot: unknown;
  created_at: string;
};

/** 面接の最終評価結果を upsert（1 件保存・backfill 兼用 / best-effort）。 */
export async function upsertCareerInterviewResultsToSupabase(
  userId: string,
  results: CareerInterviewResult[],
): Promise<void> {
  if (!userId || results.length === 0) return;
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return;

  const rows = results.map((r) => ({
    user_id: userId,
    client_id: r.id,
    mode: r.mode,
    interview_type: r.interviewType ?? "real",
    turns: r.turns ?? [],
    result: r.result ?? {},
    company_research_log_id: r.companyResearchLogId ?? null,
    company_research_snapshot: r.companyResearchSnapshot ?? null,
    created_at: r.createdAt,
  }));

  try {
    const { error } = await supabase
      .from(RESULTS_TABLE)
      .upsert(rows, { onConflict: "user_id,client_id" });
    if (error) devWarn("[careerInterview] results upsert error", error);
  } catch (err) {
    devWarn("[careerInterview] results upsert threw", err);
  }
}

/** 自分の面接結果を created_at 降順で返す（never throw / 失敗時は []）。 */
export async function listCareerInterviewResultsFromSupabase(
  userId: string,
): Promise<CareerInterviewResult[]> {
  if (!userId) return [];
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(RESULTS_TABLE)
      .select(
        "client_id, mode, interview_type, turns, result, company_research_log_id, company_research_snapshot, created_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      devWarn("[careerInterview] results list error", error);
      return [];
    }
    return ((data ?? []) as InterviewResultRow[]).map((row) => {
      const result: CareerInterviewResult = {
        id: row.client_id,
        createdAt: row.created_at,
        mode: row.mode as CareerInterviewMode,
        interviewType: row.interview_type as CareerInterviewType,
        turns: turnsOf(row.turns),
        result: (row.result ?? {}) as CareerInterviewFinalResult,
      };
      if (typeof row.company_research_log_id === "string") {
        result.companyResearchLogId = row.company_research_log_id;
      }
      const snap = snapshotOf(row.company_research_snapshot);
      if (snap) result.companyResearchSnapshot = snap;
      return result;
    });
  } catch (err) {
    devWarn("[careerInterview] results list threw", err);
    return [];
  }
}

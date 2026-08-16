"use client";

/**
 * career_presentation_sessions / career_presentation_results — プレゼン
 * （/career/presentation）の auth-scoped durable mirror。
 *
 *   - localStorage（app/career/presentation/presentationStorage.ts）が canonical。
 *     key='careerPresentationSessions'（進行中 upsert）/ 'careerPresentationResults'（評価履歴）。
 *   - 本 table はログイン済み（member）の durable mirror。natural key=(user_id, client_id)。
 *   - never throw（best-effort）。受験版 presentation_* §63–§72 とは別テーブル。
 *     録画 / Supabase Storage / 課金 / 資料アップロードは未移植（MVP 対象外）。
 */

import { devWarn } from "@/lib/devLog";
import { getCareerBrowserSupabaseClient } from "@/lib/careerSupabase/browserClient";
import type {
  CareerPresentationFinalResult,
  CareerPresentationMode,
  CareerPresentationQaTurn,
  CareerPresentationResult,
  CareerPresentationSession,
  CareerPresentationType,
} from "@/types/careerPresentation";

const SESSIONS_TABLE = "career_presentation_sessions";
const RESULTS_TABLE = "career_presentation_results";

// ── セッション ───────────────────────────────────────────────────────

type PresentationSessionRow = {
  client_id: string;
  status: string;
  presentation_type: string;
  mode: string;
  theme: string;
  time_limit_sec: number | null;
  duration_sec: number | null;
  transcript: string;
  created_at: string;
  updated_at: string;
};

/** プレゼンセッションを upsert（進行中の in-place 更新・backfill 兼用 / best-effort）。 */
export async function upsertCareerPresentationSessionsToSupabase(
  userId: string,
  sessions: CareerPresentationSession[],
): Promise<void> {
  if (!userId || sessions.length === 0) return;
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return;

  const rows = sessions.map((s) => ({
    user_id: userId,
    client_id: s.id,
    status: s.status,
    presentation_type: s.presentationType,
    mode: s.mode,
    theme: s.theme,
    time_limit_sec: s.timeLimitSec,
    duration_sec: s.durationSec,
    transcript: s.transcript,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  }));

  try {
    const { error } = await supabase
      .from(SESSIONS_TABLE)
      .upsert(rows, { onConflict: "user_id,client_id" });
    if (error) devWarn("[careerPresentation] sessions upsert error", error);
  } catch (err) {
    devWarn("[careerPresentation] sessions upsert threw", err);
  }
}

/** 自分のプレゼンセッションを updated_at 降順で返す（never throw / 失敗時は []）。 */
export async function listCareerPresentationSessionsFromSupabase(
  userId: string,
): Promise<CareerPresentationSession[]> {
  if (!userId) return [];
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(SESSIONS_TABLE)
      .select(
        "client_id, status, presentation_type, mode, theme, time_limit_sec, duration_sec, transcript, created_at, updated_at",
      )
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) {
      devWarn("[careerPresentation] sessions list error", error);
      return [];
    }
    return ((data ?? []) as PresentationSessionRow[]).map((row) => ({
      id: row.client_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status === "completed" ? "completed" : "in_progress",
      presentationType: row.presentation_type as CareerPresentationType,
      mode: row.mode as CareerPresentationMode,
      theme: row.theme,
      timeLimitSec: row.time_limit_sec ?? 0,
      durationSec: row.duration_sec ?? 0,
      transcript: row.transcript ?? "",
    }));
  } catch (err) {
    devWarn("[careerPresentation] sessions list threw", err);
    return [];
  }
}

// ── 評価結果 ─────────────────────────────────────────────────────────

type PresentationResultRow = {
  client_id: string;
  presentation_type: string;
  mode: string;
  theme: string;
  time_limit_sec: number | null;
  duration_sec: number | null;
  transcript: string;
  result: unknown;
  qa: unknown | null;
  created_at: string;
};

/** プレゼン評価結果を upsert（1 件保存・Q&A 追記・backfill 兼用 / best-effort）。 */
export async function upsertCareerPresentationResultsToSupabase(
  userId: string,
  results: CareerPresentationResult[],
): Promise<void> {
  if (!userId || results.length === 0) return;
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return;

  const rows = results.map((r) => ({
    user_id: userId,
    client_id: r.id,
    presentation_type: r.presentationType,
    mode: r.mode,
    theme: r.theme,
    time_limit_sec: r.timeLimitSec,
    duration_sec: r.durationSec,
    transcript: r.transcript,
    result: r.result ?? {},
    qa: r.qa ?? null,
    created_at: r.createdAt,
  }));

  try {
    const { error } = await supabase
      .from(RESULTS_TABLE)
      .upsert(rows, { onConflict: "user_id,client_id" });
    if (error) devWarn("[careerPresentation] results upsert error", error);
  } catch (err) {
    devWarn("[careerPresentation] results upsert threw", err);
  }
}

/** 自分のプレゼン結果を created_at 降順で返す（never throw / 失敗時は []）。 */
export async function listCareerPresentationResultsFromSupabase(
  userId: string,
): Promise<CareerPresentationResult[]> {
  if (!userId) return [];
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(RESULTS_TABLE)
      .select(
        "client_id, presentation_type, mode, theme, time_limit_sec, duration_sec, transcript, result, qa, created_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      devWarn("[careerPresentation] results list error", error);
      return [];
    }
    return ((data ?? []) as PresentationResultRow[]).map((row) => {
      const result: CareerPresentationResult = {
        id: row.client_id,
        createdAt: row.created_at,
        presentationType: row.presentation_type as CareerPresentationType,
        mode: row.mode as CareerPresentationMode,
        theme: row.theme,
        timeLimitSec: row.time_limit_sec ?? 0,
        durationSec: row.duration_sec ?? 0,
        transcript: row.transcript ?? "",
        result: (row.result ?? {}) as CareerPresentationFinalResult,
      };
      if (Array.isArray(row.qa)) result.qa = row.qa as CareerPresentationQaTurn[];
      return result;
    });
  } catch (err) {
    devWarn("[careerPresentation] results list threw", err);
    return [];
  }
}

"use client";

/**
 * career_gd_solo_results — ソロ GD（1人 + AI 参加者）評価履歴の auth-scoped durable mirror。
 *
 *   - localStorage（app/career/gd/gdStorage.ts）が canonical。key='careerGdResults'。
 *   - 本 table はログイン済み（member）の durable mirror。natural key=(user_id, client_id)。
 *   - never throw（best-effort）。DDL 未適用でも devWarn を出して黙って no-op になる
 *     （既存 careerPresentation / careerInterview mirror と同じ fail-open 契約）。
 *
 * ★ マルチ GD（career_gd_room_results / lib/supabase/careerGdRoomResults.ts）とは
 *   **別系統**。評価軸も書き込み主体（service_role）も共有範囲（ranking を全員に見せる）も
 *   違うため、テーブルもモジュールも統合しない。マルチ側には一切触れない。
 *
 * ★ 本 module は ES / 面接 / プレゼンと同じ既存 repository パターンの写しであり、
 *   独自の同期アーキテクチャを持ち込まない（upsert + list の 2 関数だけ）。
 */

import { devWarn } from "@/lib/devLog";
import { getCareerBrowserSupabaseClient } from "@/lib/careerSupabase/browserClient";
import type { CareerGdResult } from "@/types/careerGd";
import { normalizeCareerGdResult } from "@/app/career/gd/gdStorage";

const SOLO_RESULTS_TABLE = "career_gd_solo_results";

const SELECT_COLUMNS =
  "client_id, participation_mode, format, self_role, self_company_grade, time_limit_sec, favorite, theme, participants, transcript, feedbacks, ranking, matching_hints, overall_summary, created_at";

type GdSoloResultRow = {
  client_id: string;
  participation_mode: string;
  format: string;
  self_role: string;
  self_company_grade: string;
  time_limit_sec: number | null;
  favorite: boolean | null;
  theme: unknown;
  participants: unknown;
  transcript: unknown;
  feedbacks: unknown;
  ranking: unknown | null;
  matching_hints: unknown;
  overall_summary: string | null;
  created_at: string;
};

/** ソロ GD 評価結果を upsert（保存・favorite 更新・backfill 兼用 / best-effort）。 */
export async function upsertCareerGdSoloResultsToSupabase(
  userId: string,
  results: CareerGdResult[],
): Promise<void> {
  if (!userId || results.length === 0) return;
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return;

  const rows = results.map((r) => ({
    user_id: userId,
    client_id: r.id,
    participation_mode: r.participationMode ?? "solo",
    format: r.format ?? "",
    self_role: r.selfRole ?? "",
    self_company_grade: r.selfCompanyGrade ?? "",
    time_limit_sec: r.timeLimitSec ?? null,
    favorite: !!r.favorite,
    theme: r.theme ?? {},
    participants: r.participants ?? [],
    transcript: r.transcript ?? [],
    feedbacks: r.feedbacks ?? [],
    ranking: r.ranking ?? null,
    matching_hints: r.matchingHints ?? {},
    overall_summary: r.overallSummary ?? "",
    created_at: r.createdAt,
  }));

  try {
    const { error } = await supabase
      .from(SOLO_RESULTS_TABLE)
      .upsert(rows, { onConflict: "user_id,client_id" });
    if (error) devWarn("[careerGdSolo] results upsert error", error);
  } catch (err) {
    devWarn("[careerGdSolo] results upsert threw", err);
  }
}

/**
 * 自分のソロ GD 評価履歴を created_at 降順で返す（never throw / 失敗時は []）。
 *
 * ★ 行 → CareerGdResult の変換は localStorage 読み取りと **同じ normalizer**
 *   （gdStorage.normalizeCareerGdResult）を通す。read boundary を 2 つ作らないため。
 *   形が壊れている行は normalizer が null にするので、restore 側で落ちない。
 */
export async function listCareerGdSoloResultsFromSupabase(
  userId: string,
): Promise<CareerGdResult[]> {
  if (!userId) return [];
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(SOLO_RESULTS_TABLE)
      .select(SELECT_COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      devWarn("[careerGdSolo] results list error", error);
      return [];
    }
    return ((data ?? []) as GdSoloResultRow[])
      .map((row) =>
        normalizeCareerGdResult({
          id: row.client_id,
          createdAt: row.created_at,
          participationMode: row.participation_mode,
          format: row.format,
          theme: row.theme,
          timeLimitSec: row.time_limit_sec ?? 0,
          participants: row.participants,
          transcript: row.transcript,
          selfRole: row.self_role,
          feedbacks: row.feedbacks,
          ranking: row.ranking ?? undefined,
          selfCompanyGrade: row.self_company_grade,
          overallSummary: row.overall_summary ?? "",
          matchingHints: row.matching_hints,
          favorite: !!row.favorite,
        }),
      )
      .filter((r): r is CareerGdResult => r !== null);
  } catch (err) {
    devWarn("[careerGdSolo] results list threw", err);
    return [];
  }
}

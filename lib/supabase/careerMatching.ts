"use client";

/**
 * career_matching_results — 企業マッチング結果履歴（/career/matching）の durable mirror。
 *
 *   - localStorage（app/career/matching/matchingStorage.ts, key='careerMatchingResults'）が
 *     canonical。本 table はログイン済み（member）の durable mirror。
 *   - natural key=(user_id, client_id)。never throw（best-effort）。
 *   - result は決定的マッチングエンジンの出力（CareerMatchEngineResult）を jsonb で保持。
 */

import { devWarn } from "@/lib/devLog";
import { getCareerBrowserSupabaseClient } from "@/lib/careerSupabase/browserClient";
import type { CareerMatchingLog } from "@/types/careerMatching";
import type { CareerMatchEngineResult } from "@/lib/careerMatching";

const TABLE = "career_matching_results";

type MatchingResultRow = {
  client_id: string;
  user_input: unknown;
  result: unknown;
  created_at: string;
};

/** マッチング結果ログを upsert（1 件保存・backfill 兼用で配列を受ける / best-effort）。 */
export async function upsertCareerMatchingResultsToSupabase(
  userId: string,
  logs: CareerMatchingLog[],
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
      .from(TABLE)
      .upsert(rows, { onConflict: "user_id,client_id" });
    if (error) devWarn("[careerMatching] upsert error", error);
  } catch (err) {
    devWarn("[careerMatching] upsert threw", err);
  }
}

/** 自分のマッチング結果を created_at 降順で返す（never throw / 失敗時は []）。 */
export async function listCareerMatchingResultsFromSupabase(
  userId: string,
): Promise<CareerMatchingLog[]> {
  if (!userId) return [];
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("client_id, user_input, result, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      devWarn("[careerMatching] list error", error);
      return [];
    }
    return ((data ?? []) as MatchingResultRow[]).map((row) => ({
      id: row.client_id,
      createdAt: row.created_at,
      userInput: typeof row.user_input === "string" ? row.user_input : "",
      result: (row.result ?? {}) as CareerMatchEngineResult,
    }));
  } catch (err) {
    devWarn("[careerMatching] list threw", err);
    return [];
  }
}

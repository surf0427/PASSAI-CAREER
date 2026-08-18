"use client";

/**
 * career_es_logs — ES 生成/添削ログ（/career/es）の durable mirror。
 *
 *   - localStorage（app/career/es/esStorage.ts, key='careerEsLogs'）が canonical。
 *     本 table はログイン済み（member）の durable mirror。natural key=(user_id, client_id)。
 *   - favorite / submitted は絞り込み用に列へ昇格。その他メタは meta（jsonb）へまとめる。
 *   - userInput / result / editedResult は jsonb。never throw（best-effort）。
 *   - ES トレーニング本体（body / review / groupId / version / mode / deepDive）も meta へ
 *     往復させる（Audit P1-A）。これが欠けていた間は、別端末 restore で添削結果・版履歴・
 *     深掘りが失われ、現行 ES が LegacyView へ誤降格していた。
 */

import { devWarn } from "@/lib/devLog";
import { getCareerBrowserSupabaseClient } from "@/lib/careerSupabase/browserClient";
import type { CareerEsLog } from "@/types/careerEs";
// row⇄domain の変換は Layer 1 共有 mapper（server reader と同一実装）へ委譲する。
//   ★ write 側（careerEsLogToMeta）も read 側と同じ module に置く。別 module に置くと
//     往復の対称性を検証できず、meta の落ちが今回のように長く残る（Audit P1-A）。
import {
  CAREER_ES_SELECT_COLUMNS,
  careerEsLogToMeta,
  rowToCareerEsLog,
  type CareerEsLogRow,
} from "@/lib/careerSourceData/rowMappers";

const TABLE = "career_es_logs";

/** ES ログを upsert（1 件保存・backfill 兼用で配列を受ける / best-effort）。 */
export async function upsertCareerEsLogsToSupabase(
  userId: string,
  logs: CareerEsLog[],
): Promise<void> {
  if (!userId || logs.length === 0) return;
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return;

  const rows = logs.map((log) => ({
    user_id: userId,
    client_id: log.id,
    user_input: log.userInput ?? "",
    result: log.result ?? {},
    edited_result: log.editedResult ?? null,
    favorite: !!log.favorite,
    submitted: !!log.submitted,
    meta: careerEsLogToMeta(log),
    created_at: log.createdAt,
  }));

  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert(rows, { onConflict: "user_id,client_id" });
    if (error) devWarn("[careerEs] upsert error", error);
  } catch (err) {
    devWarn("[careerEs] upsert threw", err);
  }
}

/** 自分の ES ログを created_at 降順で返す（never throw / 失敗時は []）。 */
export async function listCareerEsLogsFromSupabase(userId: string): Promise<CareerEsLog[]> {
  if (!userId) return [];
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select(CAREER_ES_SELECT_COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      devWarn("[careerEs] list error", error);
      return [];
    }
    return ((data ?? []) as CareerEsLogRow[]).map(rowToCareerEsLog);
  } catch (err) {
    devWarn("[careerEs] list threw", err);
    return [];
  }
}

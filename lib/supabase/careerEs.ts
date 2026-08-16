"use client";

/**
 * career_es_logs — ES 生成/添削ログ（/career/es）の durable mirror。
 *
 *   - localStorage（app/career/es/esStorage.ts, key='careerEsLogs'）が canonical。
 *     本 table はログイン済み（member）の durable mirror。natural key=(user_id, client_id)。
 *   - favorite / submitted は絞り込み用に列へ昇格。その他メタは meta（jsonb）へまとめる。
 *   - userInput / result / editedResult は jsonb。never throw（best-effort）。
 */

import { devWarn } from "@/lib/devLog";
import { getCareerBrowserSupabaseClient } from "@/lib/careerSupabase/browserClient";
import type { CareerEsLog } from "@/types/careerEs";
// row→domain の変換は Layer 1 共有 mapper（server reader と同一実装）へ委譲する。
import {
  CAREER_ES_SELECT_COLUMNS,
  rowToCareerEsLog,
  type CareerEsLogRow,
} from "@/lib/careerSourceData/rowMappers";

const TABLE = "career_es_logs";

// CareerEsLog のメタ情報（昇格カラム以外）を meta jsonb にまとめる。
function toMeta(log: CareerEsLog): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (log.companyName !== undefined) meta.companyName = log.companyName;
  // Company Data Spine の canonical key（Phase A / R4）。旧ログでは欠損。
  if (log.companyId !== undefined) meta.companyId = log.companyId;
  if (log.question !== undefined) meta.question = log.question;
  if (log.charLimit !== undefined) meta.charLimit = log.charLimit;
  if (log.selectionType !== undefined) meta.selectionType = log.selectionType;
  if (log.industry !== undefined) meta.industry = log.industry;
  if (log.jobType !== undefined) meta.jobType = log.jobType;
  if (log.sourceLogId !== undefined) meta.sourceLogId = log.sourceLogId;
  if (log.sourceType !== undefined) meta.sourceType = log.sourceType;
  if (log.companyResearchLogId !== undefined) {
    meta.companyResearchLogId = log.companyResearchLogId;
  }
  if (log.companyResearchSnapshot !== undefined) {
    meta.companyResearchSnapshot = log.companyResearchSnapshot;
  }
  return meta;
}

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
    meta: toMeta(log),
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

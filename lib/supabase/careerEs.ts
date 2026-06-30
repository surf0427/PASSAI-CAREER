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
import { getBrowserSupabaseClient } from "./browserClient";
import type {
  CareerEsLog,
  CareerEsResult,
  CareerEsSelectionType,
} from "@/types/careerEs";

const TABLE = "career_es_logs";

type EsLogRow = {
  client_id: string;
  user_input: unknown;
  result: unknown;
  edited_result: unknown | null;
  favorite: boolean;
  submitted: boolean;
  meta: unknown;
  created_at: string;
};

// CareerEsLog のメタ情報（昇格カラム以外）を meta jsonb にまとめる。
function toMeta(log: CareerEsLog): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (log.companyName !== undefined) meta.companyName = log.companyName;
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
  const supabase = getBrowserSupabaseClient();
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
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("client_id, user_input, result, edited_result, favorite, submitted, meta, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      devWarn("[careerEs] list error", error);
      return [];
    }
    return ((data ?? []) as EsLogRow[]).map((row) => {
      const meta = (row.meta && typeof row.meta === "object" ? row.meta : {}) as Record<
        string,
        unknown
      >;
      const log: CareerEsLog = {
        id: row.client_id,
        createdAt: row.created_at,
        userInput: typeof row.user_input === "string" ? row.user_input : "",
        result: (row.result ?? {}) as CareerEsResult,
        favorite: row.favorite,
        submitted: row.submitted,
      };
      if (row.edited_result) log.editedResult = row.edited_result as CareerEsResult;
      if (typeof meta.companyName === "string") log.companyName = meta.companyName;
      if (typeof meta.question === "string") log.question = meta.question;
      if (typeof meta.charLimit === "number") log.charLimit = meta.charLimit;
      if (typeof meta.selectionType === "string")
        log.selectionType = meta.selectionType as CareerEsSelectionType;
      if (typeof meta.industry === "string") log.industry = meta.industry;
      if (typeof meta.jobType === "string") log.jobType = meta.jobType;
      if (typeof meta.sourceLogId === "string") log.sourceLogId = meta.sourceLogId;
      if (meta.sourceType === "generated" || meta.sourceType === "review_rewrite")
        log.sourceType = meta.sourceType;
      if (typeof meta.companyResearchLogId === "string")
        log.companyResearchLogId = meta.companyResearchLogId;
      if (meta.companyResearchSnapshot && typeof meta.companyResearchSnapshot === "object")
        log.companyResearchSnapshot =
          meta.companyResearchSnapshot as CareerEsLog["companyResearchSnapshot"];
      return log;
    });
  } catch (err) {
    devWarn("[careerEs] list threw", err);
    return [];
  }
}

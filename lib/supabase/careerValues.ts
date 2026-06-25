"use client";

/**
 * career_values — 「就活軸整理」(/career/values) の auth-scoped Supabase 永続ミラー。
 *
 * 役割:
 *   - localStorage（app/career/values/careerValuesStorage.ts）を canonical とし、本 table は
 *     ログイン済みユーザー（member）の durable mirror。self_prs / interview_practice_records と
 *     同じ auth-scoped 永続層であり、mirror_events 系統ではない。
 *   - user-scoped browser client（getBrowserSupabaseClient）で読み書きするため RLS が効く
 *     （schema.sql career_values の全行操作は auth.uid() = user_id で閉じる）。
 *   - 1 ユーザー 1 行（UNIQUE(user_id)）。保存は upsert（onConflict=user_id）で冪等。
 *   - never throw。env 未設定 / 失敗時は discriminated result を返し、UI を壊さない。
 *
 * 受験版（AO・推薦・大学入試）には一切依存しない。
 */

import { devWarn } from "@/lib/devLog";
import { getBrowserSupabaseClient } from "./browserClient";
import type {
  CareerValues,
  CareerValuesNotes,
  CareerValuesSelections,
} from "@/types/careerValues";

const TABLE = "career_values";

// DB 行（flat なカラム構成）。selections は 8 カテゴリのカラムに分割して持つ。
type CareerValuesRow = {
  user_id: string;
  priorities: unknown;
  avoidances: unknown;
  industries: unknown;
  job_types: unknown;
  work_styles: unknown;
  company_types: unknown;
  career_goals: unknown;
  culture_preferences: unknown;
  notes: unknown;
  overall_note: string | null;
  updated_at: string | null;
};

const SELECT_COLUMNS =
  "user_id, priorities, avoidances, industries, job_types, work_styles, " +
  "company_types, career_goals, culture_preferences, notes, overall_note, updated_at";

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function rowToSelections(row: CareerValuesRow): CareerValuesSelections {
  return {
    priorities: strArray(row.priorities),
    avoidances: strArray(row.avoidances),
    industries: strArray(row.industries),
    jobTypes: strArray(row.job_types),
    workStyles: strArray(row.work_styles),
    companyTypes: strArray(row.company_types),
    careerGoals: strArray(row.career_goals),
    culturePreferences: strArray(row.culture_preferences),
  };
}

function rowToNotes(row: CareerValuesRow): CareerValuesNotes {
  const raw =
    row.notes && typeof row.notes === "object"
      ? (row.notes as Record<string, unknown>)
      : {};
  const pick = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  return {
    priorities: pick("priorities"),
    avoidances: pick("avoidances"),
    industries: pick("industries"),
    jobTypes: pick("jobTypes"),
    workStyles: pick("workStyles"),
    companyTypes: pick("companyTypes"),
    careerGoals: pick("careerGoals"),
    culturePreferences: pick("culturePreferences"),
  };
}

function rowToCareerValues(row: CareerValuesRow): CareerValues {
  return {
    selections: rowToSelections(row),
    notes: rowToNotes(row),
    overallNote: typeof row.overall_note === "string" ? row.overall_note : "",
    updatedAt: row.updated_at ?? undefined,
  };
}

export type LoadCareerValuesResult =
  | { kind: "ok"; values: CareerValues }
  | { kind: "not-found" }
  | { kind: "no-env" }
  | { kind: "error"; message: string };

/**
 * 自分の career_values 行を 1 件 SELECT する。RLS により他人の行は取得できない。
 */
export async function loadCareerValuesFromSupabase(
  userId: string,
): Promise<LoadCareerValuesResult> {
  if (!userId) return { kind: "no-env" };
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return { kind: "no-env" };

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select(SELECT_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle<CareerValuesRow>();
    if (error) {
      devWarn("[careerValues] load error", error);
      return { kind: "error", message: error.message ?? "load failed" };
    }
    if (!data) return { kind: "not-found" };
    return { kind: "ok", values: rowToCareerValues(data) };
  } catch (err) {
    devWarn("[careerValues] load threw", err);
    const message = err instanceof Error ? err.message : "load threw";
    return { kind: "error", message };
  }
}

export type SaveCareerValuesResult =
  | { kind: "ok" }
  | { kind: "no-env" }
  | { kind: "error"; message: string };

/**
 * 自分の career_values 行を upsert する（1 ユーザー 1 行 / onConflict=user_id）。
 * - WITH CHECK (auth.uid() = user_id) を満たすため user_id を必ず付ける。
 * - localStorage が canonical のため、本関数の失敗は呼び出し側で握りつぶし可
 *   （best-effort durable mirror）。
 */
export async function saveCareerValuesToSupabase(
  userId: string,
  values: CareerValues,
): Promise<SaveCareerValuesResult> {
  if (!userId) return { kind: "no-env" };
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return { kind: "no-env" };

  const row = {
    user_id: userId,
    priorities: values.selections.priorities,
    avoidances: values.selections.avoidances,
    industries: values.selections.industries,
    job_types: values.selections.jobTypes,
    work_styles: values.selections.workStyles,
    company_types: values.selections.companyTypes,
    career_goals: values.selections.careerGoals,
    culture_preferences: values.selections.culturePreferences,
    notes: values.notes,
    overall_note: values.overallNote,
  };

  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert(row, { onConflict: "user_id" });
    if (error) {
      devWarn("[careerValues] upsert error", error);
      return { kind: "error", message: error.message ?? "upsert failed" };
    }
    return { kind: "ok" };
  } catch (err) {
    devWarn("[careerValues] upsert threw", err);
    const message = err instanceof Error ? err.message : "upsert threw";
    return { kind: "error", message };
  }
}

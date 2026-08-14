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
import {
  enqueueLatestMirrorWrite,
  mirrorWriteKey,
} from "@/lib/careerSourceData/mirrorWriteQueue";
import type { CareerValues } from "@/types/careerValues";
import {
  CAREER_VALUES_SELECT_COLUMNS,
  rowToCareerValues,
  type CareerValuesRow,
} from "@/lib/careerSourceData/rowMappers";

const TABLE = "career_values";

// DB 行の shape / row→domain の変換は lib/careerSourceData/rowMappers（純関数・単一実装）へ委譲する。
//   Layer 1 の server reader（serverReader.server.ts）も同じ mapper を使うため、二重実装を作らない。

const SELECT_COLUMNS = CAREER_VALUES_SELECT_COLUMNS;

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

  // D-S3: 同一 user の write を直列化し、遅延応答による mirror 巻き戻り（W4）を防ぐ。
  //   全文書 upsert なので、待機中の古い write は最新へ coalesce してよい。
  let outcome: SaveCareerValuesResult = { kind: "ok" };
  await enqueueLatestMirrorWrite(mirrorWriteKey(TABLE, userId), async () => {
    try {
      const { error } = await supabase
        .from(TABLE)
        .upsert(row, { onConflict: "user_id" });
      if (error) {
        devWarn("[careerValues] upsert error", error);
        outcome = { kind: "error", message: error.message ?? "upsert failed" };
        return;
      }
      outcome = { kind: "ok" };
    } catch (err) {
      devWarn("[careerValues] upsert threw", err);
      const message = err instanceof Error ? err.message : "upsert threw";
      outcome = { kind: "error", message };
    }
  });
  return outcome;
}

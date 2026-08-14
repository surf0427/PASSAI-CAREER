"use client";

/**
 * career_profiles — 就活版プロフィール（/career/profile）の auth-scoped durable mirror。
 *
 * 役割（lib/supabase/careerValues.ts と同形）:
 *   - localStorage（app/career/profile/profileStorage.ts, key='careerBasicFormData'）が
 *     canonical。本 table はログイン済み（member）ユーザーの durable mirror。
 *   - user-scoped browser client（getBrowserSupabaseClient）で読み書きするため RLS が効く。
 *   - 1 ユーザー 1 行（UNIQUE(user_id)）。保存は upsert（onConflict=user_id）で冪等。
 *   - never throw。env 未設定 / 失敗時は discriminated result または void を返し UI を壊さない。
 *
 * 受験版（AO・推薦・大学入試）の profiles / basic_info_logs には一切依存しない。
 */

import { devWarn } from "@/lib/devLog";
import { getBrowserSupabaseClient } from "./browserClient";
import {
  enqueueLatestMirrorWrite,
  mirrorWriteKey,
} from "@/lib/careerSourceData/mirrorWriteQueue";
import type { CareerProfile } from "@/types/careerProfile";

const TABLE = "career_profiles";

type CareerProfileRow = {
  user_id: string;
  data: unknown;
  updated_at: string | null;
};

const SELECT_COLUMNS = "user_id, data, updated_at";

export type LoadCareerProfileResult =
  | { kind: "ok"; profile: CareerProfile }
  | { kind: "not-found" }
  | { kind: "no-env" }
  | { kind: "error"; message: string };

/** 自分の career_profiles 行を 1 件 SELECT する。data（jsonb）を CareerProfile として返す。 */
export async function loadCareerProfileFromSupabase(
  userId: string,
): Promise<LoadCareerProfileResult> {
  if (!userId) return { kind: "no-env" };
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return { kind: "no-env" };

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select(SELECT_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle<CareerProfileRow>();
    if (error) {
      devWarn("[careerProfile] load error", error);
      return { kind: "error", message: error.message ?? "load failed" };
    }
    if (!data || !data.data || typeof data.data !== "object") {
      return { kind: "not-found" };
    }
    return { kind: "ok", profile: data.data as CareerProfile };
  } catch (err) {
    devWarn("[careerProfile] load threw", err);
    const message = err instanceof Error ? err.message : "load threw";
    return { kind: "error", message };
  }
}

/**
 * 自分の career_profiles 行を upsert する（best-effort）。
 * - data に CareerProfile 全体を入れ、検索/表示用の列を CareerProfile から派生して昇格。
 * - localStorage が canonical のため失敗しても throw しない。
 */
export async function saveCareerProfileToSupabase(
  userId: string,
  profile: CareerProfile,
): Promise<void> {
  if (!userId) return;
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return;

  const pref = Array.isArray(profile.preferences) ? profile.preferences[0] : undefined;
  const row = {
    user_id: userId,
    name: profile.name ?? "",
    university: pref?.university ?? "",
    faculty: pref?.faculty ?? "",
    department: pref?.department ?? "",
    grade: profile.grade ?? "",
    graduation_year: profile.graduationYear ?? "",
    gender: profile.gender ?? "",
    data: profile,
  };

  // D-S3: 同一 user の write を直列化し、遅延応答による mirror 巻き戻り（W4）を防ぐ。
  //   全文書 upsert なので、待機中の古い write は最新へ coalesce してよい。
  await enqueueLatestMirrorWrite(mirrorWriteKey(TABLE, userId), async () => {
    try {
      const { error } = await supabase.from(TABLE).upsert(row, { onConflict: "user_id" });
      if (error) devWarn("[careerProfile] upsert error", error);
    } catch (err) {
      devWarn("[careerProfile] upsert threw", err);
    }
  });
}

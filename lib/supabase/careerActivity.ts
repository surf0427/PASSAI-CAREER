"use client";

/**
 * career_activities — 就活版「活動整理」(/career/activity) の auth-scoped durable mirror。
 *
 * 役割（lib/supabase/careerProfile.ts と同形）:
 *   - localStorage（app/career/activity/activityStorage.ts, key='careerActivityData'）が
 *     canonical。本 table はログイン済み（member）ユーザーの durable mirror。
 *   - CareerActivity は 18 セクションの大きな単一文書のため data 全体を jsonb で持つ。
 *   - 1 ユーザー 1 行（UNIQUE(user_id)）。upsert（onConflict=user_id）で冪等。never throw。
 *
 * 受験版の activity_logs には一切依存しない。
 */

import { devWarn } from "@/lib/devLog";
import { getBrowserSupabaseClient } from "./browserClient";
import {
  enqueueLatestMirrorWrite,
  mirrorWriteKey,
} from "@/lib/careerSourceData/mirrorWriteQueue";
import type { CareerActivity } from "@/types/careerActivity";

const TABLE = "career_activities";

type CareerActivityRow = {
  user_id: string;
  data: unknown;
  updated_at: string | null;
};

export type LoadCareerActivityResult =
  | { kind: "ok"; activity: CareerActivity }
  | { kind: "not-found" }
  | { kind: "no-env" }
  | { kind: "error"; message: string };

/** 自分の career_activities 行を 1 件 SELECT する。data（jsonb）を CareerActivity として返す。 */
export async function loadCareerActivityFromSupabase(
  userId: string,
): Promise<LoadCareerActivityResult> {
  if (!userId) return { kind: "no-env" };
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return { kind: "no-env" };

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("user_id, data, updated_at")
      .eq("user_id", userId)
      .maybeSingle<CareerActivityRow>();
    if (error) {
      devWarn("[careerActivity] load error", error);
      return { kind: "error", message: error.message ?? "load failed" };
    }
    if (!data || !data.data || typeof data.data !== "object") {
      return { kind: "not-found" };
    }
    return { kind: "ok", activity: data.data as CareerActivity };
  } catch (err) {
    devWarn("[careerActivity] load threw", err);
    const message = err instanceof Error ? err.message : "load threw";
    return { kind: "error", message };
  }
}

/** 自分の career_activities 行を upsert する（best-effort / never throw）。 */
export async function saveCareerActivityToSupabase(
  userId: string,
  activity: CareerActivity,
): Promise<void> {
  if (!userId) return;
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return;

  // D-S3: 同一 user の write を直列化し、遅延応答による mirror 巻き戻り（W4）を防ぐ。
  await enqueueLatestMirrorWrite(mirrorWriteKey(TABLE, userId), async () => {
    try {
      const { error } = await supabase
        .from(TABLE)
        .upsert({ user_id: userId, data: activity }, { onConflict: "user_id" });
      if (error) devWarn("[careerActivity] upsert error", error);
    } catch (err) {
      devWarn("[careerActivity] upsert threw", err);
    }
  });
}

"use client";

/**
 * career_consultation_threads — 就活相談 AI（/career/consultation）の durable mirror。
 *
 *   - localStorage（app/career/consultation/consultationStorage.ts, key='careerConsultationLogs'）
 *     が canonical。本 table はログイン済み（member）の durable mirror。
 *   - スレッド 1 件 = 1 行。messages はスレッド内メッセージ配列を jsonb で同居（MVP）。
 *   - natural key=(user_id, client_id)。upsert（メッセージ送受信のたびに上書き）。never throw。
 *   - 受験版 tutor_chat_threads §19 / tutor_chat_messages §22 とは別テーブル。
 */

import { devWarn } from "@/lib/devLog";
import { getBrowserSupabaseClient } from "./browserClient";
import type {
  CareerConsultationMessage,
  CareerConsultationThread,
} from "@/types/careerConsultation";

const TABLE = "career_consultation_threads";

type ConsultationThreadRow = {
  client_id: string;
  title: string;
  messages: unknown;
  created_at: string;
  updated_at: string;
};

/** 相談スレッドを upsert（メッセージ送受信ごとの保存・backfill 兼用 / best-effort）。 */
export async function upsertCareerConsultationThreadsToSupabase(
  userId: string,
  threads: CareerConsultationThread[],
): Promise<void> {
  if (!userId || threads.length === 0) return;
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return;

  const rows = threads.map((t) => ({
    user_id: userId,
    client_id: t.id,
    title: t.title ?? "",
    messages: t.messages ?? [],
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  }));

  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert(rows, { onConflict: "user_id,client_id" });
    if (error) devWarn("[careerConsultation] upsert error", error);
  } catch (err) {
    devWarn("[careerConsultation] upsert threw", err);
  }
}

/** 自分の相談スレッドを updated_at 降順で返す（never throw / 失敗時は []）。 */
export async function listCareerConsultationThreadsFromSupabase(
  userId: string,
): Promise<CareerConsultationThread[]> {
  if (!userId) return [];
  const supabase = getBrowserSupabaseClient();
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("client_id, title, messages, created_at, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) {
      devWarn("[careerConsultation] list error", error);
      return [];
    }
    return ((data ?? []) as ConsultationThreadRow[]).map((row) => ({
      id: row.client_id,
      title: row.title ?? "",
      messages: Array.isArray(row.messages)
        ? (row.messages as CareerConsultationMessage[])
        : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch (err) {
    devWarn("[careerConsultation] list threw", err);
    return [];
  }
}

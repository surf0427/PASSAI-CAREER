"use client";

/**
 * career_accounts — 就活版の auth-canonical アカウント行（表示ID / メール）。
 *
 * 所有者契約（受験版 profiles と同方針）:
 *   - 行 identity は常に `id = auth.uid()`。所有者判定 / RLS / 保存キーの正本。
 *   - display_user_id は **表示用** のみ。所有者判定・FK・認証には絶対に使わない。
 *   - email は復帰・表示の補助（nullable）。ログイン識別には使わない（identity は id）。
 *
 * 既存の career_profiles（localStorage=careerBasicFormData の data mirror, key=user_id）
 * とは **別テーブル**。本 module は career 専用 browser client（RLS auth.uid()=id）で
 * user-scoped に読み書きする。never throw（discriminated result / void）。
 */

import { devWarn } from "@/lib/devLog";
import { getCareerBrowserSupabaseClient } from "./browserClient";

const TABLE = "career_accounts";

type CareerAccountRow = {
  id: string;
  display_user_id: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
};

export type CareerAccount = {
  id: string;
  displayUserId: string | null;
  email: string | null;
  createdAt: string;
  updatedAt: string;
};

const ACCOUNT_COLUMNS = "id, display_user_id, email, created_at, updated_at";

function toAccount(row: CareerAccountRow): CareerAccount {
  return {
    id: row.id,
    displayUserId: row.display_user_id,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type LoadCareerAccountResult =
  | { kind: "ok"; account: CareerAccount }
  | { kind: "not-found" }
  | { kind: "no-env" }
  | { kind: "error"; message: string };

/** 自分の career_accounts 行を 1 件 SELECT する（RLS で自分の行のみ可視）。 */
export async function loadCareerAccount(
  userId: string,
): Promise<LoadCareerAccountResult> {
  if (!userId) return { kind: "no-env" };
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return { kind: "no-env" };

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select(ACCOUNT_COLUMNS)
      .eq("id", userId)
      .maybeSingle<CareerAccountRow>();
    if (error) {
      devWarn("[careerAccount] load error", error);
      return { kind: "error", message: error.message ?? "load failed" };
    }
    if (!data) return { kind: "not-found" };
    return { kind: "ok", account: toAccount(data) };
  } catch (err) {
    devWarn("[careerAccount] load threw", err);
    const message = err instanceof Error ? err.message : "load threw";
    return { kind: "error", message };
  }
}

export type EnsureCareerAccountResult =
  | { kind: "ok"; account: CareerAccount }
  | { kind: "no-env" }
  | { kind: "error"; message: string };

/**
 * career_accounts 行が無ければ作成（idempotent）。ログイン成功直後に呼ぶ。
 * - id = userId（= auth.uid()）。RLS insert policy（auth.uid()=id）で自分の行のみ作成可。
 * - display_user_id = null（表示IDは onboarding で後から設定。DB 上 nullable）。
 * - email = ログイン中の auth email（表示・復帰補助。ログイン識別には使わない）。
 * - 並列タブ / 二重起動で先に作られていても再 load で吸収（冪等）。never throw。
 */
export async function ensureCareerAccount(
  userId: string,
  email: string | null,
): Promise<EnsureCareerAccountResult> {
  if (!userId) return { kind: "no-env" };
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return { kind: "no-env" };

  const initial = await loadCareerAccount(userId);
  if (initial.kind === "ok") return { kind: "ok", account: initial.account };
  if (initial.kind === "no-env") return { kind: "no-env" };
  if (initial.kind === "error") {
    // SELECT が落ちていても INSERT は別 policy で通る可能性があるので一度試す。
    devWarn("[careerAccount] ensure load failed, trying insert anyway", initial.message);
  }

  try {
    const { error } = await supabase
      .from(TABLE)
      .insert({ id: userId, display_user_id: null, email });
    if (error) {
      // 並列タブで先に insert 済み（23505 on id）などは再 load で救う。
      devWarn("[careerAccount] ensure insert error", error);
      const reload = await loadCareerAccount(userId);
      if (reload.kind === "ok") return { kind: "ok", account: reload.account };
      return { kind: "error", message: error.message ?? "account insert failed" };
    }
  } catch (err) {
    devWarn("[careerAccount] ensure insert threw", err);
    const reload = await loadCareerAccount(userId);
    if (reload.kind === "ok") return { kind: "ok", account: reload.account };
    const message = err instanceof Error ? err.message : "account insert threw";
    return { kind: "error", message };
  }

  const after = await loadCareerAccount(userId);
  if (after.kind === "ok") return { kind: "ok", account: after.account };
  if (after.kind === "no-env") return { kind: "no-env" };
  if (after.kind === "not-found") {
    return { kind: "error", message: "account insert succeeded but row not visible (RLS?)" };
  }
  return { kind: "error", message: after.message };
}

export type SaveCareerDisplayUserIdResult =
  | { kind: "ok"; account: CareerAccount }
  | { kind: "duplicate" }
  | { kind: "no-env" }
  | { kind: "error"; message: string };

/**
 * display_user_id を設定する（onboarding）。
 * - バリデーションは呼び出し側責務（lib/displayUserId.ts）。
 * - upsert(onConflict='id')。email も一緒に更新（表示補助）。
 * - display_user_id UNIQUE 制約違反（23505）を `duplicate` に翻訳する。
 *   （RLS で他人の行は SELECT できないため、重複判定は UNIQUE 制約が唯一の砦。）
 */
export async function saveCareerDisplayUserId(input: {
  userId: string;
  displayUserId: string;
  email: string | null;
}): Promise<SaveCareerDisplayUserIdResult> {
  const { userId, displayUserId, email } = input;
  if (!userId) return { kind: "no-env" };
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return { kind: "no-env" };

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .upsert(
        { id: userId, display_user_id: displayUserId, email },
        { onConflict: "id" },
      )
      .select(ACCOUNT_COLUMNS)
      .maybeSingle<CareerAccountRow>();

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return { kind: "duplicate" };
      }
      devWarn("[careerAccount] saveDisplayUserId error", error);
      return { kind: "error", message: error.message ?? "保存に失敗しました。" };
    }
    if (!data) {
      return { kind: "error", message: "アカウントが見つかりませんでした。" };
    }
    return { kind: "ok", account: toAccount(data) };
  } catch (err) {
    devWarn("[careerAccount] saveDisplayUserId threw", err);
    const message = err instanceof Error ? err.message : "保存に失敗しました。";
    return { kind: "error", message };
  }
}

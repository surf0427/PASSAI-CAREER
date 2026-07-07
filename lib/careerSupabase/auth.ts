"use client";

/**
 * CAREER 専用 メール OTP 認証ヘルパー（browser-only）。
 *
 * 受験版 `lib/supabase/auth.ts` と同方針だが、career 専用 browser client を使う。
 *   - ログインは **email OTP のみ**。匿名認証は発行しない。
 *   - identity は auth.users.id（= auth.uid()）。display_user_id は表示用で認証に使わない。
 *   - never throw。discriminated result を返す。
 */

import type { User } from "@supabase/supabase-js";

import { devWarn } from "@/lib/devLog";
import { getCareerBrowserSupabaseClient } from "./browserClient";

export type CareerSessionResult =
  | { kind: "no-env" }
  | { kind: "guest" }
  | { kind: "member"; userId: string; email: string | null };

/**
 * 既存セッションを「読むだけ」で解決する（新規発行はしない）。
 * - member: is_anonymous !== true の永続（メール）ユーザー。
 * - guest : セッション無し。または残存 anonymous セッション（破棄して guest 扱い）。
 */
export async function resolveCareerSession(): Promise<CareerSessionResult> {
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) {
    devWarn("[careerAuth] resolveCareerSession: no env");
    return { kind: "no-env" };
  }

  let user: User | null = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (!error && data?.user) user = data.user;
  } catch (err) {
    devWarn("[careerAuth] resolveCareerSession: getUser threw", err);
  }
  if (!user) {
    // network 一過性失敗の保険（storage 読み。新規発行はしない）。
    try {
      const { data } = await supabase.auth.getSession();
      user = data.session?.user ?? null;
    } catch (err) {
      devWarn("[careerAuth] resolveCareerSession: getSession threw", err);
    }
  }

  if (!user) return { kind: "guest" };

  if (user.is_anonymous === true) {
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch (err) {
      devWarn("[careerAuth] resolveCareerSession: local signOut of anonymous failed", err);
    }
    return { kind: "guest" };
  }

  return { kind: "member", userId: user.id, email: user.email ?? null };
}

export type CareerSendOtpResult =
  | { kind: "ok" }
  | { kind: "no-env" }
  | { kind: "error"; message: string };

/**
 * 登録メール宛に OTP コードを送る（就活版ログイン入口）。
 * - `shouldCreateUser: true`: 新規登録も同一入口で扱う。
 * - 送信前にローカルセッションを破棄（残存 session を「メール変更」と誤解釈させない）。
 * - emailRedirectTo は設定しない（マジックリンクではなく OTP コード入力に一本化）。
 */
export async function sendCareerEmailOtp(
  email: string,
): Promise<CareerSendOtpResult> {
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) {
    devWarn("[careerAuth] sendCareerEmailOtp: no env");
    return { kind: "no-env" };
  }

  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch (err) {
    devWarn("[careerAuth] sendCareerEmailOtp: local signOut before OTP failed (continuing)", err);
  }

  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) {
      devWarn("[careerAuth] sendCareerEmailOtp error", error);
      return { kind: "error", message: error.message ?? "コードの送信に失敗しました。" };
    }
    return { kind: "ok" };
  } catch (err) {
    devWarn("[careerAuth] sendCareerEmailOtp threw", err);
    const message = err instanceof Error ? err.message : "コードの送信に失敗しました。";
    return { kind: "error", message };
  }
}

export type CareerVerifyOtpResult =
  | { kind: "ok"; userId: string; email: string | null }
  | { kind: "no-env" }
  | { kind: "error"; message: string };

/**
 * メールに届いた OTP コードを検証してセッションを確立する。
 * - `verifyOtp({ email, token, type: 'email' })`。成功で career browser client が
 *   session を cookie / storage に永続化する（以降 server でも同一 user が見える）。
 */
export async function verifyCareerEmailOtp(
  email: string,
  token: string,
): Promise<CareerVerifyOtpResult> {
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) {
    devWarn("[careerAuth] verifyCareerEmailOtp: no env");
    return { kind: "no-env" };
  }

  try {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: token.trim(),
      type: "email",
    });
    if (error || !data?.user?.id) {
      devWarn("[careerAuth] verifyCareerEmailOtp error", error ?? "(no user)");
      return {
        kind: "error",
        message: error?.message ?? "コードを確認できませんでした。再度お試しください。",
      };
    }
    return { kind: "ok", userId: data.user.id, email: data.user.email ?? null };
  } catch (err) {
    devWarn("[careerAuth] verifyCareerEmailOtp threw", err);
    const message = err instanceof Error ? err.message : "コードの確認に失敗しました。";
    return { kind: "error", message };
  }
}

/**
 * ログアウト（session 破棄）。never throw。
 */
export async function signOutCareer(): Promise<void> {
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return;
  try {
    await supabase.auth.signOut();
  } catch (err) {
    devWarn("[careerAuth] signOutCareer threw", err);
  }
}

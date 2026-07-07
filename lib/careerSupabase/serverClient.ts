/**
 * CAREER 専用 server Supabase client 境界（SSR-safe）。
 *
 * - 受験版 `lib/supabase/serverClient.ts` と同形。env は career 用 boundary から解決。
 * - リクエスト毎に新規生成（cookie store をそのリクエストに束縛する）。共有しない。
 * - env 未設定なら null（呼び出し側は「未認証 / 未設定」として扱う）。
 * - `next/headers` を import する server-only module。`"use client"` から import 禁止。
 *   browser 側の counterpart は `browserClient.ts`。両者は互いを import しない。
 */

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { getCareerSupabaseAnonKey, getCareerSupabaseUrl } from "./env";
import { retryingFetch } from "@/lib/supabase/retryingFetch";

export async function getCareerServerSupabaseClient(): Promise<SupabaseClient | null> {
  const url = getCareerSupabaseUrl();
  const anonKey = getCareerSupabaseAnonKey();
  if (!url || !anonKey) return null;

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    global: { fetch: retryingFetch },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // server component から呼ばれ cookie を書けないケース。無視で安全
          // （session の更新は middleware / route handler 経路で行う）。
        }
      },
    },
  });
}

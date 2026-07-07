"use client";

/**
 * CAREER 専用 browser Supabase client 境界。
 *
 * - 受験版 `lib/supabase/browserClient.ts` と同形の boundary だが、env は
 *   `lib/careerSupabase/env.ts`（NEXT_PUBLIC_CAREER_SUPABASE_*）から解決する。
 * - Singleton。呼び出し側は毎回 `getCareerBrowserSupabaseClient()` を呼び、
 *   参照を長期保持しない（boundary が lifecycle を所有する）。
 * - env 未設定なら null。呼び出し側は null を「mirror 無効 / no-op」として扱う。
 * - `@supabase/ssr` の createBrowserClient は session を cookie（プロジェクト単位）に
 *   保持するため、同一プロジェクトを指す限り server client / 受験版 client と
 *   session を共有する。
 * - `"use client"` / browser-only からのみ import すること。
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getCareerSupabaseAnonKey, getCareerSupabaseUrl } from "./env";

let client: SupabaseClient | null | undefined;

export function getCareerBrowserSupabaseClient(): SupabaseClient | null {
  if (client !== undefined) return client;

  const url = getCareerSupabaseUrl();
  const anonKey = getCareerSupabaseAnonKey();
  if (!url || !anonKey) {
    client = null;
    return client;
  }

  client = createBrowserClient(url, anonKey);
  return client;
}

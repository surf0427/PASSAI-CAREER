/**
 * CAREER 専用 service_role client 境界（server-only）。
 *
 * - RLS を bypass する admin-scope client。就活版ログイン / onboarding の主経路では
 *   使わない（それらは user-scoped browser client で RLS auth.uid()=id を通す）。
 *   将来の server 側管理操作のために boundary だけ用意しておく。
 *
 * 安全境界（受験版 serviceRoleClient.ts と同方針）:
 *   - `import 'server-only'`: client bundle に紛れたら build error。
 *   - key は career env boundary 経由でのみ読む（CAREER_SUPABASE_SERVICE_ROLE_KEY
 *     ?? SUPABASE_SERVICE_ROLE_KEY）。実値はログ出力しない。
 *   - `typeof window !== 'undefined'` runtime guard で最終防衛。
 *   - `autoRefreshToken: false / persistSession: false`: cookie / storage に session を
 *     残さない。
 */

import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getCareerSupabaseServiceRoleKey, getCareerSupabaseUrl } from './env';
import { retryingFetch } from '@/lib/supabase/retryingFetch';

let cached: SupabaseClient | null = null;

export function getCareerServiceRoleSupabaseClient(): SupabaseClient {
  if (typeof window !== 'undefined') {
    throw new Error(
      'career service role Supabase client must never be constructed in the browser',
    );
  }

  if (cached) return cached;

  const url = getCareerSupabaseUrl();
  if (!url) {
    throw new Error('CAREER Supabase URL is not set');
  }

  const serviceRoleKey = getCareerSupabaseServiceRoleKey();
  if (!serviceRoleKey) {
    throw new Error('CAREER Supabase service role key is not set');
  }

  cached = createClient(url, serviceRoleKey, {
    global: { fetch: retryingFetch },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return cached;
}

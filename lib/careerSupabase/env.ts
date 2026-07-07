/**
 * CAREER (就活版) 専用 Supabase 環境変数アクセス境界。
 *
 * 受験版の `lib/supabase/env.ts`（NEXT_PUBLIC_SUPABASE_*）とは **別系統** の
 * boundary。就活版のログイン / career_accounts は本 module 経由でのみ env を読む。
 *
 * 読む env（CAREER 専用）:
 *   - NEXT_PUBLIC_CAREER_SUPABASE_URL
 *   - NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY
 *   - CAREER_SUPABASE_SERVICE_ROLE_KEY（server-only）
 *
 * shared env への fallback ポリシー（**本番禁止**）:
 *   - development / test（NODE_ENV !== 'production'）に限り、CAREER 専用が未設定なら
 *     shared（NEXT_PUBLIC_SUPABASE_* / SUPABASE_SERVICE_ROLE_KEY）へ **read-only・一方向**
 *     で fallback してよい（ローカル DX 用。career → shared の向きのみ）。
 *   - **production では fallback を一切許さない**。CAREER 専用が未設定なら null を返し、
 *     career client は null（= auth 無効 / mirror no-op）に倒す。受験版 / shared Supabase へは
 *     絶対に接続しない（誤接続・split-brain・データ混線の防止）。
 *   - どちらの場合も **throw しない**（build を落とさない = 受験版 env.ts と同じ契約）。
 *
 * secret hygiene:
 *   - service role key は NEXT_PUBLIC_ prefix を持たないため browser bundle には
 *     inline されない。browser では常に undefined → getCareerSupabaseServiceRoleKey()
 *     は null を返す。実際の consumer（serviceRoleClient.ts）で `import 'server-only'`。
 *   - どの実値もログ出力しない。
 */

export type CareerSupabaseEnv = {
  url: string;
  anonKey: string;
};

let cached: CareerSupabaseEnv | null | undefined;

/**
 * shared env への fallback を許可するか。
 * production では常に false（受験版 / shared への誤接続を封じる）。
 * NODE_ENV 既定（未設定）は Next.js 上ではローカル / test 実行なので fallback 可。
 */
function isSharedFallbackAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function readEnv(): CareerSupabaseEnv | null {
  const allowFallback = isSharedFallbackAllowed();

  const url =
    process.env.NEXT_PUBLIC_CAREER_SUPABASE_URL ??
    (allowFallback ? process.env.NEXT_PUBLIC_SUPABASE_URL : undefined);
  const anonKey =
    process.env.NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY ??
    (allowFallback ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY : undefined);

  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function getCareerSupabaseEnv(): CareerSupabaseEnv | null {
  if (cached === undefined) cached = readEnv();
  return cached;
}

export function getCareerSupabaseUrl(): string | null {
  return getCareerSupabaseEnv()?.url ?? null;
}

export function getCareerSupabaseAnonKey(): string | null {
  return getCareerSupabaseEnv()?.anonKey ?? null;
}

export function isCareerSupabaseEnvAvailable(): boolean {
  return getCareerSupabaseEnv() !== null;
}

/**
 * service role key reader（server-only）。
 * - 戻り値 null: 未設定、または browser bundle 経由（NEXT_PUBLIC_ prefix 無し）。
 * - production では shared（SUPABASE_SERVICE_ROLE_KEY）へ fallback しない。
 * - 唯一の consumer は `lib/careerSupabase/serviceRoleClient.ts`。
 * - env.ts と同じく本 module 自身は throw しない。
 */
export function getCareerSupabaseServiceRoleKey(): string | null {
  const allowFallback = isSharedFallbackAllowed();
  return (
    process.env.CAREER_SUPABASE_SERVICE_ROLE_KEY ??
    (allowFallback ? process.env.SUPABASE_SERVICE_ROLE_KEY : undefined) ??
    null
  );
}

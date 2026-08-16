/**
 * CAREER (就活版) 専用 Supabase 環境変数アクセス境界。
 *
 * 受験版の `lib/supabase/env.ts`（Project A の公開 env 系統）とは **完全に別系統** の
 * boundary。就活版のログイン / career_accounts / 全 career mirror は本 module 経由で
 * のみ env を読む。本 module は Project A の env 名を一切参照しない。
 *
 * 読む env（CAREER 専用）:
 *   - NEXT_PUBLIC_CAREER_SUPABASE_URL
 *   - NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY
 *   - CAREER_SUPABASE_SERVICE_ROLE_KEY（server-only）
 *
 * 受験版 env への fallback ポリシー: **全環境で禁止（fallback は存在しない）**。
 *   - Project B 完全分離（CAREER 専用 Supabase）に伴い、旧「development / test に限り
 *     受験版 env へ fallback する」DX 用の緩和は **削除**した。
 *   - 理由: fallback があると CAREER env の設定漏れが受験版 Supabase への接続で「動いて
 *     いるように見えて」しまい、identity は CAREER・data は受験版という split-brain を
 *     ローカルで再現させてしまう。設定漏れは **設定漏れとして落ちる**のが正しい。
 *   - CAREER 専用 env が未設定なら null を返し、career client は null
 *     （= auth 無効 / mirror no-op）に倒す。受験版 Supabase へは絶対に接続しない。
 *   - **throw しない**（build を落とさない = 受験版 env.ts と同じ契約）。fail-closed。
 *
 * この boundary に Project A の env 名が再混入しないことは
 * scripts/career-supabase-project-boundary-qa.ts が静的に守る。
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

function readEnv(): CareerSupabaseEnv | null {
  // ★ 直接メンバ参照のみ。computed key による dynamic lookup / 分割代入 / alias は
  //   Next.js の client bundle inline を壊す。career-supabase-env-inline-qa が静的に守る。
  const url = process.env.NEXT_PUBLIC_CAREER_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY;

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
 * - **受験版の service-role key へは fallback しない**（全環境）。
 * - consumer: `lib/careerSupabase/serviceRoleClient.ts` と
 *   `app/api/career/gd/room/roomCode.ts`（join code pepper の最終 fallback）。
 * - env.ts と同じく本 module 自身は throw しない。
 */
export function getCareerSupabaseServiceRoleKey(): string | null {
  return process.env.CAREER_SUPABASE_SERVICE_ROLE_KEY ?? null;
}

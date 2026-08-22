/**
 * PASSAI CAREER — Supabase SSR セッション更新 proxy（CAREER 名前空間限定）。
 *
 * ★ この Next.js では `middleware` file convention は deprecated で、`proxy.ts` に
 *   リネームされている（node_modules/next/dist/docs/01-app/03-api-reference/
 *   03-file-conventions/proxy.md）。関数名も `proxy` を使う。
 *
 * ── なぜ必要か ──────────────────────────────────────────────────────────
 *   `@supabase/ssr` の server client は、access token が期限切れのときに refresh token で
 *   更新した **新しい cookie を書き戻す**必要がある。ところが server component から
 *   呼ばれた場合 Next.js は cookie の書き込みを許さず、`serverClient.ts` の `setAll` は
 *   その例外を握り潰している（server component では書けないのが正しい仕様）。
 *   その結果この proxy が無い構成では:
 *
 *     access token 期限切れ + 有効な refresh token あり
 *       → server guard（/career/profile, /career/home）が getUser() に失敗
 *       → 実際にはログイン継続できるユーザーを login へ追い出す
 *       → ユーザーから見ると「勝手にログアウトされて OTP をやり直させられる」
 *
 *   Stripe Checkout の往復や、タブを開いたまま時間が経った再訪でこれが起きる。
 *   本 proxy は **request のたびに session を触って更新結果を cookie へ書き戻す**
 *   ことで、以降の server component / route handler が常に生きた session を読めるようにする
 *   （Supabase 公式の SSR パターン）。
 *
 * ── 境界 ────────────────────────────────────────────────────────────────
 *   - matcher は `/career` と `/api/career` だけに限定する。受験版（Project A）の
 *     認証には一切触れない。扱う cookie は Project B の auth cookie のみ
 *     （project ref が違うので名前空間が衝突しない）。
 *   - webhook（署名付き POST / cookie 無し）では何もしない。raw body に触れない。
 *   - **認可判定をここでしない**。redirect も 401 も返さない。ページ側の server guard
 *     （lib/careerRouting/serverState.ts）が唯一の判定者であり続ける。
 *     docs も「Proxy を完全な session 管理 / 認可の解決策として使うな」と明記している。
 *   - env 未設定・例外はすべて fail-open で素通し（proxy が CAREER 全体を
 *     落とす事故を作らない）。認証が必要な判定は下流が改めて行う。
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import {
  getCareerSupabaseAnonKey,
  getCareerSupabaseUrl,
} from '@/lib/careerSupabase/env';

/** 署名付き webhook。cookie を持たず、触る理由が無い。 */
const WEBHOOK_PATH = '/api/career/billing/webhook';

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });

  if (request.nextUrl.pathname === WEBHOOK_PATH) return response;

  const url = getCareerSupabaseUrl();
  const anonKey = getCareerSupabaseAnonKey();
  if (!url || !anonKey) return response;

  try {
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // 更新後の cookie を request（下流の server component 用）と
          // response（browser 用）の両方へ反映する（公式パターン）。
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    });

    // ★ getUser() を呼ぶこと自体が目的（必要なら refresh され setAll が走る）。
    //   戻り値は使わない。ここで分岐すると認可判定が二重化するため。
    await supabase.auth.getUser();
  } catch {
    // fail-open。session 更新に失敗しても素通しし、判定は下流の guard に委ねる。
  }

  return response;
}

export const config = {
  // CAREER 名前空間だけ。受験版 route / 静的アセットには一切かけない。
  matcher: ['/career/:path*', '/api/career/:path*'],
};

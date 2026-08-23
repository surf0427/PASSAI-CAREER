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
 * ── もう 1 つの役割: deployment の公開面の境界 ─────────────────────────
 *   この repo には受験版の app surface（/pricing・/home・/mypage・/essay・/statement・
 *   /tutor・/account・/api/billing/* …）がまるごと残っており build 成果物にも入る。
 *   だがこの deployment が販売しているのは PASSAI CAREER だけなので、
 *   **CAREER と共通ページ以外は公開 request から 404 にする**（allowlist / fail-closed）。
 *   判定表は lib/careerDeploymentSurface.ts が単独で持ち、ここでは呼ぶだけ。
 *
 *   ★ これは「別商品の画面を同じドメインに出さない」という配信面の線引きであって、
 *     ユーザーごとの認可ではない（下記の「境界」の原則は変えていない）。
 *   ★ 受験版のコードは削除しない。到達不能にするだけ。
 *
 * ── 境界 ────────────────────────────────────────────────────────────────
 *   - **Supabase session の更新は従来どおり `/career` と `/api/career` だけ**に行う。
 *     受験版（Project A）の認証には一切触れない。扱う cookie は Project B の
 *     auth cookie のみ（project ref が違うので名前空間が衝突しない）。
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
import {
  isAllowedCareerDeploymentPath,
  isApiPath,
} from '@/lib/careerDeploymentSurface';

/** 署名付き webhook。cookie を持たず、触る理由が無い。 */
const WEBHOOK_PATH = '/api/career/billing/webhook';

/** CAREER 名前空間（ここだけ Supabase session を更新する）。 */
const CAREER_PREFIXES = ['/career', '/api/career'] as const;

function isCareerNamespace(pathname: string): boolean {
  return CAREER_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
  );
}

/**
 * 公開面の外にある path への応答（＝「そんな route は無い」）。
 *
 * 403 ではなく 404 にする理由は既存の GD / 企業マッチング gate と同じ:
 * 403 だと「存在するが権限が無い」という情報を与えてしまう。
 * また CAREER Home へ redirect もしない — 別商品の URL を CAREER の画面へ
 * 吸い込むより、not found として扱うほうが境界が明確になる。
 *
 * ★ app 内へ rewrite しない（重要）。
 *   rewrite すると URL は元のまま（例 /home）なので root layout の PlanGate が
 *   `usePathname()` を見て「受験版の保護ページ」と判断し、404 の本文ではなく
 *   「確認中です…」を描画したまま止まる。ここで完結した応答を返せば、
 *   受験版の layout / AuthProvider / PlanGate は **一切起動しない**。
 */
const NOT_FOUND_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>ページが見つかりません | PASSAI CAREER</title>
<style>
  :root { color-scheme: light }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#f8fafc; color:#0f172a;
         font-family: Arial, Helvetica, sans-serif; }
  main { text-align:center; padding:2rem 1.5rem; max-width:32rem }
  p.code { margin:0 0 .5rem; font-size:.75rem; letter-spacing:.08em; color:#94a3b8 }
  h1 { margin:0 0 .75rem; font-size:1.25rem }
  p.lead { margin:0 0 1.5rem; font-size:.875rem; line-height:1.8; color:#475569 }
  a { display:inline-block; padding:.625rem 1.25rem; border-radius:.5rem;
      background:#2563eb; color:#fff; text-decoration:none; font-size:.875rem; font-weight:600 }
</style></head>
<body><main>
  <p class="code">404</p>
  <h1>ページが見つかりません</h1>
  <p class="lead">お探しのページは存在しないか、移動した可能性があります。</p>
  <a href="/">PASSAI CAREER トップへ</a>
</main></body></html>`;

function notFoundResponse(pathname: string): NextResponse {
  if (isApiPath(pathname)) {
    // 既存 CAREER gate と同じ JSON 形（client が detail を読む契約を壊さない）。
    return NextResponse.json(
      { error: 'NOT_FOUND', detail: 'ページが見つかりません。' },
      { status: 404 },
    );
  }
  return new NextResponse(NOT_FOUND_HTML, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // 既に索引されている旧 URL を検索結果から落とす。
      'x-robots-tag': 'noindex',
    },
  });
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── 0) deployment の公開面の境界（allowlist / fail-closed）──
  //    CAREER・共通法務ページ・運用 endpoint 以外は 404。受験版 surface はここで止まる。
  if (!isAllowedCareerDeploymentPath(pathname)) {
    return notFoundResponse(pathname);
  }

  const response = NextResponse.next({ request });

  if (pathname === WEBHOOK_PATH) return response;
  // session 更新は CAREER 名前空間だけ（共通法務ページ等では何もしない）。
  if (!isCareerNamespace(pathname)) return response;

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
  // ★ matcher は **静的リテラルでなければならない**（Next が build 時に解析する）。
  //   公開面の allowlist は lib/careerDeploymentSurface.ts が持つので、ここでは
  //   「判定に回すべき request」だけを絞る:
  //     - Next の内部配信物（/_next/static・/_next/image）を除外
  //     - 拡張子つきの静的ファイル（画像 / svg / ico 等）を除外
  //   それ以外はすべて proxy に入れ、allowlist に無ければ 404 にする。
  //   （denylist にすると受験版 route を 1 本足し忘れた時点で穴が開くため、
  //     ここは「素通しの例外」だけを列挙する形にしている。）
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|avif|txt|xml|webmanifest|map)$).*)',
  ],
};

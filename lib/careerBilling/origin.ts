/**
 * PASSAI CAREER — Checkout / Portal の戻り先 origin 解決（server-only の薄いラッパ）。
 *
 * Stripe に渡す success_url / cancel_url / return_url の基点。
 *
 * ★★ ここは「認証セッションの継続性」を決める箇所である ★★
 *
 *   Supabase の auth cookie は **host 単位**で保存される（Domain 属性を付けていないため
 *   本番 `passaicareer.jp` の cookie は preview の `passai-career-xxxx.vercel.app` へも、
 *   旧 deployment URL `passai-career.vercel.app` へも送られない）。
 *   したがって Stripe の戻り先 host が「決済を始めた host」と違うと、
 *
 *       決済前: authenticated（cookie あり）
 *       決済後: 別 host に着地 → cookie が付かない → 401 → 再ログイン要求
 *
 *   という事故になる。以前は `NEXT_PUBLIC_APP_URL` を **最優先**していたため、
 *   preview host で認証したユーザーが決済後に canonical host へ飛ばされ得た。
 *
 * ── 解決方針 ────────────────────────────────────────────────────────────
 *   **ユーザーが今いる host に必ず返す**。判定材料は platform（Vercel edge）が付ける
 *   `x-forwarded-host` / `host`。この値はこの request を実際に配信した host そのもので、
 *   「その browser が cookie を持っている host」と定義上一致する。
 *   client が自由に付けられる `Origin` header は採用しない（偽装可能なため）。
 *   `NEXT_PUBLIC_APP_URL` は forwarded host が読めない実行環境のための **fallback**。
 *
 * ── 安全性 ──────────────────────────────────────────────────────────────
 *   戻り先 URL は「決済完了後にその browser 自身をどこへ返すか」だけを決める。
 *   認証・権限判定には一切使わない（権利の正本は署名付き webhook → Project B →
 *   entitlement resolver）。scheme は http(s) に限定し、壊れた値は採用しない。
 *
 * 判定ロジック本体は lib/careerBilling/originPolicy.ts（純関数・unit test 可能）。
 */

import 'server-only';

import { resolveCareerOriginFromHeaders } from './originPolicy';

export function resolveCareerAppOrigin(req: Request): string | null {
  return resolveCareerOriginFromHeaders({
    forwardedHost: req.headers.get('x-forwarded-host'),
    host: req.headers.get('host'),
    forwardedProto: req.headers.get('x-forwarded-proto'),
    configuredAppUrl: process.env.NEXT_PUBLIC_APP_URL ?? null,
  });
}

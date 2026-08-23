import type { Metadata } from "next";
import "./globals.css";
import { Header } from "@/app/components/Header";
import { DevValidationStatsHook } from "@/app/components/DevValidationStatsHook";
import { AuthProvider } from "@/app/components/AuthProvider";
import { PlanGate } from "@/app/components/PlanGate";
import { BRAND_NAME } from "@/lib/brand";

// ── フォントについて（next/font を意図的に使っていない理由）─────────────────
//
// かつてここで next/font/google の Geist / Geist_Mono を読み込み、
// `--font-geist-sans` / `--font-geist-mono` を <html> に生やしていたが、
// **その CSS 変数を参照する規則が 1 つも無かった**（適用されていなかった）。
//   - 本文の書体は app/globals.css の `body { font-family: Arial, Helvetica, sans-serif }`
//   - Tailwind の `font-sans` / `font-mono` は Tailwind 既定のスタックに解決される
//     （globals.css の @theme で --font-sans / --font-mono を上書きしていない）
// つまり woff2 を 2 本 preload しながら 1 文字も描画に使っていない状態で、
//   - `<link rel=preload as=font>` の「preloaded but not used」警告
//   - 使われないフォント資産への往復リクエスト
// だけが発生していた。表示は Arial のままなので、読み込みごと外しても
// **見た目は一切変わらない**（削除前後で body の font-family は同一）。
//
// ★ 将来 Geist を本当に採用するときは、ここに戻すだけでは不十分。
//   app/globals.css の @theme で `--font-sans: var(--font-geist-sans)` のように
//   変数を実際に消費するところまでやること（でないと同じ現象が再発する）。

// 公開トップ（app/page.tsx）は PASSAI CAREER 専用 LP のため、ルート metadata も
// CAREER 基準にする。/career 配下は app/career/layout.tsx が個別に上書きする。
// 掲載する機能は実装済み route のみ、かつ **feature flag で停止しうる機能を名指ししない**
// （GD / 企業マッチングは既定 OFF。metadata は静的なので flag に追従できず、OFF のときに
//  「使える」と読める記述が検索結果・SNS プレビューへ出てしまうため常時提供分だけを書く）。
export const metadata: Metadata = {
  title: `${BRAND_NAME} CAREER`,
  description:
    "新卒就活の活動整理・自己分析・就活軸整理・企業研究・ES・面接練習・プレゼン対策をAIでサポートする就活サービスです。入力した内容は次の対策にも引き継がれます。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className="h-full antialiased scroll-smooth scroll-pt-14"
    >
      <body className="min-h-full flex flex-col">
        <AuthProvider>
          <Header />
          <DevValidationStatsHook />
          {/* pt-14 は fixed ヘッダー（h-14 = 56px）の高さ分の余白 */}
          {/* PlanGate: 未課金ユーザーを本体機能ページから /pricing へ送る認可ガード */}
          <main className="flex-1 pt-14">
            <PlanGate>{children}</PlanGate>
          </main>
        </AuthProvider>
      </body>
    </html>
  );
}

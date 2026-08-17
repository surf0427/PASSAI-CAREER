import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Header } from "@/app/components/Header";
import { DevValidationStatsHook } from "@/app/components/DevValidationStatsHook";
import { AuthProvider } from "@/app/components/AuthProvider";
import { PlanGate } from "@/app/components/PlanGate";
import { BRAND_NAME } from "@/lib/brand";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// 公開トップ（app/page.tsx）は PASSAI CAREER 専用 LP のため、ルート metadata も
// CAREER 基準にする。/career 配下は app/career/layout.tsx が個別に上書きする。
// 掲載する機能は実装済み route のみ（企業マッチングは flag 既定 OFF のため含めない）。
export const metadata: Metadata = {
  title: `${BRAND_NAME} CAREER`,
  description:
    "新卒就活の活動整理・自己分析・就活軸整理・企業研究・ES・面接練習・GD練習・プレゼン対策をAIでサポートする就活サービスです。入力した内容は次の対策にも引き継がれます。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased scroll-smooth scroll-pt-14`}
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

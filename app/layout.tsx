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

export const metadata: Metadata = {
  title: BRAND_NAME,
  description:
    "総合型選抜・学校推薦型選抜の対策を、活動整理から自己分析・志望理由書・小論文・面接までAIでサポートする受験サービスです。",
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

import type { Metadata } from 'next';

import { CareerAuthProvider } from '@/app/career/components/CareerAuthProvider';

// /career 配下専用の nested layout（server component）。
//
// 役割:
//   - metadata の就活版上書き（ルート layout の受験版 metadata を career だけ上書き）。
//   - 就活版（CAREER）専用の認証コンテキスト CareerAuthProvider で children を包む。
//     受験版の Header / AuthProvider / PlanGate / <html> はルート app/layout.tsx が持つ。
//     CareerAuthProvider は career 専用 Supabase client 上の **独立** した provider で、
//     受験版 AuthProvider には干渉しない（identity を career 側にだけ持たせる）。
//   - 受験版（総合型選抜・志望理由書・小論文 等）の語彙は入れない。新卒就活のみ。
export const metadata: Metadata = {
  title: 'PASSAI CAREER',
  description:
    '新卒就活の自己分析・ES・面接・GD・企業研究・企業マッチングをAIで横断支援するPASSAI CAREER。就活相談AIが今の現在地と次にやることを整理します。',
};

export default function CareerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <CareerAuthProvider>{children}</CareerAuthProvider>;
}

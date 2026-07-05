import type { Metadata } from 'next';

// /career 配下専用の nested layout（server component）。
//
// 役割は「metadata の就活版上書き」と children の passthrough のみ。
//   - career ページの多くは 'use client' のため、ページから metadata を export できない。
//     server layout でここに集約して、ルート layout の受験版 metadata を career だけ上書きする。
//   - Header / AuthProvider / PlanGate / <html> はルート app/layout.tsx が持つ。
//     ここでは再描画・再ラップしない（二重描画・二重 Provider を避ける）。
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
  return children;
}

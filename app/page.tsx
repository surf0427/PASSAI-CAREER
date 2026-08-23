import { HeroSection } from '@/app/components/landing/HeroSection';
import { ProblemSection } from '@/app/components/landing/ProblemSection';
import { FeatureFlowSection } from '@/app/components/landing/FeatureFlowSection';
import { FaqSection } from '@/app/components/landing/FaqSection';
import { ClosingCtaSection } from '@/app/components/landing/ClosingCtaSection';
import { FooterSection } from '@/app/components/landing/FooterSection';
// 提供可否の正本は server flag（Pricing と同じ関数・同じ意味）。UI flag は使わない。
import { isCareerGdEnabled } from '@/lib/careerGdGate/flags.server';
import { isCareerCompanyMatchingEnabled } from '@/lib/careerMatchingGate/flags.server';
import type { CareerLandingAvailability } from '@/app/components/landing/featureAvailability';

// ── PASSAI CAREER ランディングページ（LP / トップページ） ────────────
// セクション構成：
//   1. Header（グローバル Header が LP 用変種を表示。app/components/Header.tsx 参照）
//   2. First View（ヒーロー：メインコピー / サブコピー / 主 CTA）
//   3. For You / Pain Points（こんな人におすすめ：悩み → 警告 → 解決）#recommend
//   4. Feature Flow（機能の流れ：提供中のステップ + 横断機能 3 つ）#features
//   5. FAQ（よくある質問：<details> ベースの開閉式・JS なし）#faq
//   6. Closing Message + Final CTA（締めの本文 + メイン/サブ CTA）
//   7. Footer（LP 内 footer：ブランド + 法的リンク列 + コピーライト）
//      ※ 他ページに出さないため、グローバル layout ではなく LP 内に配置する。
//
// ── 掲載する機能の決め方（STEP-CAREER-LANDING-AVAILABILITY）────────────
// 掲載するのは /career 配下に実ページがあり、かつ **今この環境で提供されている**機能だけ。
// GD / 企業マッチングは server flag で提供可否が変わるため、ここで 1 回だけ解決して
// 各セクションへ渡す（client 側で hide したり NEXT_PUBLIC_* で判定したりしない）。
// これにより LP・/career/pricing・Home・page・API の availability が同じ権威から出る。
// 判定と catalog は app/components/landing/featureAvailability.ts。
//
// 料金セクション（PricingSection）は本 LP には置かない。あれは受験版の basic / premium
// 用であり、CAREER の料金は /career/pricing（¥3,000・単一プラン）が唯一の掲示面。
// LP の CTA は /career/pricing へ送るため、LP 内に価格を二重掲示しない。
// PricingSection / /pricing / Stripe 側の仕様は一切変更していない。
//
// 各セクションの実体は app/components/landing/ 配下に分離。
// 文言・デザイン・リンクの変更はそれぞれの section ファイルで行う。

// server flag を読むため静的化しない（flag を変えたら再デプロイ無しで表示が追従する）。
export const dynamic = 'force-dynamic';

export default function LandingPage() {
  // ★ 提供可否の解決は LP 全体で 1 回だけ。以降は純粋な表示データとして各セクションへ渡す。
  const availability: CareerLandingAvailability = {
    gd: isCareerGdEnabled(),
    matching: isCareerCompanyMatchingEnabled(),
  };

  return (
    <div className="bg-white text-slate-900">
      <HeroSection />
      <ProblemSection />
      <FeatureFlowSection availability={availability} />
      <FaqSection availability={availability} />
      <ClosingCtaSection />
      <FooterSection variant="career" />
    </div>
  );
}

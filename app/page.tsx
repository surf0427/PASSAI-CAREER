import { HeroSection } from '@/app/components/landing/HeroSection';
import { ProblemSection } from '@/app/components/landing/ProblemSection';
import { FeatureFlowSection } from '@/app/components/landing/FeatureFlowSection';
import { FaqSection } from '@/app/components/landing/FaqSection';
import { ClosingCtaSection } from '@/app/components/landing/ClosingCtaSection';
import { FooterSection } from '@/app/components/landing/FooterSection';

// ── PASSAI CAREER ランディングページ（LP / トップページ） ────────────
// セクション構成：
//   1. Header（グローバル Header が LP 用変種を表示。app/components/Header.tsx 参照）
//   2. First View（ヒーロー：メインコピー / サブコピー / 主 CTA）
//   3. For You / Pain Points（こんな人におすすめ：悩み → 警告 → 解決）#recommend
//   4. Feature Flow（機能の流れ：8 ステップ + 横断機能 3 つ）#features
//   5. FAQ（よくある質問：<details> ベースの開閉式・JS なし）#faq
//   6. Closing Message + Final CTA（締めの本文 + メイン/サブ CTA）
//   7. Footer（LP 内 footer：ブランド + 法的リンク列 + コピーライト）
//      ※ 他ページに出さないため、グローバル layout ではなく LP 内に配置する。
//
// 掲載する機能は /career 配下に実ページがあるものだけ（app/career/home/page.tsx の
// FEATURES と一致）。企業マッチングは flag 既定 OFF のため LP には出さない。
//
// 料金セクション（PricingSection）は本 LP には置かない。Stripe 課金（basic / premium）は
// 受験版機能の PlanGate 用であり、/career 配下は PlanGate の保護対象外＝CAREER 側に
// 課金導線が無いため、LP に価格を出すと実装と矛盾する。
// PricingSection / /pricing / Stripe 側の仕様は一切変更していない。
//
// 各セクションの実体は app/components/landing/ 配下に分離。
// 文言・デザイン・リンクの変更はそれぞれの section ファイルで行う。

export default function LandingPage() {
  return (
    <div className="bg-white text-slate-900">
      <HeroSection />
      <ProblemSection />
      <FeatureFlowSection />
      <FaqSection />
      <ClosingCtaSection />
      <FooterSection variant="career" />
    </div>
  );
}

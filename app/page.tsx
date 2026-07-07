import { HeroSection } from '@/app/components/landing/HeroSection';
import { ProblemSection } from '@/app/components/landing/ProblemSection';
import { FeatureFlowSection } from '@/app/components/landing/FeatureFlowSection';
import { PricingSection } from '@/app/components/landing/PricingSection';
import { CompareSection } from '@/app/components/landing/CompareSection';
import { FreeDiagnosisCtaSection } from '@/app/components/landing/FreeDiagnosisCtaSection';
import { FaqSection } from '@/app/components/landing/FaqSection';
import { ClosingCtaSection } from '@/app/components/landing/ClosingCtaSection';
import { FooterSection } from '@/app/components/landing/FooterSection';
import { isCareerVariantByEnv } from '@/lib/appVariant';

// ── PASSAI ランディングページ（LP / トップページ） ─────────────────
// セクション構成：
//   1. Header（グローバル Header が LP 用変種を表示。app/components/Header.tsx 参照）
//   2. First View（ヒーロー：メインコピー / サブコピー / 補足）
//   3. For You / Pain Points（こんな人におすすめ：悩み → 警告 → 解決）
//   4. Feature Flow（機能の流れ：6 ステップを番号付きカードで表示）
//   5. Pricing（料金プラン比較：2 カード + 注意書き）
//   6. Compare（他社比較：PDF 比較資料の 8 項目で「向いている人の違い」として提示）
//   7. Free Diagnosis CTA（無料受験タイプ診断への強めの CTA）
//   8. FAQ（よくある質問：<details> ベースの開閉式・JS なし）
//   9. Closing Message + Final CTA（締めの本文 + メイン/サブ CTA）
//  10. Footer（LP 内 footer：ブランド + 法的リンク列 + コピーライト）
//      ※ 他ページに出さないため、グローバル layout ではなく LP 内に配置する。
//
// 各セクションの実体は app/components/landing/ 配下に分離。
// 文言・デザイン・リンクの変更はそれぞれの section ファイルで行う。

export default function LandingPage() {
  // 就活版（CAREER）デプロイでは、受験版専用の課金（PricingSection）・受験タイプ
  // 診断（FreeDiagnosisCtaSection）セクションを非表示にする。両者は文言も CTA も
  // 100% 受験版（/pricing・Stripe・/diagnosis）で CAREER 相当が無いため、非表示に
  // することで受験版導線をトップから排除する（env は SSR 安全＝初回描画から確定）。
  const isCareer = isCareerVariantByEnv();
  return (
    <div className="bg-white text-slate-900">
      <HeroSection />
      <ProblemSection />
      <FeatureFlowSection />
      {!isCareer && <PricingSection />}
      <CompareSection />
      {/* ⑥ 無料の受験タイプ診断（無料で試せる入口・有料 CTA とは別物）。
          flag は /diagnosis 側で legacy / 9タイプを出し分ける。CAREER では非表示。 */}
      {!isCareer && <FreeDiagnosisCtaSection />}
      <FaqSection />
      <ClosingCtaSection />
      <FooterSection />
    </div>
  );
}

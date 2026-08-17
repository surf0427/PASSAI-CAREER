import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { FooterSection } from '@/app/components/landing/FooterSection';
import {
  BUSINESS_NAME,
  CONTACT_EMAIL,
  OPERATOR_NAME,
  OPERATOR_SERVICES_DESCRIPTION,
} from '@/lib/legal';

// ── /about（運営者情報） ───────────────────────────────────────
// 事業者情報は lib/legal.ts に集約し、特商法ページ等と表記を揃える。
//
// 本ページは受験版 PASSAI と就活版 PASSAI CAREER に共通の運営者情報ページで、
// 両サービスの footer から到達する。そのため片方だけの説明にはせず、事業者が
// 提供しているサービスを併記する。
// 「サービス内容」欄は OPERATOR_SERVICES_DESCRIPTION（案内用）を使う。特商法ページの
// SERVICE_DESCRIPTION（有料販売している役務の法定表示）とは意図的に別定義。

export const metadata: Metadata = {
  title: '運営者情報 | PASSAI',
  description:
    'PASSAI の運営者情報です。サービス名・事業者名・運営責任者・サービス内容・お問い合わせ先を掲載しています。',
};

export default function AboutPage() {
  return (
    <div className="bg-white">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-12 sm:py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-8 transition-colors"
        >
          ← トップに戻る
        </Link>

        <PageHeader title="運営者情報" />

        <div className="space-y-6 text-slate-700 leading-relaxed">
          <p>
            PASSAIは、AIを活用して進路・キャリアの準備を支援するサービスです。
            大学受験向けの「PASSAI」と、新卒就活向けの「PASSAI CAREER」を提供しています。
          </p>
          <p>
            PASSAI CAREERでは、活動整理・自己分析・就活軸整理・企業研究・ES作成・
            面接練習・GD練習・プレゼン対策を1つの流れで進められます。
          </p>

          <div className="space-y-5">
            <AboutRow label="サービス名">PASSAI / PASSAI CAREER</AboutRow>
            <AboutRow label="事業者名">{BUSINESS_NAME}</AboutRow>
            <AboutRow label="運営責任者">{OPERATOR_NAME}</AboutRow>
            <AboutRow label="サービス内容">
              {OPERATOR_SERVICES_DESCRIPTION}
            </AboutRow>
            <AboutRow label="お問い合わせ">
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-brand-700 hover:underline"
              >
                {CONTACT_EMAIL}
              </a>
            </AboutRow>
          </div>

          <p className="text-sm text-slate-500">
            特定商取引法に基づく表記は{' '}
            <Link href="/legal/commerce" className="text-brand-700 hover:underline">
              こちら
            </Link>{' '}
            をご覧ください。
          </p>
        </div>
      </div>

      <FooterSection />
    </div>
  );
}

function AboutRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-1 sm:gap-4 text-sm">
      <p className="font-semibold text-slate-900">{label}</p>
      <p className="text-slate-700">{children}</p>
    </div>
  );
}

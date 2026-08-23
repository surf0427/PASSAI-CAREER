/**
 * 特定商取引法に基づく表記。
 *
 * - Stripe Customer Portal 設定 / 本番審査で必要となる「特商法表記 URL」。
 *   URL は /legal/commerce で固定（移設しない）。
 * - 事業者情報・連絡先・価格は lib/legal.ts に集約し、二重管理を避ける。
 *   価格・サービス内容は lib/careerPricing.ts を single source として参照する。
 *
 * ★ この deployment が販売している役務は **PASSAI CAREER（新卒就活向け）のみ**。
 *   本ページは法定表示なので、必ずその商品・その価格と一致させること。
 *   受験版（総合型選抜・推薦入試対策 / Basic ¥2,980 / Premium ¥4,980）の
 *   内容をここへ書かない・参照しない。
 *
 * 既存の /privacy /terms と同じレイアウト (max-w-3xl / PageHeader / 戻る Link)
 * に揃える。
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/ui/PageHeader';
import { FooterSection } from '@/app/components/landing/FooterSection';
import {
  BUSINESS_NAME,
  CONTACT_EMAIL,
  DISCLOSURE_ON_REQUEST,
  OPERATOR_NAME,
  SALES_PRICE_LABEL,
  SERVICE_DESCRIPTION,
} from '@/lib/legal';

export const metadata: Metadata = {
  title: '特定商取引法に基づく表記 | PASSAI CAREER',
  description:
    'PASSAI（運営責任者 窪田 慶大）が提供する PASSAI CAREER の特定商取引法に基づく表記です。販売価格・支払方法・サービス提供時期・解約方法・返金・動作環境について記載しています。',
};

export default function CommercePage() {
  return (
    <div className="bg-white">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-12 sm:py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-8 transition-colors"
        >
          ← トップに戻る
        </Link>

        <PageHeader title="特定商取引法に基づく表記" />

        <div className="space-y-5 text-slate-700 leading-relaxed">
          <CommerceRow label="事業者名">{BUSINESS_NAME}</CommerceRow>
          <CommerceRow label="運営責任者">{OPERATOR_NAME}</CommerceRow>
          <CommerceRow label="所在地">{DISCLOSURE_ON_REQUEST}</CommerceRow>
          <CommerceRow label="電話番号">{DISCLOSURE_ON_REQUEST}</CommerceRow>
          <CommerceRow label="メールアドレス">
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-brand-700 hover:underline"
            >
              {CONTACT_EMAIL}
            </a>
          </CommerceRow>
          <CommerceRow label="サービス内容">{SERVICE_DESCRIPTION}</CommerceRow>
          <CommerceRow label="販売価格">{SALES_PRICE_LABEL}</CommerceRow>
          <CommerceRow label="商品代金以外の必要料金">
            インターネット接続に必要な通信料は利用者のご負担となります。
          </CommerceRow>
          <CommerceRow label="支払方法">
            クレジットカード決済（Stripe）
          </CommerceRow>
          <CommerceRow label="支払時期">
            初回お申し込み時、および以後毎月の更新日に自動課金されます。
          </CommerceRow>
          <CommerceRow label="サービス提供時期">
            決済完了後ただちにご利用いただけます。
          </CommerceRow>
          <CommerceRow label="解約方法">
            マイページ（/career/mypage）の「契約を管理」から Stripe カスタマーポータルへ
            進み、いつでも解約のお手続きが可能です。解約後も、お支払い済みの期間の
            末日までご利用いただけます。
          </CommerceRow>
          <CommerceRow label="返品・返金">
            サービスの性質上、購入後の返金には対応いたしかねます。
          </CommerceRow>
          <CommerceRow label="動作環境">
            Google Chrome 最新版 / Safari 最新版
          </CommerceRow>
        </div>

        <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm leading-relaxed text-amber-900">
            本サービスは生成AIを利用した就職活動サポートサービスです。採用選考の通過・
            内定その他の結果を保証するものではなく、AIが生成する添削・アドバイス等の
            出力の正確性・完全性についても保証いたしません。最終的なご判断は利用者
            ご自身の責任で行ってください。
          </p>
        </div>
      </div>

      <FooterSection />
    </div>
  );
}

function CommerceRow({
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

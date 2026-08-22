/**
 * PASSAI CAREER — Checkout をキャンセルして戻ってきたときの着地ページ。
 *
 * Stripe の cancel_url。決済は行われていないため、状態は何も変わらない。
 * blank page にせず「課金されていないこと」を明示し、公開 Pricing（/career/pricing）へ
 * 安全に戻す（AGENTS §27）。契約管理ページ（/career/billing）ではなく購入前の画面に戻す。
 * paid entitlement は当然付与しない（このページは読み取りも書き込みも行わない）。
 * 二次導線を /career/home ではなく LP にしているのは、未契約ユーザーが Home の
 * server guard で /career/billing へ弾き返されるだけの往復を避けるため。
 */

import Link from 'next/link';

import { AlertBox } from '@/components/ui/AlertBox';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';

export default function CareerBillingCancelPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
      <PageHeader title="お申し込みを中断しました" />

      <AlertBox variant="info" className="mb-4">
        お支払いはまだ完了していません。
      </AlertBox>

      <Card padding="md">
        <p className="text-sm text-slate-600 leading-relaxed">
          お申し込みは完了していません。ご契約内容はこれまでのまま変わりません。
          引き続きご利用いただけます。
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/career/pricing"
            className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
          >
            料金プランを見る
          </Link>
          <Link
            href="/"
            className="inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            トップへ戻る
          </Link>
        </div>
      </Card>
    </div>
  );
}

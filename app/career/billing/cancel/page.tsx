/**
 * PASSAI CAREER — Checkout をキャンセルして戻ってきたときの着地ページ。
 *
 * Stripe の cancel_url。決済は行われていないため、状態は何も変わらない。
 * blank page にせず「課金されていないこと」を明示し、やり直し導線を出す（AGENTS §27）。
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
        お支払いは行われていません。
      </AlertBox>

      <Card padding="md">
        <p className="text-sm text-slate-600 leading-relaxed">
          お申し込みは完了していません。ご契約内容はこれまでのまま変わりません。
          引き続きご利用いただけます。
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/career/billing"
            className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
          >
            プランを見る
          </Link>
          <Link
            href="/career/home"
            className="inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            ホームへ戻る
          </Link>
        </div>
      </Card>
    </div>
  );
}

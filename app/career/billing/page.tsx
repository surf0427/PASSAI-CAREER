/**
 * PASSAI CAREER — ご契約状態の確認 / 契約管理ページ（server component）。
 *
 * ★ 役割分離（重要）:
 *     /career/pricing  … 買う **前**。新規獲得用の公開 Pricing（¥3,000 / 月・「決済する」）。
 *     /career/billing  … 買った **後**。既存ユーザーが自分の契約状態を確認し、
 *                        マイページの「契約を管理」（Stripe Customer Portal）へ進む場所。
 *   受験版でいう「LP/#pricing・/pricing（購入前）」と「マイページの契約カード（購入後）」の
 *   分離に相当する。新規ユーザー獲得導線をこのページへ着地させないこと
 *   （未契約者に「現在お申し込みを受け付けているプランはありません」を見せてしまう）。
 *
 * ★ 契約状態の正本は server の entitlement resolver だけ（AGENTS §17）。
 *   Stripe → signed webhook → career_subscriptions → resolveCareerEntitlement の連鎖以外を
 *   根拠にしない。ここに書き込み処理は無い。
 *
 * ★ Stripe Price / Product が読めない場合はご契約内容を偽らず「表示できない」と出す。
 *   このページでの fail-closed は正しい（購入前 UI ではないので、商品説明を作らない）。
 */

import Link from 'next/link';

import { AlertBox } from '@/components/ui/AlertBox';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  getCareerPlanOffer,
  isCareerBillingConfigured,
  type CareerPlanOffer,
} from '@/lib/careerBilling/stripe';
import {
  CAREER_ROUTES,
  resolveCareerStartDestination,
} from '@/lib/careerRouting/destination';
import { resolveCareerAccessState } from '@/lib/careerRouting/serverState';

// Stripe / server session から実データを読むため、静的化・キャッシュを一切しない。
export const dynamic = 'force-dynamic';

function formatAmount(offer: CareerPlanOffer): string | null {
  if (offer.unitAmount == null) return null;
  // JPY は最小単位＝円（zero-decimal currency）。それ以外は 1/100 単位で表示する。
  const zeroDecimal = offer.currency.toLowerCase() === 'jpy';
  const value = zeroDecimal ? offer.unitAmount : offer.unitAmount / 100;
  try {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: offer.currency.toUpperCase(),
    }).format(value);
  } catch {
    return `${value} ${offer.currency.toUpperCase()}`;
  }
}

function formatInterval(offer: CareerPlanOffer): string | null {
  if (!offer.interval) return null;
  const unit =
    offer.interval === 'month'
      ? 'か月'
      : offer.interval === 'year'
        ? '年'
        : offer.interval === 'week'
          ? '週'
          : offer.interval === 'day'
            ? '日'
            : offer.interval;
  const count = offer.intervalCount ?? 1;
  return count === 1 ? `/ ${unit}` : `/ ${count}${unit}`;
}

export default async function CareerBillingPage() {
  // 契約状態（server 権威）。guest / 判定不能はいずれも「契約なし」として扱う。
  const access = await resolveCareerAccessState();
  const subscribed = access.kind === 'paid';
  // 契約者の次の一歩は共通の純関数が決める（ここで条件式を再実装しない）。
  const subscriberNext = resolveCareerStartDestination(access);
  const subscriberNextIsHome = subscriberNext === CAREER_ROUTES.home;

  // 契約中のときだけ Stripe から契約内容を引く（未契約者に商品説明を出す場所ではない）。
  let offer: CareerPlanOffer | null = null;
  let loadFailed = false;
  if (subscribed && isCareerBillingConfigured()) {
    try {
      offer = await getCareerPlanOffer();
    } catch {
      // Stripe 障害 / key 不正。契約内容を偽らず「一時的に表示できない」を出す。
      loadFailed = true;
    }
  }
  const amount = offer ? formatAmount(offer) : null;
  const interval = offer ? formatInterval(offer) : null;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
      <PageHeader
        title="ご契約"
        description="現在のご契約状態を確認できます。"
        right={
          <Link
            href="/career/mypage"
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            マイページ →
          </Link>
        }
      />

      {subscribed ? (
        <>
          <AlertBox variant="success" className="mb-6">
            ご契約は有効です。
          </AlertBox>

          <Card padding="md" className="flex flex-col max-w-md">
            <h2 className="text-xl font-bold text-slate-900">
              {/* 商品名は Stripe Product が正本。未設定なら既定ラベルで代替。 */}
              {offer?.productName ?? offer?.label ?? 'PASSAI CAREER'}
            </h2>

            {amount && (
              <p className="mt-3 text-2xl font-bold text-slate-900">
                {amount}
                {interval && (
                  <span className="ml-1 text-sm font-medium text-slate-500">
                    {interval}
                  </span>
                )}
              </p>
            )}

            {loadFailed && (
              <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                ご契約内容を取得できませんでした。時間をおいて再度お試しください。
              </p>
            )}

            <div className="mt-6 flex flex-col gap-3">
              <Link
                href={subscriberNext}
                className="inline-flex w-full justify-center items-center rounded-xl bg-brand-600 px-6 py-3 text-sm sm:text-base font-bold text-white shadow-sm hover:bg-brand-700 transition-colors"
              >
                {subscriberNextIsHome ? 'PASSAI CAREER を使う →' : '基本情報を入力する →'}
              </Link>
              <Link
                href="/career/mypage"
                className="inline-flex w-full justify-center items-center rounded-xl border border-slate-300 px-6 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                契約を管理する
              </Link>
            </div>
          </Card>
        </>
      ) : (
        <>
          <AlertBox variant="info" className="mb-6">
            現在ご契約はありません。
          </AlertBox>

          <Card padding="md" className="max-w-md">
            <p className="text-sm text-slate-600 leading-relaxed">
              PASSAI CAREER のすべての機能は、ご契約後にご利用いただけます。
              料金とご利用いただける機能は料金プランのページでご確認ください。
            </p>
            <div className="mt-5">
              {/* 購入導線は公開 Pricing に一本化する（このページには置かない）。 */}
              <Link
                href={CAREER_ROUTES.pricing}
                className="inline-flex w-full justify-center items-center rounded-xl bg-brand-600 px-6 py-3 text-sm sm:text-base font-bold text-white shadow-sm hover:bg-brand-700 transition-colors"
              >
                料金プランを見る →
              </Link>
            </div>
          </Card>
        </>
      )}

      <p className="mt-8 text-xs text-slate-500 leading-relaxed">
        お支払いは Stripe を通じて処理されます。カード情報が PASSAI CAREER
        のサーバに保存されることはありません。解約・お支払い方法の変更・領収書の取得は、
        マイページの「契約を管理」から行えます。
      </p>
    </div>
  );
}

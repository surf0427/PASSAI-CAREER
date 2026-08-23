/**
 * PASSAI CAREER — 公開 Pricing（新規ユーザー獲得導線の 1 枚目 / server component）。
 *
 * 位置づけは受験版 `/pricing`（app/pricing/page.tsx → PricingSection）と同じ:
 *   - **public**。ログインも契約も不要で閲覧できる。
 *   - 未契約ユーザーの canonical な着地先（LP の「始める」／ server guard の追い出し先）。
 *   - 購入 CTA を 1 つだけ持ち、そこから認証 → Stripe Checkout へ一直線に進む。
 *
 * ★ 契約管理ページ（/career/billing）とは役割を分離する。
 *   こちらは「買う前」。マイページ / 契約管理 / 解約 / 請求履歴 は出さない。
 *   「現在お申し込みを受け付けているプランはありません」も通常状態では出さない
 *   （Stripe env が無い Preview でも商品説明は表示する。受験版と同じ挙動）。
 *
 * ★ 金額表示と課金権威の分離（重要）:
 *     表示 … Stripe Price が読めればその実値、読めなければ表示用定数（¥3,000 / 月）
 *     課金 … 常に server が STRIPE_CAREER_PRICE_ID から解決した Stripe Price のみ
 *   client が価格・プラン・クーポン・金額を指定する経路は存在しない
 *   （POST /api/career/billing/checkout は body を読まない）。
 *   Stripe 未設定の環境で実際に Checkout を作ろうとすれば server が 503 で fail-closed。
 *
 * ★ 契約中ユーザー（paid=true）には購入 CTA を出さない（二重 Subscription の一次防御）。
 *   最終防御は checkout API の 409 ALREADY_SUBSCRIBED。
 */

import Link from 'next/link';

import { Card } from '@/components/ui/Card';
import { CareerCheckoutButton } from '@/app/career/components/CareerCheckoutButton';
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
import {
  CAREER_PRICING_DISPLAY_AMOUNT,
  CAREER_PRICING_DISPLAY_INTERVAL,
  CAREER_PRICING_PRODUCT_NAME,
  CAREER_PRICING_QUOTA_HEADING,
  CAREER_PRICING_QUOTA_NOTE,
  CAREER_PRICING_SUMMARY,
  selectAvailableCareerPricingFeatures,
} from './pricingDisplay';
// 提供可否は server flag が唯一の権威（UI flag は読まない）。本ページは server component
// なので、そのまま server-only gate を評価できる。
import { isCareerGdEnabled } from '@/lib/careerGdGate/flags.server';
import { isCareerCompanyMatchingEnabled } from '@/lib/careerMatchingGate/flags.server';
// 1 日の利用上限は quota の正本から引く（Pricing 側に数値を複製しない）。
import { getCareerDailyLimit } from '@/lib/careerQuota/limits';

// server session と Stripe を読むため静的化・キャッシュしない。
export const dynamic = 'force-dynamic';

/** Stripe Price の実値を表示文字列にする（読めなければ null → 表示用定数へフォールバック）。 */
function formatStripeAmount(offer: CareerPlanOffer): string | null {
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

function formatStripeInterval(offer: CareerPlanOffer): string | null {
  if (!offer.interval) return null;
  const unit =
    offer.interval === 'month'
      ? '月'
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

export default async function CareerPricingPage() {
  // Stripe から実価格を引ければそれを表示する（表示も実体に一致させるのが望ましい）。
  // 引けない環境（Preview / 開発 / Stripe 障害）でも Pricing UI は消さず、表示用定数で描く。
  let offer: CareerPlanOffer | null = null;
  if (isCareerBillingConfigured()) {
    try {
      offer = await getCareerPlanOffer();
    } catch {
      offer = null;
    }
  }
  const amount =
    (offer ? formatStripeAmount(offer) : null) ?? CAREER_PRICING_DISPLAY_AMOUNT;
  const interval =
    (offer ? formatStripeInterval(offer) : null) ?? CAREER_PRICING_DISPLAY_INTERVAL;
  const productName = offer?.productName ?? CAREER_PRICING_PRODUCT_NAME;

  // ★ 提供機能は **server flag から導出**する（P2-1）。
  //   flag OFF の機能は一覧に出さない = 存在しない機能を購入者に約束しない。
  //   API / page 側の実行権限も同じ server flag が持つため、表示と挙動が必ず一致する。
  const availableFeatures = selectAvailableCareerPricingFeatures({
    gd: isCareerGdEnabled(),
    matching: isCareerCompanyMatchingEnabled(),
  });

  // 契約状態（server 権威）。guest / 判定不能はいずれも「契約なし」として扱う。
  const access = await resolveCareerAccessState();
  const subscribed = access.kind === 'paid';
  // 契約者の次の一歩は共通の純関数が決める（ここで条件式を再実装しない）。
  const subscriberNext = resolveCareerStartDestination(access);
  const subscriberNextIsHome = subscriberNext === CAREER_ROUTES.home;

  return (
    <section className="bg-slate-50 border-b border-slate-200 min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-2xl px-6 sm:px-8 py-14 sm:py-20">
        <div className="text-center mb-10 sm:mb-12">
          <h1 className="text-xl sm:text-3xl font-extrabold tracking-tight mb-3">
            料金プラン
          </h1>
          <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
            {CAREER_PRICING_SUMMARY}
          </p>
        </div>

        <Card
          variant="highlight"
          padding="none"
          className="relative flex flex-col p-6 sm:p-8 max-w-md mx-auto"
        >
          {subscribed && (
            <span className="absolute -top-3 left-1/2 -translate-x-1/2 inline-flex items-center bg-emerald-600 text-white text-xs font-bold px-3 py-1 rounded-full shadow-sm whitespace-nowrap">
              ご利用中
            </span>
          )}

          <p className="text-base font-bold text-slate-900 mb-5">{productName}</p>

          <p className="flex items-end gap-1 mb-7">
            <span className="text-3xl sm:text-4xl font-extrabold leading-none text-brand-600">
              {amount}
            </span>
            <span className="text-sm text-slate-600 mb-1">{interval}</span>
          </p>

          <ul className="space-y-2 mb-7">
            {availableFeatures.map((feature) => (
              <li
                key={feature.label}
                className="flex items-start gap-2 text-sm text-slate-700 leading-relaxed"
              >
                <PricingCheck />
                <span>{feature.label}</span>
              </li>
            ))}
          </ul>

          {/* 1 日の利用上限（P2-4）。購入前に必ず見える位置に置く。
              上限値は quota の正本（lib/careerQuota/limits.ts）から引き、
              表示する機能は上の一覧と同じ availability policy に従う。 */}
          <div className="mb-7 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-bold text-slate-700 mb-2">
              {CAREER_PRICING_QUOTA_HEADING}
            </p>
            <ul className="space-y-1 mb-2">
              {availableFeatures.map((feature) => (
                <li
                  key={feature.label}
                  className="flex items-baseline justify-between gap-3 text-xs text-slate-600"
                >
                  <span>{feature.label}</span>
                  <span className="font-semibold text-slate-800 tabular-nums">
                    {getCareerDailyLimit(feature.quota)}回
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              {CAREER_PRICING_QUOTA_NOTE}
            </p>
          </div>

          {subscribed ? (
            <div className="mt-auto">
              <p className="mb-3 text-sm font-medium text-emerald-700">
                すでにご利用中です。
              </p>
              <Link
                href={subscriberNext}
                className="inline-flex w-full justify-center items-center rounded-xl bg-brand-600 px-6 py-3 text-sm sm:text-base font-bold text-white shadow-sm hover:bg-brand-700 transition-colors"
              >
                {subscriberNextIsHome ? 'PASSAI CAREER を使う →' : '基本情報を入力する →'}
              </Link>
            </div>
          ) : (
            <CareerCheckoutButton label="決済する" resumeOn="pricing" highlight />
          )}
        </Card>

        <p className="mt-8 text-xs text-slate-500 text-center leading-relaxed">
          お支払いは Stripe を通じて処理されます。カード情報が PASSAI CAREER
          のサーバに保存されることはありません。いつでも解約できます。
        </p>
      </div>
    </section>
  );
}

function PricingCheck() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="w-4 h-4 mt-0.5 shrink-0 text-brand-500"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 10l4 4 8-8" />
    </svg>
  );
}

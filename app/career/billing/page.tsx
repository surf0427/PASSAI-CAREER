/**
 * PASSAI CAREER — 料金・プラン確認ページ（server component）= 新規ユーザー導線の 1 枚目。
 *
 * LP の「始める」→ /career/start（状態解決）→ **このページ**。
 * 新規ユーザーはまずここで金額とプラン内容を確認し、「このプランで始める」から
 * メールアドレス登録 → Stripe Checkout へ進む。
 *
 * ── なぜ「料金表をコードに書いていない」のか ──────────────────────────────
 *
 *   CAREER の課金仕様は Stripe を **単一の正本**として読む:
 *     金額 / 通貨 / 請求間隔 → Stripe Price（STRIPE_CAREER_PRICE_ID）
 *     商品名 / 提供内容の説明 → Stripe Product（運用者が Dashboard で記述）
 *   client 側 hard-code を billing の権威にしない。Price env が未設定・取得失敗なら
 *   申し込み導線ごと出さない（fail-closed。「とりあえず売る」は起こらない）。
 *
 *   下の「利用できる主要機能」は **価格でも feature matrix でもない**。単一の有料プランで
 *   到達できる既存ページ（app/career/home の FEATURES と同一）の名前を並べているだけで、
 *   金額・提供条件は一切主張しない。flag で既定 OFF の機能（企業マッチング / GD）は
 *   出さない（存在しない機能を売らない）。
 *
 * ★ CAREER は **単一の有料プラン**。プラン比較・upgrade/downgrade の UI は持たない。
 *
 * ── 認証・契約との関係 ──────────────────────────────────────────────────
 *   本ページ自体はログイン不要で閲覧できる（価格を見るのにログインは要らない）。
 *     - guest が申し込むと CareerCheckoutButton が /career/register へ送り、
 *       認証後 `?checkout=1` で戻って checkout を再開する。
 *     - **既に有効な契約があるユーザーには申し込み CTA を出さない**（二重契約の防止）。
 *       契約の有無は server の entitlement resolver だけを根拠にする（AGENTS §17）。
 *       CTA を出さないのは UI 上の一次防御で、最終防御は checkout API の 409
 *       ALREADY_SUBSCRIBED（client を信用しない server 側判定）。
 */

import Link from 'next/link';

import { AlertBox } from '@/components/ui/AlertBox';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
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

// Stripe / server session から実データを読むため、静的化・キャッシュを一切しない。
export const dynamic = 'force-dynamic';

// 単一の有料プランで使える既存機能（app/career/home の FEATURES と一致させる）。
// flag 既定 OFF の企業マッチング / GD は含めない。
const PLAN_FEATURES = [
  '活動整理',
  '自己分析',
  '就活軸整理',
  '企業研究',
  'ES作成',
  '面接練習',
  'プレゼン対策',
] as const;

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
  // env 未設定なら Stripe を呼ばずに終了（getStripeClient は throw し得る）。
  let offer: CareerPlanOffer | null = null;
  let loadFailed = false;
  if (isCareerBillingConfigured()) {
    try {
      offer = await getCareerPlanOffer();
    } catch {
      // Stripe 障害 / key 不正。価格を偽らず「一時的に表示できない」を出す。
      loadFailed = true;
    }
  }
  const amount = offer ? formatAmount(offer) : null;
  const interval = offer ? formatInterval(offer) : null;

  // 契約状態（server 権威）。guest / 判定不能はいずれも「契約なし」として扱う。
  const access = await resolveCareerAccessState();
  const subscribed = access.kind === 'paid';
  // 契約者の次の一歩は共通の純関数が決める（ここで条件式を再実装しない）。
  const subscriberNext = resolveCareerStartDestination(access);
  const subscriberNextIsHome = subscriberNext === CAREER_ROUTES.home;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
      <PageHeader
        title="プラン"
        description="ご契約内容の確認とお申し込みができます。"
        right={
          <Link
            href="/career/mypage"
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            マイページ →
          </Link>
        }
      />

      {loadFailed && (
        <AlertBox variant="error" className="mb-6">
          プラン情報を取得できませんでした。時間をおいて再度お試しください。
        </AlertBox>
      )}

      {!loadFailed && !offer && (
        <AlertBox variant="info" className="mb-6">
          現在お申し込みを受け付けているプランはありません。
        </AlertBox>
      )}

      {subscribed && (
        <AlertBox variant="success" className="mb-6">
          このプランをご利用中です。追加のお申し込みは必要ありません。
        </AlertBox>
      )}

      {offer && (
        <Card padding="md" className="flex flex-col max-w-md">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-xl font-bold text-slate-900">
              {/* 商品名は Stripe Product が正本。未設定なら既定ラベルで代替。 */}
              {offer.productName ?? offer.label}
            </h2>
            {subscribed && (
              <span className="shrink-0 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                利用中
              </span>
            )}
          </div>

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

          {offer.productDescription && (
            <p className="mt-3 text-sm text-slate-600 leading-relaxed whitespace-pre-line">
              {offer.productDescription}
            </p>
          )}

          <div className="mt-5">
            <p className="text-sm font-semibold text-slate-800">利用できる主要機能</p>
            <ul className="mt-2 space-y-1.5">
              {PLAN_FEATURES.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm text-slate-700">
                  <span aria-hidden="true" className="mt-0.5 text-brand-600">
                    ✓
                  </span>
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-6">
            {subscribed ? (
              // 既契約者に申し込み CTA を出さない（二重 Subscription の防止）。
              <Link
                href={subscriberNext}
                className="inline-flex w-full justify-center items-center rounded-xl bg-brand-600 px-6 py-3 text-sm sm:text-base font-bold text-white shadow-sm hover:bg-brand-700 transition-colors"
              >
                {subscriberNextIsHome ? 'PASSAI CAREER を使う →' : '基本情報を入力する →'}
              </Link>
            ) : (
              <CareerCheckoutButton label="このプランで始める" highlight />
            )}
          </div>
        </Card>
      )}

      <p className="mt-8 text-xs text-slate-500 leading-relaxed">
        お支払いは Stripe を通じて処理されます。カード情報が PASSAI CAREER
        のサーバに保存されることはありません。解約・お支払い方法の変更・領収書の取得は、
        ご契約後にマイページの「契約を管理」から行えます。
      </p>
    </div>
  );
}

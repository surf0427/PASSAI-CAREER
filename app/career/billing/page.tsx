/**
 * PASSAI CAREER — プラン申し込みページ（server component）。
 *
 * ── なぜ「料金表をコードに書いていない」のか ──────────────────────────────
 *
 *   CAREER の料金仕様（金額 / 有料対象機能）は本 repository のどこにも存在しない。
 *     - CAREER LP（app/page.tsx）は料金セクションを意図的に置いていない
 *       （同ファイル冒頭のコメントに理由が明記されている）
 *     - docs/ にも CAREER の価格・feature matrix の記載が無い
 *     - lib/careerAi/usage.ts の CAREER_PLAN_LIMITS は
 *       「数値は設計のたたき台であり、課金実装時に確定する」と明記された草案
 *   したがって価格・提供内容を実装側で創作しない（AGENTS §11 / §19）。
 *
 *   代わりに **Stripe を単一の正本**として読む:
 *     金額 / 通貨 / 請求間隔 → Stripe Price
 *     商品名 / 提供内容の説明 → Stripe Product（運用者が Dashboard で記述）
 *   Price env が未設定なら申し込み導線ごと出さない
 *   （fail-closed。「とりあえず売る」は起こらない）。
 *
 * ★ CAREER は **単一の有料プラン**。プラン比較・upgrade/downgrade の UI は持たない。
 *
 * ── 認証との関係 ────────────────────────────────────────────────────────
 *   本ページ自体はログイン不要で閲覧できる（価格を見るのにログインは要らない）。
 *   申し込みボタンが未ログインを検知して /career/login へ送り、ログイン後に
 *   `?checkout=1` で戻って checkout を再開する（CareerCheckoutButton）。
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

// Stripe から実データを読むため、静的化・キャッシュを一切しない。
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

      {offer && (
        <Card padding="md" className="flex flex-col max-w-md">
          <h2 className="text-xl font-bold text-slate-900">
            {/* 商品名は Stripe Product が正本。未設定なら既定ラベルで代替。 */}
            {offer.productName ?? offer.label}
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

          {offer.productDescription && (
            <p className="mt-3 text-sm text-slate-600 leading-relaxed whitespace-pre-line">
              {offer.productDescription}
            </p>
          )}

          <div className="mt-6">
            <CareerCheckoutButton label="このプランを申し込む" highlight />
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

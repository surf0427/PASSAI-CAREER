'use client';

/**
 * PASSAI CAREER — プラン申し込み CTA（Checkout 起動ボタン）。
 *
 * 受験版 `app/components/landing/PricingCheckoutButton.tsx` の構造移植。
 *
 * 振る舞い:
 *   1. 未ログイン（guest）→ checkout を叩かずに /career/login へ。
 *      戻り先は `/career/billing?plan=<plan>`（sanitizeCareerRedirect が許可する
 *      CAREER 名前空間内の相対 path。外部 URL は構造上入り込めない）。
 *   2. member → POST /api/career/billing/checkout { plan } → 200 { url } で Stripe へ遷移。
 *   3. ログイン後に `?plan=<plan>` を付けて戻ってきたら checkout を 1 回だけ自動再開する
 *      （plan ごと 1 回。module スコープのガードで soft-nav の再マウントをまたぐ）。
 *   4. 409 ALREADY_SUBSCRIBED → 契約済み。マイページ（契約を管理）へ誘導する。
 *
 * ★ 送信するのは plan key のみ。priceId / userId / customerId は送らない
 *   （送っても server が無視する。identity と価格は server 側が決める）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useCareerAuth } from '@/app/career/components/CareerAuthProvider';
import type { CareerPaidPlanId } from '@/lib/careerBilling/plans';

type Props = {
  plan: CareerPaidPlanId;
  label: string;
  highlight?: boolean;
};

type CheckoutResponse = { url?: string; error?: string; detail?: string };

// checkout の auto-resume を「plan ごと 1 回」に制限する module スコープのガード。
// useRef はマウント単位なので、soft-nav の再マウントで再発火して checkout を
// 連打してしまう（受験版で実際に起きた事象）。module スコープなら跨いで保持される。
const autoResumeAttemptedPlans = new Set<string>();

export function CareerCheckoutButton({ plan, label, highlight }: Props) {
  const { status } = useCareerAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadySubscribed, setAlreadySubscribed] = useState(false);
  const autoResumedRef = useRef(false);

  const isMember = status === 'member';
  const disabled = loading || status === 'loading';

  const redirectToLogin = useCallback(() => {
    const next = `/career/billing?plan=${plan}`;
    router.push(`/career/login?redirect=${encodeURIComponent(next)}`);
  }, [plan, router]);

  const clearPlanQuery = useCallback(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('plan')) return;
    router.replace('/career/billing', { scroll: false });
  }, [router]);

  const startCheckout = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAlreadySubscribed(false);
    try {
      const res = await fetch('/api/career/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const data: CheckoutResponse = await res.json().catch(() => ({}));

      if (res.status === 409 && data.error === 'ALREADY_SUBSCRIBED') {
        setAlreadySubscribed(true);
        setLoading(false);
        clearPlanQuery();
        return;
      }
      if (res.status === 401 || res.status === 403) {
        setLoading(false);
        clearPlanQuery();
        redirectToLogin();
        return;
      }
      if (!res.ok || !data.url) {
        setError(data.detail ?? 'お申し込みを開始できませんでした。');
        setLoading(false);
        clearPlanQuery();
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('通信エラーが発生しました。時間をおいてお試しください。');
      setLoading(false);
      clearPlanQuery();
    }
  }, [clearPlanQuery, plan, redirectToLogin]);

  async function handleClick() {
    if (disabled) return;
    if (!isMember) {
      redirectToLogin();
      return;
    }
    await startCheckout();
  }

  // ログイン後 `?plan=<plan>` で戻ってきたら 1 回だけ自動再開する。
  useEffect(() => {
    if (autoResumedRef.current) return;
    if (!isMember) return;
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('plan') !== plan) return;
    if (autoResumeAttemptedPlans.has(plan)) return;
    autoResumeAttemptedPlans.add(plan);
    autoResumedRef.current = true;
    const id = window.setTimeout(() => {
      void startCheckout();
    }, 0);
    return () => window.clearTimeout(id);
  }, [isMember, plan, startCheckout]);

  return (
    <div className="mt-auto">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={`inline-flex w-full justify-center items-center font-bold text-sm sm:text-base px-6 py-3 rounded-xl shadow-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
          highlight
            ? 'bg-accent-600 hover:bg-accent-700 text-white'
            : 'bg-brand-600 hover:bg-brand-700 text-white'
        }`}
      >
        {loading
          ? '読み込み中…'
          : status === 'loading'
            ? 'ログイン状態を確認中…'
            : label}
      </button>
      {alreadySubscribed && (
        <p className="mt-2 text-xs text-slate-600 leading-relaxed">
          既にご契約中です。
          <Link
            href="/career/mypage"
            className="ml-1 font-medium text-brand-600 hover:text-brand-700 underline-offset-2 hover:underline"
          >
            契約の管理はマイページから →
          </Link>
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-600 leading-relaxed">{error}</p>
      )}
    </div>
  );
}

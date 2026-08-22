'use client';

/**
 * PASSAI CAREER — プラン申し込み CTA（Checkout 起動ボタン）。
 *
 * 受験版 `app/components/landing/PricingCheckoutButton.tsx` の構造移植。
 *
 * ★ CAREER は単一の有料プラン。プラン選択 UI は存在しない。
 *
 * 振る舞い:
 *   1. 未ログイン（guest）→ checkout を叩かずに **新規登録**（/career/register）へ。
 *      料金を見た人がここで押す = まだアカウントが無い前提なので、既存ユーザー向けの
 *      ログイン画面ではなく「メールアドレスを登録」へ送る（既にアカウントがある人は
 *      登録画面からログインへ渡るリンクがある。認証基盤は同じ email OTP で 1 つだけ）。
 *      戻り先は `/career/billing?checkout=1`（sanitizeCareerRedirect が許可する
 *      CAREER 名前空間内の相対 path。外部 URL は構造上入り込めない）。
 *   2. member → POST /api/career/billing/checkout → 200 { url } で Stripe へ遷移。
 *   3. ログイン後に `?checkout=1` を付けて戻ってきたら checkout を 1 回だけ自動再開する
 *      （module スコープのガードで soft-nav の再マウントをまたぐ）。
 *   4. 409 ALREADY_SUBSCRIBED → 契約済み。マイページ（契約を管理）へ誘導する。
 *
 * ★ body は送らない。plan / priceId / userId / customerId のいずれも client からは
 *   渡さない（identity と価格は server 側だけが決める）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useCareerAuth } from '@/app/career/components/CareerAuthProvider';
import { CAREER_ROUTES } from '@/lib/careerRouting/destination';

type Props = {
  label: string;
  highlight?: boolean;
};

type CheckoutResponse = { url?: string; error?: string; detail?: string };

/** 認証後の checkout 自動再開を示す query key（値は '1' 固定）。 */
const CHECKOUT_RESUME_PARAM = 'checkout';

// checkout の auto-resume を 1 回に制限する module スコープのガード。
// useRef はマウント単位なので、soft-nav の再マウントで再発火して checkout を
// 連打してしまう（受験版で実際に起きた事象）。module スコープなら跨いで保持される。
let autoResumeAttempted = false;

export function CareerCheckoutButton({ label, highlight }: Props) {
  const { status } = useCareerAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadySubscribed, setAlreadySubscribed] = useState(false);
  const autoResumedRef = useRef(false);

  const isMember = status === 'member';
  const disabled = loading || status === 'loading';

  const redirectToRegister = useCallback(() => {
    const next = `/career/billing?${CHECKOUT_RESUME_PARAM}=1`;
    router.push(`${CAREER_ROUTES.register}?redirect=${encodeURIComponent(next)}`);
  }, [router]);

  const clearResumeQuery = useCallback(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has(CHECKOUT_RESUME_PARAM)) return;
    router.replace('/career/billing', { scroll: false });
  }, [router]);

  const startCheckout = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAlreadySubscribed(false);
    try {
      // ★ body は送らない（server が単一 Price を env から解決する）。
      const res = await fetch('/api/career/billing/checkout', { method: 'POST' });
      const data: CheckoutResponse = await res.json().catch(() => ({}));

      if (res.status === 409 && data.error === 'ALREADY_SUBSCRIBED') {
        setAlreadySubscribed(true);
        setLoading(false);
        clearResumeQuery();
        return;
      }
      if (res.status === 401 || res.status === 403) {
        setLoading(false);
        clearResumeQuery();
        redirectToRegister();
        return;
      }
      if (!res.ok || !data.url) {
        setError(data.detail ?? 'お申し込みを開始できませんでした。');
        setLoading(false);
        clearResumeQuery();
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('通信エラーが発生しました。時間をおいてお試しください。');
      setLoading(false);
      clearResumeQuery();
    }
  }, [clearResumeQuery, redirectToRegister]);

  async function handleClick() {
    if (disabled) return;
    if (!isMember) {
      redirectToRegister();
      return;
    }
    await startCheckout();
  }

  // 認証後 `?checkout=1` で戻ってきたら 1 回だけ自動再開する。
  useEffect(() => {
    if (autoResumedRef.current) return;
    if (!isMember) return;
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get(CHECKOUT_RESUME_PARAM) !== '1') return;
    if (autoResumeAttempted) return;
    autoResumeAttempted = true;
    autoResumedRef.current = true;
    const id = window.setTimeout(() => {
      void startCheckout();
    }, 0);
    return () => window.clearTimeout(id);
  }, [isMember, startCheckout]);

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

'use client';

/**
 * PASSAI CAREER — マイページの契約カード。
 *
 * 受験版 `app/mypage/BillingCard.tsx` の構造移植だが、データソースが違う:
 *   受験版: profile.plan（denormalized cache）+ browser から subscriptions を直接 SELECT
 *   CAREER: GET /api/career/billing/status（server が career_subscriptions から導出）
 *
 *   理由: CAREER は課金テーブルに authenticated の GRANT を与えていない
 *   （supabase/career_billing_apply.sql §4）。ブラウザから直接読めないので、
 *   権利判定と同じ server 経路をそのまま表示にも使う。
 *   結果として「表示は paid だが server は free」という乖離が構造的に起きない。
 *
 * 表示分岐:
 *   guest / loading       → 何も描画しない（ログイン導線は CareerLoginStatusCard が持つ）
 *   課金未設定 / 取得不可  → 何も描画しない（存在しない機能の UI を出さない）
 *   free                  → 「プランを見る」導線
 *   paid                  → プラン名 + status バッジ + 次回更新日 / 解約予定日 + 「契約を管理」
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { Card } from '@/components/ui/Card';
import { useCareerAuth } from '@/app/career/components/CareerAuthProvider';

type StatusResponse = {
  plan: 'free' | 'basic' | 'premium';
  paid: boolean;
  subscription: {
    plan: string;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
};

type LoadState =
  | { kind: 'loading' }
  /** 未ログイン / 課金未配線 / 取得失敗。カードごと出さない。 */
  | { kind: 'hidden' }
  | { kind: 'ok'; data: StatusResponse };

export default function CareerBillingCard() {
  const { status: authStatus } = useCareerAuth();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  // member のときだけ取得する。member でない間は fetch も setState も行わず、
  // 描画側で null を返す（effect 内の同期 setState による cascading render を避ける）。
  useEffect(() => {
    if (authStatus !== 'member') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/career/billing/status', {
          cache: 'no-store',
        });
        if (cancelled) return;
        if (!res.ok) {
          // 401/403（session 切れ）も 503（課金未配線 / DB 未適用）も、
          // 「契約状態を断定できない」ので何も出さない（誤表示より無表示）。
          setState({ kind: 'hidden' });
          return;
        }
        const data = (await res.json()) as StatusResponse;
        if (cancelled) return;
        setState({ kind: 'ok', data });
      } catch {
        if (!cancelled) setState({ kind: 'hidden' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authStatus]);

  // guest / loading、および取得未完了・取得不可のときは何も描画しない。
  // （ログイン導線は CareerLoginStatusCard が持つ。誤表示より無表示を選ぶ。）
  if (authStatus !== 'member' || state.kind !== 'ok') return null;

  const { data } = state;

  if (!data.paid) {
    return (
      <Card padding="md">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-slate-500">現在のプラン</p>
            <p className="mt-1 text-xl font-bold text-slate-700">Free</p>
          </div>
          <Link
            href="/career/billing"
            className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
          >
            プランを見る
          </Link>
        </div>
      </Card>
    );
  }

  const sub = data.subscription;

  async function openPortal() {
    if (portalLoading) return;
    setPortalLoading(true);
    setPortalError(null);
    try {
      // ★ body を送らない。customer は server が session から解決する。
      const res = await fetch('/api/career/billing/portal', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
        detail?: string;
      };
      if (res.ok && body.url) {
        window.location.href = body.url;
        return;
      }
      setPortalError(body.detail ?? '請求情報ページを開けませんでした。');
      setPortalLoading(false);
    } catch {
      setPortalError('通信エラーが発生しました。');
      setPortalLoading(false);
    }
  }

  return (
    <Card padding="md">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-slate-500">現在のプラン</p>
          <p className="mt-1 text-xl font-bold text-slate-900">
            {planLabel(data.plan)}
          </p>
        </div>
        {sub && <StatusBadge status={sub.status} />}
      </div>

      {sub?.currentPeriodEnd && (
        <p className="mt-3 text-xs text-slate-600">
          {sub.cancelAtPeriodEnd ? (
            <>
              <span className="font-medium text-amber-700">解約予定日</span>:{' '}
              {formatDate(sub.currentPeriodEnd)}
              <span className="ml-1 text-slate-500">
                （この日まで利用できます）
              </span>
            </>
          ) : (
            <>次回更新日: {formatDate(sub.currentPeriodEnd)}</>
          )}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={openPortal}
          disabled={portalLoading}
          className="inline-flex w-full sm:w-auto justify-center items-center rounded-xl bg-slate-800 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {portalLoading ? '読み込み中…' : '契約を管理'}
        </button>
        {portalError && (
          <p className="text-xs text-red-600 leading-relaxed">{portalError}</p>
        )}
        <p className="text-xs text-slate-500 leading-relaxed">
          Stripe の請求情報ページに移動します。解約・お支払い方法の変更・領収書の取得が行えます。
        </p>
      </div>
    </Card>
  );
}

function planLabel(plan: StatusResponse['plan']): string {
  if (plan === 'basic') return 'Basic';
  if (plan === 'premium') return 'Premium';
  return 'Free';
}

function StatusBadge({ status }: { status: string }) {
  const meta = statusMeta(status);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

function statusMeta(status: string): { label: string; className: string } {
  switch (status) {
    case 'active':
      return { label: '利用中', className: 'bg-emerald-100 text-emerald-800' };
    case 'trialing':
      return { label: 'トライアル中', className: 'bg-blue-100 text-blue-800' };
    case 'past_due':
      return { label: '支払い確認中', className: 'bg-amber-100 text-amber-800' };
    case 'canceled':
      return { label: '解約済み', className: 'bg-slate-200 text-slate-700' };
    case 'unpaid':
      return { label: '未払い', className: 'bg-red-100 text-red-800' };
    case 'incomplete':
    case 'incomplete_expired':
      return { label: '手続き中', className: 'bg-slate-200 text-slate-700' };
    case 'paused':
      return { label: '一時停止', className: 'bg-slate-200 text-slate-700' };
    default:
      return { label: status, className: 'bg-slate-200 text-slate-700' };
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

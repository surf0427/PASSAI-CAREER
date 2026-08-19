'use client';

/**
 * PASSAI CAREER — Checkout 完了後の着地ページ。
 *
 * ★ 最重要（AGENTS §6 / §26）:
 *   **このページに到達したことを根拠に権利を与えない。**
 *   success_url は Stripe が付ける単なる redirect 先で、URL を直接開くだけで誰でも
 *   到達できる。権利の正本はあくまで
 *     Stripe → 署名付き webhook → career_subscriptions → entitlement resolver
 *   の連鎖であり、本ページは GET /api/career/billing/status を **ポーリングして
 *   その結果を表示するだけ**。ここに書き込み処理は一切無い。
 *
 * 表示遷移:
 *   決済処理を確認しています…（webhook 同期待ち）
 *     → 反映済み（paid=true）        : ご契約ありがとうございます + CAREER へ戻る導線
 *     → 一定時間反映されない          : 「反映に時間がかかっています」+ マイページ導線
 *     → 未ログイン / エラー           : 説明とログイン導線（blank page にしない）
 *
 * webhook は数秒で届くのが通常だが、遅延しても課金自体は成立している。よって
 * タイムアウト時も「失敗」とは言わず、マイページで確認できる旨を案内する。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import { AlertBox } from '@/components/ui/AlertBox';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';

type Phase = 'checking' | 'active' | 'pending' | 'unauthenticated' | 'error';

// webhook 同期待ちのポーリング設定。2 秒間隔 × 15 回 = 最大約 30 秒。
const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 15;

export default function CareerBillingSuccessPage() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [planLabel, setPlanLabel] = useState<string | null>(null);
  const attemptsRef = useRef(0);
  const cancelledRef = useRef(false);

  const poll = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/career/billing/status', {
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) {
        setPhase('unauthenticated');
        return true; // 停止（ログインし直しが必要）
      }
      if (!res.ok) return false; // 503 等は一時的とみなして再試行
      const data = (await res.json().catch(() => ({}))) as {
        plan?: string;
        paid?: boolean;
      };
      if (data.paid === true) {
        setPlanLabel(data.plan ?? null);
        setPhase('active');
        return true;
      }
      return false;
    } catch {
      return false; // 通信エラーも再試行対象
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    let timer: number | undefined;

    const tick = async () => {
      if (cancelledRef.current) return;
      const done = await poll();
      if (cancelledRef.current || done) return;

      attemptsRef.current += 1;
      if (attemptsRef.current >= MAX_ATTEMPTS) {
        setPhase('pending');
        return;
      }
      timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelledRef.current = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [poll]);

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
      <PageHeader title="お支払い手続き" />

      {phase === 'checking' && (
        <Card padding="md">
          <p className="text-base font-semibold text-slate-900">
            決済処理を確認しています…
          </p>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">
            お支払いは完了しています。ご契約内容の反映を確認中です。この画面を開いたまま
            少しお待ちください。
          </p>
        </Card>
      )}

      {phase === 'active' && (
        <>
          <AlertBox variant="success" className="mb-4">
            ご契約が有効になりました。
            {planLabel && <> 現在のプラン: {planLabel}</>}
          </AlertBox>
          <Card padding="md">
            <p className="text-sm text-slate-600 leading-relaxed">
              ありがとうございます。引き続き PASSAI CAREER をご利用いただけます。
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                href="/career/home"
                className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
              >
                ホームへ戻る
              </Link>
              <Link
                href="/career/mypage"
                className="inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                契約内容を確認する
              </Link>
            </div>
          </Card>
        </>
      )}

      {phase === 'pending' && (
        <>
          <AlertBox variant="info" className="mb-4">
            ご契約の反映に時間がかかっています。
          </AlertBox>
          <Card padding="md">
            <p className="text-sm text-slate-600 leading-relaxed">
              お支払い自体は完了しています。反映まで数分かかる場合があります。
              しばらくしてからマイページでご契約状態をご確認ください。
              反映されない場合はサポートまでお問い合わせください。
            </p>
            <div className="mt-4">
              <Link
                href="/career/mypage"
                className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
              >
                マイページへ
              </Link>
            </div>
          </Card>
        </>
      )}

      {phase === 'unauthenticated' && (
        <Card padding="md">
          <p className="text-base font-semibold text-slate-900">
            ログイン状態を確認できませんでした
          </p>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">
            お支払いは完了しています。同じメールアドレスでログインし直すと、ご契約状態を
            確認できます。
          </p>
          <div className="mt-4">
            <Link
              href="/career/login?redirect=%2Fcareer%2Fmypage"
              className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
            >
              メールでログイン
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}

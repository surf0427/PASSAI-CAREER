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
 *   お支払いを確認しています…（webhook 同期待ち）
 *     → 反映済み（paid=true）        : ご契約完了 → **基本情報入力**（未完了なら）or Home へ自動遷移
 *     → 一定時間反映されない          : 「反映に時間がかかっています」+ マイページ導線
 *     → 未ログイン / エラー           : 説明とログイン導線（blank page にしない）
 *
 * webhook は数秒で届くのが通常だが、遅延しても課金自体は成立している。よって
 * タイムアウト時も「失敗」とは言わず、マイページで確認できる旨を案内する。
 * 逆に、反映前（paid=false）を「支払い失敗」とも判定しない（redirect と webhook 処理は
 * 前後し得る）。ポーリングは有限（下記 MAX_ATTEMPTS）で、永久 poll はしない。
 *
 * ★ 次に進む先（基本情報 / Home）は lib/careerRouting/destination.ts の純関数が決める。
 *   ここで参照する localStorage は「基本情報を入力済みか」という **UX 上の分岐**だけで、
 *   権利判定には一切使わない。遷移先の /career/profile も /career/home も server 側で
 *   改めて entitlement を検証するため、client 状態で有料機能を突破することはできない。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { AlertBox } from '@/components/ui/AlertBox';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import {
  CAREER_ROUTES,
  isCareerBasicInfoComplete,
  resolveCareerStartDestination,
} from '@/lib/careerRouting/destination';

type Phase = 'checking' | 'active' | 'pending' | 'unauthenticated' | 'error';

// webhook 同期待ちのポーリング設定。2 秒間隔 × 15 回 = 最大約 30 秒。
const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 15;

/**
 * 401/403 を「未ログイン確定」と見なすまでの猶予回数。
 *
 * Stripe から戻った直後は、browser 側の Supabase client が session を読み直している
 * 最中だったり、access token の refresh が middleware 側で進行中だったりする。
 * その一瞬の 401 で「ログインし直してください」を出すと、決済に成功したユーザーへ
 * OTP 再入力を要求することになる（実際に本番で発生した事故の再発防止）。
 * 数回リトライしてもなお 401 のときだけ、復旧用 UI へ落とす。
 */
const AUTH_RETRY_BEFORE_GIVING_UP = 3;

// 反映確認できてから自動遷移するまでの間（完了メッセージを読める程度の短い待ち）。
const ADVANCE_DELAY_MS = 1200;

export default function CareerBillingSuccessPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('checking');
  const [planLabel, setPlanLabel] = useState<string | null>(null);
  // 反映後の遷移先（基本情報 未完了 → /career/profile ／ 完了 → /career/home）。
  const [nextPath, setNextPath] = useState<string>(CAREER_ROUTES.basicInfo);
  const attemptsRef = useRef(0);
  const cancelledRef = useRef(false);
  // 連続した 401/403 の回数（session 復元待ちと本当の未ログインを区別する）。
  const authFailuresRef = useRef(0);

  const poll = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/career/billing/status', {
        cache: 'no-store',
        // 同一 origin への fetch。cookie は既定で送られるが、Stripe からの復帰直後で
        // あることを踏まえ明示しておく（戻り先 host は決済を始めた host と同一）。
        credentials: 'same-origin',
      });
      if (res.status === 401 || res.status === 403) {
        // ★ 即断しない。session 復元 / token refresh 中の一過性 401 を吸収する。
        authFailuresRef.current += 1;
        if (authFailuresRef.current <= AUTH_RETRY_BEFORE_GIVING_UP) return false;
        setPhase('unauthenticated');
        return true; // 停止（ログインし直しが必要）
      }
      // 認証が通ったら失敗カウンタを戻す（後続の一過性失敗に猶予を残す）。
      authFailuresRef.current = 0;
      if (!res.ok) return false; // 503 等は一時的とみなして再試行
      // status API の schema は { paid, subscription: { plan, ... } | null }。
      // plan は subscription の中にあり、top-level には無い。
      const data = (await res.json().catch(() => ({}))) as {
        paid?: boolean;
        subscription?: { plan?: string } | null;
      };
      if (data.paid === true) {
        setPlanLabel(data.subscription?.plan ?? null);
        // server が paid と認めた **後** に限り、次の入力ステップを決める。
        setNextPath(
          resolveCareerStartDestination({
            kind: 'paid',
            basicInfoComplete: isCareerBasicInfoComplete(loadBasicInfo()),
          }),
        );
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

  // 反映確認後は基本情報入力（未完了なら）／Home へ自動で進む。
  // 手動リンクも併置してあるので、遷移が走らなくても行き止まりにならない。
  useEffect(() => {
    if (phase !== 'active') return;
    const id = window.setTimeout(() => router.replace(nextPath), ADVANCE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [phase, nextPath, router]);

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
      <PageHeader title="お支払い手続き" />

      {phase === 'checking' && (
        <Card padding="md">
          <p className="text-base font-semibold text-slate-900">
            お支払いを確認しています…
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
              ありがとうございます。
              {nextPath === CAREER_ROUTES.basicInfo
                ? '続けて基本情報の入力へ進みます…'
                : 'PASSAI CAREER へ戻ります…'}
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                href={nextPath}
                className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
              >
                {nextPath === CAREER_ROUTES.basicInfo
                  ? '基本情報を入力する'
                  : 'ホームへ戻る'}
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
            決済は確認できていますが、ログイン状態の復元が必要です
          </p>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">
            お支払いは完了しています。ご契約は決済時のアカウントに紐づいているため、
            <span className="font-medium">お支払いに使ったのと同じメールアドレス</span>
            でログインし直すと、そのままご利用いただけます。
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

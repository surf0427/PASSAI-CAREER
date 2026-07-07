'use client';

// 就活版マイページ等・履歴/クラウド同期が重要な画面に出すログイン状態カード。
//   - guest : ログイン導線（メールログインへ）。
//   - member: 表示名（display_user_id / email）とログアウト導線。
//     display_user_id 未設定なら設定導線を出す。
//   - loading / env 未設定（guest 扱い）でも UI を壊さない。

import { useState } from 'react';
import Link from 'next/link';

import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useCareerAuth } from '@/app/career/components/CareerAuthProvider';

export default function CareerLoginStatusCard({
  redirect = '/career/mypage',
}: {
  redirect?: string;
}) {
  const { status, user, account, signOut } = useCareerAuth();
  const [signingOut, setSigningOut] = useState(false);

  if (status === 'loading') {
    return (
      <Card padding="md">
        <p className="text-sm text-slate-400">ログイン状態を確認しています…</p>
      </Card>
    );
  }

  if (status === 'guest') {
    return (
      <Card padding="md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">
              ログインすると履歴をクラウドに保存できます
            </p>
            <p className="text-sm text-slate-600 mt-0.5">
              別の端末でも同じアカウントで履歴・進捗に戻れます。ログインしなくても、この端末での利用はそのまま続けられます。
            </p>
          </div>
          <Link
            href={`/career/login?redirect=${encodeURIComponent(redirect)}`}
            className="shrink-0 inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
          >
            メールでログイン
          </Link>
        </div>
      </Card>
    );
  }

  // member
  const displayName = account?.displayUserId ?? user?.email ?? 'ログイン中';
  return (
    <Card padding="md">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">ログイン中</p>
          <p className="text-base font-semibold text-slate-900">{displayName}</p>
          {!account?.displayUserId && (
            <Link
              href={`/career/onboarding/profile?redirect=${encodeURIComponent(redirect)}`}
              className="text-sm font-medium text-brand-600 hover:text-brand-700 underline-offset-2 hover:underline"
            >
              表示用IDを設定する →
            </Link>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            setSigningOut(true);
            await signOut();
            setSigningOut(false);
          }}
          disabled={signingOut}
        >
          {signingOut ? 'ログアウト中…' : 'ログアウト'}
        </Button>
      </div>
    </Card>
  );
}

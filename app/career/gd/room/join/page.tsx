'use client';

// PASSAI 就活版 — GD Phase2 マルチGD 合言葉参加画面（STEP-GD-12）。
// 6桁参加コードを入力して waiting ルームに参加し、ロビーへ遷移する。

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { useAuthStatus, useIsMember } from '@/app/components/AuthProvider';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import type { CareerGdRoomJoinResponse } from '@/types/careerGd';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerGdRoomJoinPage() {
  const router = useRouter();
  const authStatus = useAuthStatus();
  const isMember = useIsMember();

  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );
  const displayName = useMemo(
    () => (isMounted ? loadBasicInfo()?.name?.trim() || '参加者' : '参加者'),
    [isMounted],
  );

  const canSubmit = /^[0-9]{6}$/.test(code) && !loading;

  async function handleJoin() {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/career/gd/room/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ joinCode: code, displayName }),
      });
      const data = (await res.json().catch(() => null)) as
        | (CareerGdRoomJoinResponse & { error?: string; detail?: string })
        | null;
      if (!res.ok || !data?.roomId) {
        throw new Error(data?.detail ?? '参加に失敗しました。');
      }
      router.push(`/career/gd/room/${data.roomId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '参加に失敗しました。');
      setLoading(false);
    }
  }

  if (!isMounted || authStatus === 'loading') {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <PageHeader title="合言葉で参加" description="" />
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      </div>
    );
  }

  if (!isMember) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <PageHeader title="合言葉で参加" description="友達が作ったマルチGDルームに6桁コードで参加します。" />
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm font-bold text-slate-800 mb-2">ログインが必要です</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            マルチGDへの参加にはログイン（メール登録）が必要です。1人で練習するソロGDはログインなしで利用できます。
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              href={`/login?next=${encodeURIComponent('/career/gd/room/join')}`}
              className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              ログインする →
            </Link>
            <BackLink />
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="合言葉で参加" description="ホストから共有された6桁の参加コードを入力してください。" />

      <Card variant="soft" padding="lg" className="mb-5">
        <label htmlFor="gd-join-code" className="block text-sm font-bold text-slate-800 mb-3">
          参加コード（6桁）
        </label>
        <input
          id="gd-join-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
          placeholder="000000"
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-center text-3xl font-black tracking-[0.4em] text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
        />
        <p className="mt-2 text-xs text-slate-500">数字のみ・空白やハイフンは自動で除去されます。</p>

        {error && (
          <p className="mt-4 text-sm text-red-600 leading-relaxed" role="alert">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-col sm:flex-row gap-3">
          <Button variant="primary" size="md" onClick={handleJoin} disabled={!canSubmit} className="w-full sm:w-auto">
            {loading ? '参加中…' : '参加する →'}
          </Button>
          <BackLink />
        </div>
      </Card>

      <p className="text-xs text-slate-400 leading-relaxed">
        ルームを作る側の方は「ルームを作成」から6桁コードを発行できます。コードの有効期限は作成から30分です。
      </p>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/career/gd"
      className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
    >
      ← GDトップに戻る
    </Link>
  );
}

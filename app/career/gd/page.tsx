'use client';

// PASSAI 就活版 — GD（グループディスカッション）ハブ画面。
// 現在地（進行中セッション・完了件数）を表示し、setup / view へ導線を出す。
// Phase1 はソロGD のみ。マルチGD は「近日公開」表示にとどめる。

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { getInProgressGdSession, loadGdResults } from './gdStorage';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

type Status = {
  profileReady: boolean;
  resultCount: number;
  hasInProgress: boolean;
};

export default function CareerGdEntryPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const status = useMemo<Status | null>(() => {
    if (!isMounted) return null;
    return {
      profileReady: !!loadBasicInfo(),
      resultCount: loadGdResults().length,
      hasInProgress: !!getInProgressGdSession(),
    };
  }, [isMounted]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="GD練習（グループディスカッション）"
        description="AI参加者とグループディスカッションを実施し、企業選考目線の個別フィードバックを受け取れます。"
      />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">現在地</p>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <StatusItem label="基本情報" value={displayReady(status?.profileReady)} />
          <StatusItem label="練習履歴" value={displayCount(status?.resultCount)} />
        </div>
      </Card>

      {status?.hasInProgress && (
        <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
          <p className="text-[11px] font-bold text-amber-700 tracking-widest mb-2">中断中</p>
          <p className="text-sm font-bold text-slate-800 mb-1">進行中のGDがあります</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">
            前回のディスカッションを続きから再開できます。
          </p>
          <Link
            href="/career/gd/session"
            className="inline-flex w-full sm:w-auto items-center justify-center rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-amber-600"
          >
            続きから再開する →
          </Link>
        </Card>
      )}

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">次におすすめ</p>
        <p className="text-sm font-bold text-slate-800 mb-1">ソロGDを始める</p>
        <p className="text-xs text-slate-500 leading-relaxed mb-3">
          あなた1人 + AI参加者で、テーマ・役割を決めてグループディスカッションを練習します。
        </p>
        <Link
          href="/career/gd/setup"
          className="inline-flex w-full sm:w-auto items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
        >
          ソロGDを始める →
        </Link>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <ModeCard
          title="ソロGD（1人 + AI）"
          description="AI参加者とテキストベースで練習し、企業評価つきのフィードバックを受け取ります。"
          href="/career/gd/setup"
        />
        <ModeCard
          title="過去のGD結果を見る"
          description="実施したGDの議論ログ・個別フィードバック・企業評価を確認できます。"
          href="/career/gd/view"
        />
      </div>

      {/* マルチGD（Phase2 合言葉参加型）。ルーム作成は利用可。参加(join)は STEP-GD-12 で公開。 */}
      <div className="mt-4">
        <Card variant="soft" padding="md">
          <h2 className="text-sm font-bold text-slate-800 mb-1">合言葉で友達とGD練習（マルチGD）</h2>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">
            ルームを作って6桁の合言葉を発行し、友達に共有して複数人でGDを練習します。不足人数はAIが補完します（ログインが必要）。
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <Link
              href="/career/gd/room/create"
              className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-indigo-700"
            >
              ルームを作成 →
            </Link>
            <Link
              href="/career/gd/room/join"
              className="inline-flex items-center justify-center rounded-xl bg-white px-5 py-2.5 text-sm font-bold text-indigo-700 ring-1 ring-indigo-200 shadow-sm transition-colors hover:bg-indigo-50"
            >
              合言葉で参加 →
            </Link>
          </div>
        </Card>
      </div>

      <div className="mt-8">
        <Link
          href="/career/home"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← ホームに戻る
        </Link>
      </div>
    </div>
  );
}

const EM_DASH = '—';

function displayReady(ready: boolean | undefined): string {
  if (ready === undefined) return EM_DASH;
  return ready ? 'あり' : EM_DASH;
}

function displayCount(count: number | undefined): string {
  if (!count) return EM_DASH;
  return `${count}件`;
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500 mb-0.5">{label}</p>
      <p className="text-sm font-semibold truncate text-slate-800">{value}</p>
    </div>
  );
}

const CARD_BASE =
  'block w-full text-left rounded-2xl bg-white ring-1 ring-slate-200 shadow-card transition-all p-4 sm:p-5 min-h-[110px] hover:shadow-md active:bg-slate-50';

function ModeCard({ title, description, href }: { title: string; description: string; href: string }) {
  return (
    <Link href={href} className={CARD_BASE}>
      <h2 className="text-sm sm:text-base font-bold mb-1.5 leading-snug text-slate-900">{title}</h2>
      <p className="text-xs leading-relaxed text-slate-500">{description}</p>
    </Link>
  );
}

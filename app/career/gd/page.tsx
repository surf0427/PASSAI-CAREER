'use client';

// PASSAI 就活版 — GD（グループディスカッション）ハブ画面。
// 就活生視点の 5 メニュー導線（STEP-GD-30 UX 改善）:
//   ① ソロプレイ         → /career/gd/run（AIメンバーとGD練習）
//   ② GD部屋を作る（マルチ）→ /career/gd/rooms/create（公開GD部屋を作成して募集）
//   ③ GD部屋に入る（マルチ）→ /career/gd/rooms（募集中の公開GD部屋へ参加）
//   ④ 友達とプレイ        → /career/gd/friends（合言葉で友達とGD）
//   ⑤ 結果を見る          → /career/gd/view（過去のGD結果・評価）
// ランダムマッチ（/career/gd/lobby）は温存するが前面には出さない（UX 方針）。
// solo は careerGdResults、multi は careerGdRoomLogs で分離管理（混ぜない）。

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

// 就活生視点の 5 メニュー（表示順は仕様どおり固定）。
const MENUS: { emoji: string; title: string; description: string; href: string; accent: string }[] = [
  {
    emoji: '🧑‍💻',
    title: 'ソロプレイ',
    description: 'AIメンバーとGD練習を行います。ログインなしで今すぐ始められます。',
    href: '/career/gd/run',
    accent: 'text-blue-700',
  },
  {
    emoji: '📣',
    title: 'GD部屋を作る',
    description: '公開GD部屋を作成して参加者を募集します（ログインが必要）。',
    href: '/career/gd/rooms/create',
    accent: 'text-teal-700',
  },
  {
    emoji: '🚪',
    title: 'GD部屋に入る',
    description: '現在募集中の公開GD部屋へ参加します（ログインが必要）。',
    href: '/career/gd/rooms',
    accent: 'text-indigo-700',
  },
  {
    emoji: '🤝',
    title: '友達とプレイ',
    description: '合言葉を使って友達とGDを行います（ログインが必要）。',
    href: '/career/gd/friends',
    accent: 'text-violet-700',
  },
  {
    emoji: '📊',
    title: '結果を見る',
    description: '過去のGD結果や評価を確認します。',
    href: '/career/gd/view',
    accent: 'text-slate-700',
  },
];

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
        description="やりたいことを選んでください。AIメンバーとの1人練習も、他の就活生や友達との本番形式も選べます。"
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

      {/* ── 5 メニュー ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        {MENUS.map((m) => (
          <MenuCard key={m.href} {...m} />
        ))}
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
  'block w-full text-left rounded-2xl bg-white ring-1 ring-slate-200 shadow-card transition-all p-4 sm:p-5 min-h-[128px] hover:shadow-md active:bg-slate-50';

function MenuCard({
  emoji,
  title,
  description,
  href,
  accent,
}: {
  emoji: string;
  title: string;
  description: string;
  href: string;
  accent: string;
}) {
  return (
    <Link href={href} className={CARD_BASE}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xl leading-none" aria-hidden>
          {emoji}
        </span>
        <h2 className={`text-sm sm:text-base font-bold leading-snug ${accent}`}>{title}</h2>
      </div>
      <p className="text-xs leading-relaxed text-slate-500">{description}</p>
    </Link>
  );
}

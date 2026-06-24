'use client';

// PASSAI 就活版 — ES（エントリーシート）作成 ハブ画面
//
// 現在地（入力データの有無 / 生成済み件数）を表示し、実行画面・結果画面へ導線を出す。
// DB / 課金 / usage には接続しない（localStorage のみ）。

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData } from '@/app/career/activity/activityStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadEsLogs } from './esStorage';
import type { ActivityData } from '@/types/activity';

// マウント前 false / マウント後 true（hub と同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

type Status = {
  profileReady: boolean;
  activityReady: boolean;
  selfAnalysisReady: boolean;
  esLogCount: number;
};

function hasAnyActivity(activity: ActivityData | null): boolean {
  if (!activity) return false;
  return Object.values(activity).some((v) => Array.isArray(v) && v.length > 0);
}

export default function CareerEsEntryPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const status = useMemo<Status | null>(() => {
    if (!isMounted) return null;
    return {
      profileReady: !!loadBasicInfo(),
      activityReady: hasAnyActivity(loadActivityData()),
      selfAnalysisReady: loadSelfAnalysisLogs().length > 0,
      esLogCount: loadEsLogs().length,
    };
  }, [isMounted]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="ES（エントリーシート）作成"
        description="基本情報・活動整理・自己分析をもとに、ESのドラフトを生成します。"
      />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">現在地</p>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <StatusItem label="基本情報" value={displayReady(status?.profileReady)} />
          <StatusItem label="活動整理" value={displayReady(status?.activityReady)} />
          <StatusItem label="自己分析" value={displayReady(status?.selfAnalysisReady)} />
          <StatusItem label="生成済みES" value={displayCount(status?.esLogCount)} />
        </div>
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">次におすすめ</p>
        <p className="text-sm font-bold text-slate-800 mb-1">ESのドラフトを作る</p>
        <p className="text-xs text-slate-500 leading-relaxed mb-3">
          ガクチカ・自己PR・志望動機などを、登録済みのデータからまとめて下書きします。
        </p>
        <Link
          href="/career/es/run"
          className="inline-flex w-full sm:w-auto items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
        >
          ESを作成する →
        </Link>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <ModeCard
          title="ESを作成する"
          description="基本情報・活動整理・自己分析からESドラフトを生成します。"
          href="/career/es/run"
        />
        <ModeCard
          title="過去の結果を見る"
          description="生成済みESの結果を一覧から確認できます。"
          href="/career/es/result"
        />
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

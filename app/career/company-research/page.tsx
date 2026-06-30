'use client';

// PASSAI 就活版 — 企業研究 ハブ画面
//
// 現在地（入力データの有無 / 保存済み件数）を表示し、入力画面（do）・一覧画面（view）へ導線を出す。
// 本機能は「AIが企業情報を生成する」のではなく、ユーザー自身の企業研究メモをAIが添削する機能。
// DB / 課金 / usage には接続しない（localStorage のみ）。

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import {
  loadActivityData,
  hasAnyActivity,
} from '@/app/career/activity/activityStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadCompanyResearchLogs } from './companyResearchStorage';

// マウント前 false / マウント後 true（hub と同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

type Status = {
  profileReady: boolean;
  activityReady: boolean;
  selfAnalysisReady: boolean;
  logCount: number;
};

export default function CareerCompanyResearchEntryPage() {
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
      logCount: loadCompanyResearchLogs().length,
    };
  }, [isMounted]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="企業研究"
        description="自分で調べた企業研究メモをAIが添削します。不足や思い込みを指摘し、あなたの情報とのすり合わせまで行います。"
      />

      {/* 役割の明示（AIが企業情報を作るのではなく、本人の研究を添削する）。 */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">この機能の使い方</p>
        <p className="text-sm text-slate-700 leading-relaxed">
          AIが企業情報を代わりに調べるのではなく、<strong>あなたが調べた内容</strong>を家庭教師のように添削します。
          企業研究は自分で進め、AIには「不足している観点」「根拠が足りない箇所」「次に調べるべきこと」を指摘してもらいましょう。
        </p>
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">現在地</p>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <StatusItem label="基本情報" value={displayReady(status?.profileReady)} />
          <StatusItem label="活動整理" value={displayReady(status?.activityReady)} />
          <StatusItem label="自己分析" value={displayReady(status?.selfAnalysisReady)} />
          <StatusItem label="保存済み企業研究" value={displayCount(status?.logCount)} />
        </div>
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">次におすすめ</p>
        <p className="text-sm font-bold text-slate-800 mb-1">企業研究メモを添削してもらう</p>
        <p className="text-xs text-slate-500 leading-relaxed mb-3">
          事業内容・強み・競合・求める人物像など、調べた内容を入力するとAIが添削します。
        </p>
        <Link
          href="/career/company-research/do"
          className="inline-flex w-full sm:w-auto items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
        >
          企業研究を添削する →
        </Link>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <ModeCard
          title="企業研究を添削する"
          description="調べた企業研究メモを入力し、AIの添削を受けます。"
          href="/career/company-research/do"
        />
        <ModeCard
          title="保存した企業研究を見る"
          description="添削済みの企業研究を一覧から確認できます。"
          href="/career/company-research/view"
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

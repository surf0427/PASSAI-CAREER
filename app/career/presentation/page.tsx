'use client';

// PASSAI 就活版 — プレゼン対策AI ハブ画面（お題ベース）。
// 「お題を設定して発表 → AIが評価」が一目で分かる導線に寄せる。
// 他機能（自己分析・ES 等）の連携は主役にしない（readiness グリッドは置かない）。

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  getInProgressPresentationSession,
  loadPresentationResults,
} from './presentationStorage';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

type Status = {
  resultCount: number;
  hasInProgress: boolean;
};

export default function CareerPresentationEntryPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const status = useMemo<Status | null>(() => {
    if (!isMounted) return null;
    return {
      resultCount: loadPresentationResults().length,
      hasInProgress: !!getInProgressPresentationSession(),
    };
  }, [isMounted]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="お題プレゼン対策（AIプレゼン）"
        description="就活・選考で出される「お題」に対して発表し、AIが評価します。お題を設定して発表するだけ。発表後の質疑応答も練習できます。"
      />

      {/* 使い方（お題→発表→評価） */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">使い方</p>
        <ol className="flex flex-col sm:flex-row gap-2 sm:gap-3">
          <Step n={1} label="お題を設定" hint="自分で入力 or AIに作ってもらう" />
          <Step n={2} label="発表する" hint="音声 or テキストで練習" />
          <Step n={3} label="AIが評価" hint="構成・説得力・話し方など" />
        </ol>
      </Card>

      {status?.hasInProgress && (
        <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
          <p className="text-[11px] font-bold text-amber-700 tracking-widest mb-2">中断中</p>
          <p className="text-sm font-bold text-slate-800 mb-1">進行中のプレゼンがあります</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">
            前回のプレゼンを続きから再開できます。
          </p>
          <Link
            href="/career/presentation/session"
            className="inline-flex w-full sm:w-auto items-center justify-center rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-amber-600"
          >
            続きから再開する →
          </Link>
        </Card>
      )}

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">次におすすめ</p>
        <p className="text-sm font-bold text-slate-800 mb-1">お題プレゼンを始める</p>
        <p className="text-xs text-slate-500 leading-relaxed mb-3">
          お題と発表時間を決めて、発表を録音（またはテキスト入力）し、AIの評価を受けます。
        </p>
        <Link
          href="/career/presentation/setup"
          className="inline-flex w-full sm:w-auto items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
        >
          お題を設定して始める →
        </Link>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <NavCard
          title="お題プレゼンを始める"
          description="お題・発表時間を決めて、AIプレゼン練習を始めます。"
          href="/career/presentation/setup"
        />
        <NavCard
          title="過去の結果を見る"
          description={
            status?.resultCount
              ? `練習履歴 ${status.resultCount}件。評価を一覧から確認できます。`
              : '練習したプレゼンの評価を一覧から確認できます。'
          }
          href="/career/presentation/result"
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

function Step({ n, label, hint }: { n: number; label: string; hint: string }) {
  return (
    <li className="flex-1 rounded-xl bg-white ring-1 ring-slate-200 p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
          {n}
        </span>
        <span className="text-sm font-bold text-slate-900">{label}</span>
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed pl-8">{hint}</p>
    </li>
  );
}

const CARD_BASE =
  'block w-full text-left rounded-2xl bg-white ring-1 ring-slate-200 shadow-card transition-all p-4 sm:p-5 min-h-[110px] hover:shadow-md active:bg-slate-50';

function NavCard({ title, description, href }: { title: string; description: string; href: string }) {
  return (
    <Link href={href} className={CARD_BASE}>
      <h2 className="text-sm sm:text-base font-bold mb-1.5 leading-snug text-slate-900">{title}</h2>
      <p className="text-xs leading-relaxed text-slate-500">{description}</p>
    </Link>
  );
}

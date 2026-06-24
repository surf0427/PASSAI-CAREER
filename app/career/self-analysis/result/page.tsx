'use client';

// PASSAI 就活版 — 自己分析AI 結果画面（最小版・簡易表示）
//
// careerSelfAnalysisLogs（localStorage）から最新の結果を読み、各セクションを表示する。
// DB / 課金 / usage には接続しない。

import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadSelfAnalysisLogs } from '../selfAnalysisStorage';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

// マウント前 false / マウント後 true（hub と同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerSelfAnalysisResultPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // null = hydration 前 / 未読込。読み込み後は配列。
  const logs = useMemo<CareerSelfAnalysisLog[] | null>(
    () => (isMounted ? loadSelfAnalysisLogs() : null),
    [isMounted],
  );

  // 最新（appendSelfAnalysisLog が先頭に積む）。
  const latest = logs && logs.length > 0 ? logs[0] : null;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="自己分析の結果"
        description="直近の自己分析AIの出力です。"
      />

      {logs === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : !latest ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            まだ自己分析の結果がありません。実行画面から生成してください。
          </p>
          <Link
            href="/career/self-analysis/run"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            自己分析を実行する →
          </Link>
        </Card>
      ) : (
        <>
          <p className="text-xs text-slate-400 mb-4">
            生成日時: {formatDate(latest.createdAt)}
            {logs.length > 1 && `（保存済み ${logs.length} 件中の最新）`}
          </p>

          <Section title="全体所感">
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
              {latest.result.summary || '—'}
            </p>
          </Section>

          <ListSection title="強み" items={latest.result.strengths} />
          <ListSection title="弱み・伸びしろ" items={latest.result.weaknesses} />
          <ListSection title="ガクチカ候補" items={latest.result.gakuchikaIdeas} />
          <ListSection title="自己PR候補" items={latest.result.selfPrIdeas} />
          <ListSection title="ESで使える経験の切り口" items={latest.result.esAngles} />
          <ListSection title="面接で深掘りされそうな点" items={latest.result.interviewQuestions} />
          <ListSection title="次にやるべきこと" items={latest.result.nextActions} />
        </>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/self-analysis/run"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
        >
          もう一度実行する →
        </Link>
        <Link
          href="/career/self-analysis"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← 自己分析トップに戻る
        </Link>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP');
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card variant="soft" padding="md" className="mb-4">
      <h2 className="text-sm font-bold text-slate-900 mb-2">{title}</h2>
      {children}
    </Card>
  );
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  return (
    <Section title={title}>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">—</p>
      ) : (
        <ul className="list-disc pl-5 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="text-sm text-slate-700 leading-relaxed">
              {item}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

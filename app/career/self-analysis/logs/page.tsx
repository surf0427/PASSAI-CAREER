'use client';

// PASSAI 就活版 — 自己分析ログ一覧（「過去の結果を見る」の入口）
//
// 流れ: 自己分析ログ一覧 → 1 件選択 → 「自己分析結果を見る」→ /result?log=<rootId>
//
// ★ ここに並ぶのは「自己分析ログ」単位（= lineage）。更新（revision）は 1 件として
//   数えず、各ログの最新結果だけを代表として表示する（logEntries.ts）。
// ★ read-only。保存・再生成・削除は行わない。

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadSelfAnalysisLogs } from '../selfAnalysisStorage';
import {
  buildSelfAnalysisEntries,
  entrySummaryLabel,
  type SelfAnalysisEntry,
} from '../logEntries';

// マウント前 false / マウント後 true（他の自己分析画面と同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerSelfAnalysisLogsPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // null = hydration 前 / 未読込。
  const entries = useMemo<SelfAnalysisEntry[] | null>(
    () => (isMounted ? buildSelfAnalysisEntries(loadSelfAnalysisLogs()) : null),
    [isMounted],
  );

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="過去の自己分析"
        description="見たい自己分析を選んでください。"
      />

      {entries === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : entries.length === 0 ? (
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
        <ul className="space-y-3">
          {entries.map((entry) => (
            <li key={entry.rootId}>
              <Link
                href={`/career/self-analysis/result?log=${encodeURIComponent(entry.rootId)}`}
                className="block rounded-2xl bg-white ring-1 ring-slate-200 shadow-card p-4 sm:p-5 transition-all hover:shadow-md active:bg-slate-50"
              >
                <p className="text-xs font-semibold text-slate-700">
                  作成日時: {formatDate(entry.createdAt)}
                </p>
                {entry.updatedAt && (
                  <p className="mt-0.5 text-xs text-slate-500">
                    最終更新: {formatDate(entry.updatedAt)}
                  </p>
                )}
                <p className="mt-2 text-sm text-slate-700 leading-relaxed line-clamp-3">
                  {entrySummaryLabel(entry)}
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-blue-600">
                  自己分析結果を見る →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/self-analysis/run"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
        >
          新しく自己分析する →
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

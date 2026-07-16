'use client';

// PASSAI 就活版 — ES ログ一覧（③ 添削結果を見る / ④ 改善する 共通の入口）
//
// （設問＋企業）ごとにまとめた最新版を一覧表示する。1 行 = 1 グループの最新版。
//   表示: 設問 / 企業名 / 作成日時 / 最新点数 / 最新版番号
// クリックで当該グループの最新版 [id] エディタ／詳細へ遷移する。
// DB / 課金 / usage には接続しない（localStorage のみ）。

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadEsGroupsLatest } from '../esStorage';
import type { CareerEsLog } from '@/types/careerEs';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerEsHistoryPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const groups = useMemo<CareerEsLog[] | null>(
    () => (isMounted ? loadEsGroupsLatest() : null),
    [isMounted],
  );

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="ESの履歴"
        description="保存済みのESを設問・企業ごとに表示します。選ぶと本文・添削の確認や改善（書き直し）ができます。"
      />

      {groups === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : groups.length === 0 ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            まだ保存されたESがありません。まずは書いてみましょう。
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/career/es/new?mode=deep"
              className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 transition-colors"
            >
              ① 深掘りしながら書く →
            </Link>
            <Link
              href="/career/es/new?mode=write"
              className="inline-flex items-center justify-center rounded-lg border border-blue-300 bg-white px-4 py-2 text-sm font-bold text-blue-700 hover:bg-blue-50 transition-colors"
            >
              ② 自力で書く →
            </Link>
          </div>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((log) => (
            <li key={log.id}>
              <Link
                href={`/career/es/${encodeURIComponent(log.id)}`}
                className="block rounded-2xl bg-white ring-1 ring-slate-200 shadow-card p-4 sm:p-5 hover:shadow-md active:bg-slate-50 transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 leading-snug break-words">
                      {log.question?.trim() || '（設問未設定のES）'}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {log.companyName?.trim() || '企業未指定'}
                      {log.jobType?.trim() ? ` ・ ${log.jobType.trim()}` : ''} ・ {formatDate(log.createdAt)}
                    </p>
                    <p className="mt-1 text-[11px] font-semibold text-slate-400">
                      {creationMethodLabel(log)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <ScoreBadge score={log.review?.overallScore} />
                    <p className="mt-1 text-[11px] text-slate-400">
                      最新 v{log.version ?? 1}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8">
        <Link
          href="/career/es"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← ESトップに戻る
        </Link>
      </div>
    </div>
  );
}

// 作成方法ラベル（spec ③: 深掘り／自力／改善版）。改善版（v2 以降）を優先し、
// v1 は作成モード（deep=深掘り / write=自力）で表す。旧ログ（mode 欠損）は「記録」。
function creationMethodLabel(log: CareerEsLog): string {
  if ((log.version ?? 1) > 1) return '改善版';
  if (log.mode === 'deep') return '深掘りしながら書く';
  if (log.mode === 'write') return '自力で書く';
  return '記録';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP');
}

// 最新点数のバッジ。未添削（review 無し）は「未添削」を薄く表示する。
function ScoreBadge({ score }: { score: number | undefined }) {
  if (typeof score !== 'number') {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-500">
        未添削
      </span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-0.5 rounded-full bg-blue-50 px-2.5 py-1 text-blue-700">
      <span className="text-base font-bold leading-none">{score}</span>
      <span className="text-[11px] font-semibold">点</span>
    </span>
  );
}

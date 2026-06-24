'use client';

// PASSAI 就活版 — ES作成 結果画面（最小版）
//
// careerEsLogs（localStorage）から結果を読み、一覧（日時）＋選択中の詳細を表示する。
// 既定では最新（先頭）を選択。DB / 課金 / usage には接続しない。

import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadEsLogs } from '../esStorage';
import type { CareerEsLog } from '@/types/careerEs';

// マウント前 false / マウント後 true（hub と同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerEsResultPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // null = hydration 前 / 未読込。読み込み後は配列（最新が先頭）。
  const logs = useMemo<CareerEsLog[] | null>(
    () => (isMounted ? loadEsLogs() : null),
    [isMounted],
  );

  // 選択中の ID。未選択（null）なら最新（先頭）を表示する。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo<CareerEsLog | null>(() => {
    if (!logs || logs.length === 0) return null;
    return logs.find((l) => l.id === selectedId) ?? logs[0];
  }, [logs, selectedId]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="ESの結果" description="生成済みのESドラフトです。" />

      {logs === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : logs.length === 0 ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            まだESの結果がありません。実行画面から生成してください。
          </p>
          <Link
            href="/career/es/run"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            ESを作成する →
          </Link>
        </Card>
      ) : (
        <>
          {/* 生成済み一覧（日時）。クリックで詳細を切替。 */}
          <Card variant="soft" padding="md" className="mb-5">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
              生成済み（{logs.length}件）
            </p>
            <ul className="flex flex-col gap-2">
              {logs.map((log) => {
                const active = selected?.id === log.id;
                return (
                  <li key={log.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(log.id)}
                      className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors ${
                        active
                          ? 'bg-blue-600 text-white'
                          : 'bg-white ring-1 ring-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="font-semibold">{formatDate(log.createdAt)}</span>
                      {log.result.headline && (
                        <span className={active ? 'text-blue-100' : 'text-slate-400'}>
                          {' '}
                          — {log.result.headline}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {selected && (
            <>
              <p className="text-xs text-slate-400 mb-4">
                生成日時: {formatDate(selected.createdAt)}
              </p>

              <TextSection title="キャッチコピー" body={selected.result.headline} />
              <TextSection title="ガクチカ" body={selected.result.gakuchika} />
              <TextSection title="自己PR" body={selected.result.selfPr} />
              <TextSection title="志望動機" body={selected.result.motivation} />
              <ListSection title="企業へのアピールポイント" items={selected.result.appealPoints} />
              <ListSection title="面接で深掘りされそうな点" items={selected.result.interviewQuestions} />
              <ListSection title="改善点" items={selected.result.improvements} />
            </>
          )}
        </>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/es/run"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
        >
          もう一度作成する →
        </Link>
        <Link
          href="/career/es"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← ESトップに戻る
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

function TextSection({ title, body }: { title: string; body: string }) {
  return (
    <Section title={title}>
      {body ? (
        <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{body}</p>
      ) : (
        <p className="text-sm text-slate-400">—</p>
      )}
    </Section>
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

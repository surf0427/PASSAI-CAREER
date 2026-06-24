'use client';

// PASSAI 就活版 — 企業マッチングAI 結果画面。
// careerMatchingResults（localStorage）から一覧（日時）＋選択中の詳細を表示する。
// スコア・根拠（なぜ向いているのか）・業界・職種・次のアクションを可視化する。

import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadMatchingLogs } from '../matchingStorage';
import type { CareerMatchingLog, CareerCompanyMatch } from '@/types/careerMatching';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerMatchingResultPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const logs = useMemo<CareerMatchingLog[] | null>(
    () => (isMounted ? loadMatchingLogs() : null),
    [isMounted],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo<CareerMatchingLog | null>(() => {
    if (!logs || logs.length === 0) return null;
    return logs.find((l) => l.id === selectedId) ?? logs[0];
  }, [logs, selectedId]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="企業マッチングの結果" description="企業との相性と、その根拠です。" />

      {logs === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : logs.length === 0 ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            まだマッチング結果がありません。開始画面から実行してください。
          </p>
          <Link
            href="/career/matching"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            マッチングを開始する →
          </Link>
        </Card>
      ) : (
        <>
          <Card variant="soft" padding="md" className="mb-5">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
              マッチング履歴（{logs.length}件）
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
                      {log.result.careerType && (
                        <span className={active ? 'text-blue-100' : 'text-slate-400'}>
                          {' '}
                          — {log.result.careerType}
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
                実施日時: {formatDate(selected.createdAt)}
              </p>

              <Section title="あなたの総括">
                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {selected.result.profileSummary || '—'}
                </p>
                {selected.result.careerType && (
                  <p className="mt-2 inline-block rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">
                    タイプ: {selected.result.careerType}
                  </p>
                )}
              </Section>

              <ChipSection title="向いている業界" items={selected.result.recommendedIndustries} />
              <ChipSection title="向いている職種" items={selected.result.recommendedJobs} />

              {/* 企業マッチング（スコア + 根拠） */}
              <Card variant="soft" padding="md" className="mb-4">
                <h2 className="text-sm font-bold text-slate-900 mb-3">
                  企業マッチング（{selected.result.companyMatches.length}社）
                </h2>
                {selected.result.companyMatches.length === 0 ? (
                  <p className="text-sm text-slate-400">—</p>
                ) : (
                  <div className="flex flex-col gap-4">
                    {selected.result.companyMatches.map((c, i) => (
                      <CompanyCard key={i} company={c} />
                    ))}
                  </div>
                )}
              </Card>

              <ListSection title="伸ばすべき領域" items={selected.result.developmentAreas} />
              <ListSection title="次の一歩" items={selected.result.nextSteps} />
            </>
          )}
        </>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/matching"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
        >
          もう一度マッチングする →
        </Link>
        <Link
          href="/career/home"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← ホームに戻る
        </Link>
      </div>
    </div>
  );
}

function CompanyCard({ company }: { company: CareerCompanyMatch }) {
  return (
    <div className="rounded-xl ring-1 ring-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-sm font-bold text-slate-900">{company.company}</h3>
        <span className="shrink-0 text-sm font-bold text-blue-700">{company.score}</span>
      </div>
      {/* スコアバー */}
      <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden mb-3">
        <div
          className="h-full bg-blue-600"
          style={{ width: `${Math.min(100, Math.max(0, company.score))}%` }}
        />
      </div>
      <MiniList title="なぜ向いているのか" items={company.matchReasons} accent />
      <MiniList title="活きる強み" items={company.strengthsUsed} />
      <MiniList title="見極めの留意点" items={company.attentionPoints} />
      <MiniList title="次のアクション" items={company.nextActions} />
    </div>
  );
}

function MiniList({
  title,
  items,
  accent,
}: {
  title: string;
  items: string[];
  accent?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className={`text-[11px] font-bold mb-1 ${accent ? 'text-blue-700' : 'text-slate-500'}`}>
        {title}
      </p>
      <ul className="list-disc pl-5 space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-slate-700 leading-relaxed">
            {item}
          </li>
        ))}
      </ul>
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

function ChipSection({ title, items }: { title: string; items: string[] }) {
  return (
    <Section title={title}>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">—</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map((item, i) => (
            <span
              key={i}
              className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
            >
              {item}
            </span>
          ))}
        </div>
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

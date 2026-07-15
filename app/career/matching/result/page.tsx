'use client';

// PASSAI 就活版 — 企業マッチングAI 結果画面。
// careerMatchingResults（localStorage）から履歴 + 選択中の詳細を表示する。
// 表示はサーバ（決定的エンジン）が返した CompanyScore を描画するだけ。UI で計算はしない。

import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadMatchingLogs } from '../matchingStorage';
import type { CareerMatchingLog } from '@/types/careerMatching';
import type {
  CompanyScore,
  ScoreBreakdown,
  Confidence,
  SignalSource,
} from '@/lib/careerMatching';

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

  const isNew =
    !!selected &&
    !!selected.result &&
    typeof (selected.result as { schemaVersion?: unknown }).schemaVersion === 'number';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="企業マッチングの結果" description="企業との相性・選考準備度・活躍可能性と、その根拠です。" />

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
                      {log.result?.careerType && (
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

          {selected && !isNew && (
            <Card variant="soft" padding="md" className="mb-5">
              <p className="text-sm text-amber-700 leading-relaxed">
                この結果は古い形式で保存されています。最新のスコア（選考準備度・活躍可能性・不足能力）で見るには、
                もう一度マッチングを実行してください。
              </p>
            </Card>
          )}

          {selected && isNew && (
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

              <Card variant="soft" padding="md" className="mb-4">
                <h2 className="text-sm font-bold text-slate-900 mb-1">
                  企業マッチング（{selected.result.companies.length}社）
                </h2>
                <p className="text-[11px] text-slate-400 mb-3">{selected.result.readinessDisclaimer}</p>
                {selected.result.companies.length === 0 ? (
                  <p className="text-sm text-slate-400">—</p>
                ) : (
                  <div className="flex flex-col gap-4">
                    {selected.result.companies.map((c, i) => (
                      <CompanyCard key={i} rank={i + 1} company={c} />
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

function CompanyCard({ company, rank }: { company: CompanyScore; rank: number }) {
  // 初期状態は折りたたみ（要約のみ）。詳細はユーザー操作で開く。
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl ring-1 ring-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-bold text-slate-900">
          <span className="text-slate-400 mr-1">#{rank}</span>
          {company.company}
        </h3>
        <ConfidenceBadge confidence={company.match.confidence} />
      </div>

      {/* 3スコア（要約・常時表示） */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <ScorePill label="マッチ度" total={company.match.total} tone="blue" />
        <ScorePill label="選考準備度" total={company.readiness.total} tone="emerald" />
        <ScorePill label="活躍可能性" total={company.success.total} tone="violet" />
      </div>

      {/* 詳細トグル（既存 Accordion 方針: aria-expanded + シェブロン回転 + 条件レンダー） */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
      >
        <span>{open ? '詳細を閉じる' : '詳細を見る'}</span>
        <span aria-hidden className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          ▾
        </span>
      </button>

      {open && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          {/* avoidances キャップの説明 */}
          {company.appliedCaps.length > 0 && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700 leading-relaxed">
              「{company.appliedCaps.map((c) => c.label).join('・')}」に該当する可能性があるため、
              マッチ度は上限 {Math.min(...company.appliedCaps.map((c) => c.cap))} 点に制限しています
              （キャップ前: {company.matchUncapped}）。
            </p>
          )}

          {/* 軸別スコア（マッチ度の内訳） */}
          <AxisBreakdown title="マッチ度の内訳（軸別）" breakdown={company.match} />

          <MiniList title="なぜ向いているのか" items={company.matchReasons} accent />
          <MiniList title="活きる強み" items={company.strengthsUsed} />
          <MiniList title="見極めの留意点" items={company.attentionPoints} />

          {/* 不足能力（優先度順） */}
          {company.gaps.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] font-bold text-slate-500 mb-1">あと何が足りないか（優先順）</p>
              <ul className="flex flex-col gap-1.5">
                {company.gaps.slice(0, 4).map((g, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-slate-700">{g.label}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] font-bold text-emerald-700">
                        +{g.deltaIfImproved}
                      </span>
                      <Link href={g.feature.href} className="text-[11px] text-blue-600 hover:underline">
                        {g.feature.label} →
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 改善ロードマップ */}
          {company.roadmap.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] font-bold text-slate-500 mb-1">改善ロードマップ</p>
              <ol className="flex flex-col gap-1.5">
                {company.roadmap.map((step) => (
                  <li key={step.order} className="text-sm text-slate-700">
                    <span className="font-semibold text-slate-900">Step{step.order}　{step.label}</span>
                    <span className="block text-[11px] text-slate-500">{step.reason}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <MiniList title="次のアクション" items={company.nextActions} />
        </div>
      )}
    </div>
  );
}

function ScorePill({ label, total, tone }: { label: string; total: number; tone: 'blue' | 'emerald' | 'violet' }) {
  const toneMap = {
    blue: 'bg-blue-50 text-blue-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    violet: 'bg-violet-50 text-violet-700',
  } as const;
  return (
    <div className={`rounded-lg px-2 py-2 text-center ${toneMap[tone]}`}>
      <p className="text-[10px] font-bold opacity-80">{label}</p>
      <p className="text-lg font-bold leading-tight">{total}</p>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const map = {
    high: { label: '確信度: 高', cls: 'bg-emerald-50 text-emerald-700' },
    mid: { label: '確信度: 中', cls: 'bg-slate-100 text-slate-600' },
    low: { label: '確信度: 低', cls: 'bg-amber-50 text-amber-700' },
  } as const;
  const v = map[confidence];
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${v.cls}`}>{v.label}</span>;
}

function sourceLabel(source: SignalSource): string {
  switch (source) {
    case 'measured':
      return '実測';
    case 'verified_fact':
      return '事実';
    case 'user_input':
      return '入力';
    case 'ai_inferred':
      return 'AI推測';
    default:
      return '未取得';
  }
}

function AxisBreakdown({ title, breakdown }: { title: string; breakdown: ScoreBreakdown }) {
  if (breakdown.items.length === 0) return null;
  return (
    <div className="mt-1 mb-2">
      <p className="text-[11px] font-bold text-slate-500 mb-1.5">{title}</p>
      <div className="flex flex-col gap-1.5">
        {breakdown.items.map((item) => (
          <div key={item.key} className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-[11px] text-slate-600 truncate">{item.label}</span>
            <div className="h-1.5 flex-1 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-blue-500" style={{ width: `${Math.min(100, item.value)}%` }} />
            </div>
            <span className="w-7 shrink-0 text-right text-[11px] font-semibold text-slate-700">
              {item.value}
            </span>
            <span className="w-12 shrink-0 text-right text-[10px] text-slate-400">
              {sourceLabel(item.source)}
            </span>
          </div>
        ))}
      </div>
      {breakdown.missingKeys.length > 0 && (
        <p className="mt-1 text-[10px] text-slate-400">未取得の観点があるため確信度は控えめです。</p>
      )}
    </div>
  );
}

function MiniList({ title, items, accent }: { title: string; items: string[]; accent?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className={`text-[11px] font-bold mb-1 ${accent ? 'text-blue-700' : 'text-slate-500'}`}>{title}</p>
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
            <span key={i} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
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

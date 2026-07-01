'use client';

// PASSAI 就活版 — GD view 画面。
// careerGdResults（localStorage）から一覧（日時・形式・企業評価）＋詳細を表示する。
// 詳細: テーマ / 参加形式 / 人数 / 自分の役割 / 議論ログ / 総合評価・企業評価 /
//       個別フィードバック / AI参加者との比較（ソロ）/ 順位（マルチ）/ 改善課題・次回練習。

import { Suspense, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  GD_ROLE_LABELS,
  GD_FORMAT_LABELS,
  GD_GRADE_LABELS,
  GD_AXIS_LABELS,
  GD_BEHAVIOR_TRAIT_LABELS,
} from '../gdRoles';
import { loadGdResults, updateGdResult } from '../gdStorage';
import type {
  CareerGdResult,
  GdParticipantFeedback,
  GdCompanyGrade,
  GdAxisScores,
} from '@/types/careerGd';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

const AXIS_ORDER: (keyof GdAxisScores)[] = [
  'logic',
  'cooperation',
  'drive',
  'roleExecution',
  'listening',
  'volume',
];

const GRADE_COLORS: Record<GdCompanyGrade, string> = {
  S: 'bg-amber-100 text-amber-800',
  A: 'bg-emerald-100 text-emerald-800',
  B: 'bg-blue-100 text-blue-800',
  C: 'bg-orange-100 text-orange-800',
  D: 'bg-rose-100 text-rose-800',
};

function CareerGdViewInner() {
  const searchParams = useSearchParams();
  const queryId = searchParams.get('id');

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // favorite トグルなどで再読込するためのバージョン。version 変化で loadGdResults を読み直す。
  const [version, setVersion] = useState(0);
  const results = useMemo<CareerGdResult[] | null>(
    () => (isMounted ? loadGdResults() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version は明示的な再読込トリガ
    [isMounted, version],
  );

  const [selectedId, setSelectedId] = useState<string | null>(queryId);
  const selected = useMemo<CareerGdResult | null>(() => {
    if (!results || results.length === 0) return null;
    return results.find((r) => r.id === (selectedId ?? queryId)) ?? results[0];
  }, [results, selectedId, queryId]);

  function toggleFavorite(r: CareerGdResult) {
    updateGdResult(r.id, { favorite: !r.favorite });
    setVersion((v) => v + 1);
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="GDの結果" description="実施したグループディスカッションの評価です。" />

      {results === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : results.length === 0 ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">
            まだGDの結果がありません。GDを実施してください。
          </p>
          <Link
            href="/career/gd/setup"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            GDを始める →
          </Link>
        </Card>
      ) : (
        <>
          <Card variant="soft" padding="md" className="mb-5">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
              練習履歴（{results.length}件）
            </p>
            <ul className="flex flex-col gap-2">
              {results.map((r) => {
                const active = selected?.id === r.id;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors ${
                        active
                          ? 'bg-blue-600 text-white'
                          : 'bg-white ring-1 ring-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="font-semibold">{formatDate(r.createdAt)}</span>
                      <span className={active ? 'text-blue-100' : 'text-slate-400'}>
                        {' '}
                        — {GD_FORMAT_LABELS[r.format]}・{r.participants.length}人・評価{r.selfCompanyGrade}
                        {r.favorite ? '・★' : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {selected && (
            <GdDetail result={selected} onToggleFavorite={() => toggleFavorite(selected)} />
          )}
        </>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/gd/setup"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
        >
          もう一度GDする →
        </Link>
        <Link
          href="/career/gd"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← GDトップに戻る
        </Link>
      </div>
    </div>
  );
}

function GdDetail({
  result,
  onToggleFavorite,
}: {
  result: CareerGdResult;
  onToggleFavorite: () => void;
}) {
  const self = result.participants.find((p) => p.isSelf);
  const selfFeedback = self
    ? result.feedbacks.find((f) => f.participantId === self.id) ?? null
    : null;
  const nameOf = (id: string) =>
    result.participants.find((p) => p.id === id)?.displayName ?? '参加者';

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-xs text-slate-400">
          実施日時: {formatDate(result.createdAt)}・{GD_FORMAT_LABELS[result.format]}・
          {result.participationMode === 'multi' ? 'マルチ' : 'ソロ'}・{result.participants.length}人
        </p>
        <button
          type="button"
          onClick={onToggleFavorite}
          className="shrink-0 text-sm text-amber-500 hover:text-amber-600"
          aria-pressed={!!result.favorite}
        >
          {result.favorite ? '★ お気に入り' : '☆ お気に入り'}
        </button>
      </div>

      {/* この結果を他機能で活かす導線（相談AI・マッチングは最新GD結果を自動参照する） */}
      <div className="mb-4 flex flex-col sm:flex-row gap-2">
        <Link
          href="/career/consultation"
          className="inline-flex flex-1 items-center justify-center gap-1 text-sm font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 ring-1 ring-blue-200 rounded-lg px-4 py-2 transition-colors"
        >
          この結果を就活相談AIで相談する →
        </Link>
        <Link
          href="/career/matching"
          className="inline-flex flex-1 items-center justify-center gap-1 text-sm font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 ring-1 ring-indigo-200 rounded-lg px-4 py-2 transition-colors"
        >
          この結果をマッチングに活かす →
        </Link>
      </div>

      <Section title="テーマ">
        <p className="text-base font-bold text-slate-900 mb-1">{result.theme.title}</p>
        <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
          {result.theme.description}
        </p>
        {result.theme.constraints && result.theme.constraints.length > 0 && (
          <ul className="mt-2 list-disc pl-5 space-y-0.5">
            {result.theme.constraints.map((c, i) => (
              <li key={i} className="text-xs text-slate-500">{c}</li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-500">
          あなたの役割: <span className="font-semibold text-slate-700">{GD_ROLE_LABELS[result.selfRole]}</span>
        </p>
      </Section>

      {/* 総合評価・企業評価 */}
      <Section title="総合評価">
        <div className="flex items-center gap-3 mb-3">
          <span className={`inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-lg font-black ${GRADE_COLORS[result.selfCompanyGrade]}`}>
            {result.selfCompanyGrade}
          </span>
          <div>
            <p className="text-sm font-bold text-slate-800">
              企業選考目線の評価: {GD_GRADE_LABELS[result.selfCompanyGrade]}
            </p>
            {selfFeedback && (
              <p className="text-xs text-slate-500">総合スコア {selfFeedback.totalScore} / 100</p>
            )}
          </div>
        </div>
        <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
          {result.overallSummary || '—'}
        </p>
      </Section>

      {/* 個別フィードバック（自分） */}
      {selfFeedback && (
        <Section title="あなたへの個別フィードバック">
          <AxisBars axis={selfFeedback.axisScores} />
          {selfFeedback.behaviorTraits.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {selfFeedback.behaviorTraits.map((t) => (
                <span key={t} className="inline-flex rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-700">
                  {GD_BEHAVIOR_TRAIT_LABELS[t]}
                </span>
              ))}
            </div>
          )}
          {selfFeedback.companyImpression && (
            <p className="mt-3 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
              {selfFeedback.companyImpression}
            </p>
          )}
          <SubList title="改善点" items={selfFeedback.improvements} />
          <SubList title="次回の練習課題" items={selfFeedback.nextPracticeTasks} />
        </Section>
      )}

      {/* 他機能に活かせる示唆 */}
      {selfFeedback && hasCrossHints(selfFeedback) && (
        <Section title="他の対策に活かせる示唆">
          {selfFeedback.crossFeatureHints.matching && (
            <HintRow label="企業マッチング" text={selfFeedback.crossFeatureHints.matching} />
          )}
          {selfFeedback.crossFeatureHints.interview && (
            <HintRow label="面接" text={selfFeedback.crossFeatureHints.interview} />
          )}
          {selfFeedback.crossFeatureHints.es && (
            <HintRow label="ES" text={selfFeedback.crossFeatureHints.es} />
          )}
          {selfFeedback.crossFeatureHints.selfAnalysis && (
            <HintRow label="自己分析" text={selfFeedback.crossFeatureHints.selfAnalysis} />
          )}
        </Section>
      )}

      {/* 順位（マルチのみ） */}
      {result.ranking && result.ranking.length > 0 && (
        <Section title="参加者内の順位">
          <ul className="flex flex-col gap-2">
            {result.ranking.map((r) => (
              <li key={r.participantId} className="text-sm">
                <span className="font-bold text-slate-900">
                  {r.rank}位　{nameOf(r.participantId)}
                </span>
                <span className="ml-2 text-xs text-slate-500">
                  （{r.companyGrade}・{r.totalScore}点）
                </span>
                {r.reason && (
                  <p className="text-xs text-slate-500 leading-relaxed mt-0.5">{r.reason}</p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* AI参加者との比較（ソロ） */}
      {result.participationMode === 'solo' && result.feedbacks.length > 1 && (
        <Section title="AI参加者との比較">
          <ul className="flex flex-col gap-1.5">
            {result.feedbacks
              .slice()
              .sort((a, b) => b.totalScore - a.totalScore)
              .map((f) => {
                const p = result.participants.find((x) => x.id === f.participantId);
                const isSelf = p?.isSelf;
                return (
                  <li
                    key={f.participantId}
                    className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${isSelf ? 'bg-blue-50 font-bold text-blue-800' : 'bg-white ring-1 ring-slate-200 text-slate-700'}`}
                  >
                    <span>
                      {p?.displayName ?? '参加者'}
                      {isSelf ? '（あなた）' : ''}・{p ? GD_ROLE_LABELS[p.role] : ''}
                    </span>
                    <span>
                      {f.companyGrade}・{f.totalScore}点
                    </span>
                  </li>
                );
              })}
          </ul>
        </Section>
      )}

      {/* 議論ログ */}
      <Section title="議論ログ">
        <ul className="flex flex-col gap-2">
          {result.transcript.map((u) => {
            const p = result.participants.find((x) => x.id === u.participantId);
            return (
              <li key={u.id} className="text-sm leading-relaxed">
                <span className={p?.isSelf ? 'font-bold text-blue-700' : 'font-bold text-slate-900'}>
                  {nameOf(u.participantId)}
                  <span className="ml-1 text-[11px] font-medium text-slate-400">
                    {p ? GD_ROLE_LABELS[p.role] : ''}
                  </span>
                  ：
                </span>
                <span className="text-slate-700 whitespace-pre-wrap">{u.content}</span>
              </li>
            );
          })}
        </ul>
      </Section>
    </>
  );
}

function AxisBars({ axis }: { axis: GdAxisScores }) {
  return (
    <div className="flex flex-col gap-2">
      {AXIS_ORDER.map((k) => (
        <div key={k} className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs text-slate-500">{GD_AXIS_LABELS[k]}</span>
          <div className="h-2 flex-1 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(0, axis[k]))}%` }} />
          </div>
          <span className="w-8 shrink-0 text-right text-xs font-semibold text-slate-600">{axis[k]}</span>
        </div>
      ))}
    </div>
  );
}

function hasCrossHints(f: GdParticipantFeedback): boolean {
  const h = f.crossFeatureHints;
  return !!(h.matching || h.interview || h.es || h.selfAnalysis);
}

function HintRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="mb-2 last:mb-0">
      <p className="text-[11px] font-bold text-slate-500">{label}</p>
      <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{text}</p>
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

function SubList({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-[11px] font-bold text-slate-500 mb-1">{title}</p>
      <ul className="list-disc pl-5 space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-slate-700 leading-relaxed">{item}</li>
        ))}
      </ul>
    </div>
  );
}

export default function CareerGdViewPage() {
  return (
    <Suspense fallback={null}>
      <CareerGdViewInner />
    </Suspense>
  );
}

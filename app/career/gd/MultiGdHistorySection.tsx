'use client';

// PASSAI 就活版 — マルチGD 学習履歴セクション（STEP-GD-16）。
// /career/gd/view に組み込む。careerGdRoomLogs（localStorage canonical）から
//   - 統計（実施回数 / 平均スコア / 最高スコア / 最高ランク）
//   - 一覧カード（テーマ / 日時 / 総合スコア / ランク / 企業コミュ適性 / 参加人数 / 発言数 / 所要時間）
//   - テーマ検索 + ランク/スコア帯フィルタ
//   - 詳細（GdEvaluationDetail 共用）
// を表示する。空状態は「まだGD履歴がありません」。

import { useMemo, useState, useSyncExternalStore } from 'react';
import { Card } from '@/components/ui/Card';
import { GD_FORMAT_LABELS } from './gdRoles';
import { GdEvaluationDetail, GD_GRADE_STYLE } from './GdEvaluationDetail';
import { loadGdRoomLogs, removeGdRoomLog } from './gdRoomLogStorage';
import type { CareerGdRoomLog, GdCompanyGrade } from '@/types/careerGd';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

const RANK_ORDER: Record<GdCompanyGrade, number> = { S: 5, A: 4, B: 3, C: 2, D: 1 };
const RANK_FILTERS: (GdCompanyGrade | 'all')[] = ['all', 'S', 'A', 'B', 'C', 'D'];
const SCORE_BANDS = [
  { key: 'all', label: '全て', test: () => true },
  { key: 'high', label: '80+', test: (s: number) => s >= 80 },
  { key: 'mid', label: '60-79', test: (s: number) => s >= 60 && s < 80 },
  { key: 'low', label: '〜59', test: (s: number) => s < 60 },
] as const;

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP');
}
function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const m = Math.round(sec / 60);
  return `${m}分`;
}

export function MultiGdHistorySection() {
  const isMounted = useSyncExternalStore(subscribeMount, getMountedSnapshot, getMountedServerSnapshot);
  const [version, setVersion] = useState(0);
  const logs = useMemo<CareerGdRoomLog[] | null>(
    () => (isMounted ? loadGdRoomLogs() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version は明示的な再読込トリガ
    [isMounted, version],
  );

  const [query, setQuery] = useState('');
  const [rankFilter, setRankFilter] = useState<GdCompanyGrade | 'all'>('all');
  const [scoreBand, setScoreBand] = useState<(typeof SCORE_BANDS)[number]['key']>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const stats = useMemo(() => {
    const scored = (logs ?? []).filter((l) => l.evaluation.scored);
    const scores = scored.map((l) => l.evaluation.overallScore);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    const max = scores.length ? Math.max(...scores) : 0;
    const bestRank = scored.reduce<GdCompanyGrade | null>((best, l) => {
      const g = l.evaluation.rank;
      return best === null || RANK_ORDER[g] > RANK_ORDER[best] ? g : best;
    }, null);
    return { count: logs?.length ?? 0, avg, max, bestRank };
  }, [logs]);

  const filtered = useMemo(() => {
    if (!logs) return [];
    const q = query.trim().toLowerCase();
    const band = SCORE_BANDS.find((b) => b.key === scoreBand) ?? SCORE_BANDS[0];
    return logs.filter((l) => {
      if (q && !l.theme.title.toLowerCase().includes(q)) return false;
      if (rankFilter !== 'all' && l.evaluation.rank !== rankFilter) return false;
      if (!band.test(l.evaluation.overallScore)) return false;
      return true;
    });
  }, [logs, query, rankFilter, scoreBand]);

  const selected = useMemo(() => filtered.find((l) => l.id === selectedId) ?? null, [filtered, selectedId]);

  if (logs === null) {
    return (
      <Card variant="soft" padding="md" className="mb-5">
        <p className="text-sm text-slate-500">読み込み中…</p>
      </Card>
    );
  }

  if (logs.length === 0) {
    return (
      <Card variant="soft" padding="md" className="mb-5">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">ルームGD（マルチ）の履歴</p>
        <p className="text-sm text-slate-600">まだGD履歴がありません。</p>
      </Card>
    );
  }

  return (
    <div className="mb-6">
      {/* 統計 */}
      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">ルームGD（マルチ）の履歴</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="実施回数" value={`${stats.count}`} unit="回" />
          <Stat label="平均スコア" value={`${stats.avg}`} unit="点" />
          <Stat label="最高スコア" value={`${stats.max}`} unit="点" />
          <Stat label="最高ランク" value={stats.bestRank ?? '—'} />
        </div>
      </Card>

      {/* 検索・フィルタ */}
      <Card variant="soft" padding="md" className="mb-4">
        <label htmlFor="gd-history-search" className="sr-only">テーマ検索</label>
        <input
          id="gd-history-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="テーマで検索"
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
        />
        <div className="mt-3 flex flex-wrap gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-slate-400">ランク</span>
            {RANK_FILTERS.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setRankFilter(g)}
                className={`rounded-md px-2 py-0.5 text-xs font-semibold transition-colors ${rankFilter === g ? 'bg-blue-600 text-white' : 'bg-white ring-1 ring-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                {g === 'all' ? '全' : g}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-slate-400">スコア</span>
            {SCORE_BANDS.map((b) => (
              <button
                key={b.key}
                type="button"
                onClick={() => setScoreBand(b.key)}
                className={`rounded-md px-2 py-0.5 text-xs font-semibold transition-colors ${scoreBand === b.key ? 'bg-blue-600 text-white' : 'bg-white ring-1 ring-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* 一覧 */}
      {filtered.length === 0 ? (
        <Card variant="soft" padding="md" className="mb-4">
          <p className="text-sm text-slate-500">条件に一致する履歴がありません。</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2 mb-4">
          {filtered.map((l) => {
            const ev = l.evaluation;
            const active = selected?.id === l.id;
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(active ? null : l.id)}
                  className={`w-full text-left rounded-xl px-3 py-3 transition-colors ${active ? 'bg-blue-50 ring-1 ring-blue-300' : 'bg-white ring-1 ring-slate-200 hover:bg-slate-50'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-800 truncate">{l.theme.title || 'グループディスカッション'}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        {formatDate(l.createdAt)}・{GD_FORMAT_LABELS[l.format]}・{l.participantCount}人・発言{ev.speechCount}回・{formatDuration(l.durationSec)}
                      </p>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      {ev.scored ? (
                        <>
                          <span className="text-sm font-bold text-slate-700 tabular-nums">{ev.overallScore}</span>
                          <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${GD_GRADE_STYLE[ev.rank]}`}>{ev.rank}</span>
                          <span className={`inline-flex h-6 items-center rounded px-1.5 text-[10px] font-bold ${GD_GRADE_STYLE[ev.companyCommunicationGrade]}`}>コミュ{ev.companyCommunicationGrade}</span>
                        </>
                      ) : (
                        <span className="text-[11px] font-semibold text-slate-400">採点不能</span>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* 詳細 */}
      {selected && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-slate-400">
              実施日時: {formatDate(selected.createdAt)}・{GD_FORMAT_LABELS[selected.format]}・{selected.participantCount}人
            </p>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined' && !window.confirm('この履歴を削除しますか？')) return;
                removeGdRoomLog(selected.id);
                setSelectedId(null);
                setVersion((v) => v + 1);
              }}
              className="shrink-0 text-xs text-rose-500 hover:text-rose-600"
            >
              履歴を削除
            </button>
          </div>
          <GdEvaluationDetail
            evaluation={selected.evaluation}
            ranking={selected.ranking}
            matchingHints={selected.matchingHints}
            selfParticipantId={selected.participantId}
          />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-100 px-3 py-2 text-center">
      <p className="text-[10px] text-slate-400">{label}</p>
      <p className="text-lg font-bold text-slate-800 tabular-nums leading-tight">
        {value}
        {unit && <span className="text-[10px] font-normal text-slate-400 ml-0.5">{unit}</span>}
      </p>
    </div>
  );
}

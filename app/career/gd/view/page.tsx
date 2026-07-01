'use client';

// PASSAI 就活版 — GD view 画面。
// careerGdResults（localStorage）から一覧（日時・形式・企業評価）＋詳細を表示する。
// 詳細: テーマ / 参加形式 / 人数 / 自分の役割 / 議論ログ / 総合評価・企業評価 /
//       個別フィードバック / AI参加者との比較（ソロ）/ 順位（マルチ）/ 改善課題・次回練習。

import { Suspense, useMemo, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { GD_FORMAT_LABELS } from '../gdRoles';
import { loadGdResults, updateGdResult } from '../gdStorage';
import { MultiGdHistorySection } from '../MultiGdHistorySection';
import { GdSoloResultDetail, formatDate } from '../GdSoloResultDetail';
import type { CareerGdResult } from '@/types/careerGd';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

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

      {/* STEP-GD-16: マルチGD 学習履歴（localStorage canonical / Supabase durable mirror） */}
      <MultiGdHistorySection />

      {results === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : results.length === 0 ? (
        // ソロGD の結果は無し。マルチGD 履歴は上の MultiGdHistorySection が扱う。
        null
      ) : (
        <>
          <p className="text-[11px] font-bold text-slate-500 tracking-widest mb-3">1人練習（ソロGD）の履歴</p>
          <Card variant="soft" padding="md" className="mb-5">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
              1人練習の履歴（{results.length}件）
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
            <GdSoloResultDetail result={selected} onToggleFavorite={() => toggleFavorite(selected)} />
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

export default function CareerGdViewPage() {
  return (
    <Suspense fallback={null}>
      <CareerGdViewInner />
    </Suspense>
  );
}

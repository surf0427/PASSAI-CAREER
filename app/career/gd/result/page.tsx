'use client';

// PASSAI 就活版 — ソロGD（1人 + AI）結果画面（STEP-GD-18）。
// careerGdResults（localStorage）から、?id= 指定の結果、無ければ直近の結果 1 件を表示する。
// 結果が無ければ /career/gd/run（1人練習を始める）/ /career/gd へ自然に誘導。
// マルチGD（ルーム）の結果はここに混ぜず、履歴（/career/gd/view）へ誘導する。

import { Suspense, useMemo, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadGdResults, updateGdResult } from '../gdStorage';
import { GdSoloResultDetail } from '../GdSoloResultDetail';
import type { CareerGdResult } from '@/types/careerGd';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function CareerGdResultInner() {
  const searchParams = useSearchParams();
  const queryId = searchParams.get('id');

  const isMounted = useSyncExternalStore(subscribeMount, getMountedSnapshot, getMountedServerSnapshot);
  const [version, setVersion] = useState(0);

  const results = useMemo<CareerGdResult[] | null>(
    () => (isMounted ? loadGdResults() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version は明示的な再読込トリガ
    [isMounted, version],
  );

  // id 指定があればその結果、無ければ直近（先頭）。
  const result = useMemo<CareerGdResult | null>(() => {
    if (!results || results.length === 0) return null;
    return (queryId ? results.find((r) => r.id === queryId) : null) ?? results[0];
  }, [results, queryId]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="ソロGDの結果" description="1人練習（あなた + AI参加者）の直近の結果です。" />

      {results === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : !result ? (
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm font-bold text-slate-800 mb-1">まだソロGDの結果がありません</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            1人練習（あなた + AI参加者）を実施すると、企業選考目線のフィードバックがここに表示されます。
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <Link
              href="/career/gd/run"
              className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              1人練習を始める →
            </Link>
            <Link
              href="/career/gd"
              className="inline-flex items-center justify-center rounded-xl bg-white px-5 py-2.5 text-sm font-bold text-slate-700 ring-1 ring-slate-200 shadow-sm transition-colors hover:bg-slate-50"
            >
              GDトップへ
            </Link>
          </div>
          <p className="mt-4 text-[11px] text-slate-400 leading-relaxed">
            ※ 友達と行った「ルームGD（マルチ）」の結果は<Link href="/career/gd/view" className="text-blue-600 hover:underline">GD履歴</Link>から確認できます。
          </p>
        </Card>
      ) : (
        <>
          <GdSoloResultDetail
            result={result}
            onToggleFavorite={() => {
              updateGdResult(result.id, { favorite: !result.favorite });
              setVersion((v) => v + 1);
            }}
          />
          <p className="mt-1 mb-4 text-[11px] text-slate-400 leading-relaxed">
            ※ 友達と行った「ルームGD（マルチ）」の結果は<Link href="/career/gd/view" className="text-blue-600 hover:underline">GD履歴</Link>から確認できます。
          </p>
        </>
      )}

      <div className="mt-6 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/gd/run"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-4 py-2 transition-colors"
        >
          もう一度 1人練習する →
        </Link>
        <Link
          href="/career/gd/view"
          className="inline-flex items-center justify-center gap-1 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 rounded-lg px-4 py-2 transition-colors"
        >
          GD履歴を見る
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

export default function CareerGdResultPage() {
  return (
    <Suspense fallback={null}>
      <CareerGdResultInner />
    </Suspense>
  );
}

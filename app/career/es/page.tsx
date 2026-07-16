'use client';

// PASSAI 就活版 — ES（エントリーシート）トレーニング ハブ画面
//
// ES機能は「AIによる代筆」ではなく「ユーザー自身が書く力を鍛えるトレーニング」。
// AI の役割は 深掘り質問 / 材料整理 / 添削 / 改善支援 に限定し、本文はユーザーが書く。
// 4 機能を提示する:
//   ① 深掘りしながら書く（Do）  → /career/es/new?mode=deep
//   ② 自力で書く（Do）          → /career/es/new?mode=write
//   ③ 添削結果を見る（View）    → /career/es/history
//   ④ 改善する（Do）            → /career/es/history
// DB / 課金 / usage には接続しない（localStorage のみ）。

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { loadEsGroupsLatest } from './esStorage';

// マウント前 false / マウント後 true（hub と同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerEsEntryPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // 保存済み ES のグループ数（設問＋企業の束）。③④の導線活性判定に使う。
  const groupCount = useMemo<number | null>(
    () => (isMounted ? loadEsGroupsLatest().length : null),
    [isMounted],
  );
  const hasLogs = (groupCount ?? 0) > 0;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="ES（エントリーシート）トレーニング"
        description="AIが代わりに書くのではなく、あなた自身がESを書く力を鍛えます。AIは深掘り質問・材料整理・添削・改善支援を担当します。"
      />

      {/* まず書く（Do）: ①深掘り / ②自力 */}
      <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">まず書く</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 mb-6">
        <ModeCard
          badge="① 深掘りしながら書く"
          title="AIと対話して整理してから書く"
          description="AIの質問に答えて経験・考えを整理し、その要約メモを見ながら自分でESを書きます。"
          href="/career/es/new?mode=deep"
          primary
        />
        <ModeCard
          badge="② 自力で書く"
          title="いきなり自分で書く"
          description="設問だけを見て、最初から最後まで自力でESを書き上げます。"
          href="/career/es/new?mode=write"
        />
      </div>

      {/* 見直す（View / Do）: ③結果を見る / ④改善する */}
      <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">見直す・伸ばす</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <ModeCard
          badge="③ 添削結果を見る"
          title="過去のESと添削を振り返る"
          description={
            hasLogs
              ? `保存済み ${groupCount} 件。設問・企業・点数・版番号を一覧で確認できます。`
              : 'まだ保存されたESはありません。まず書いてみましょう。'
          }
          href="/career/es/history"
          disabled={!hasLogs}
        />
        <ModeCard
          badge="④ 改善する"
          title="添削をもとに書き直して伸ばす"
          description={
            hasLogs
              ? '前回の添削を見ながら本文を直し、再添削で点数の伸びを確認します。'
              : '改善対象のESがまだありません。まず書いてみましょう。'
          }
          href="/career/es/history"
          disabled={!hasLogs}
        />
      </div>

      <div className="mt-8">
        <Link
          href="/career/home"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← ホームに戻る
        </Link>
      </div>
    </div>
  );
}

const CARD_BASE =
  'block w-full text-left rounded-2xl bg-white ring-1 ring-slate-200 shadow-card transition-all p-4 sm:p-5 min-h-[130px]';

function ModeCard({
  badge,
  title,
  description,
  href,
  primary = false,
  disabled = false,
}: {
  badge: string;
  title: string;
  description: string;
  href: string;
  primary?: boolean;
  disabled?: boolean;
}) {
  const badgeClass = primary
    ? 'text-blue-700'
    : disabled
      ? 'text-slate-400'
      : 'text-slate-500';

  if (disabled) {
    return (
      <div className={`${CARD_BASE} opacity-60 cursor-not-allowed`} aria-disabled>
        <p className={`text-[11px] font-bold tracking-wide mb-1.5 ${badgeClass}`}>{badge}</p>
        <h2 className="text-sm sm:text-base font-bold mb-1.5 leading-snug text-slate-900">{title}</h2>
        <p className="text-xs leading-relaxed text-slate-500">{description}</p>
      </div>
    );
  }

  return (
    <Link
      href={href}
      className={`${CARD_BASE} hover:shadow-md active:bg-slate-50 ${
        primary ? 'ring-blue-200' : ''
      }`}
    >
      <p className={`text-[11px] font-bold tracking-wide mb-1.5 ${badgeClass}`}>{badge}</p>
      <h2 className="text-sm sm:text-base font-bold mb-1.5 leading-snug text-slate-900">{title}</h2>
      <p className="text-xs leading-relaxed text-slate-500">{description}</p>
    </Link>
  );
}

'use client';

// PASSAI CAREER — マイページ「成長進度」。
//
// 4 機能の **既存の評価結果** を並べるだけのセクション（再評価・AI 呼び出しは一切しない）。
//   ① 自己分析  … レーダー（点数ではなく「領域別の言語化件数」。自己分析に数値評価は存在しない）
//   ② ES作成    … 添削の総合スコア（0〜100）の時系列
//   ③ 面接練習  … 面接終了時の総合スコア（0〜100）の時系列
//   ④ プレゼン  … 発表本編の総合スコア（0〜100）の時系列
//
// 見せたいのは「過去の自分と今の自分の比較」だけ。他ユーザー比較・順位・偏差値は出さない。
// 0 件 / 1 件 / 複数件のいずれでも壊れない（0 件はグラフを描かず empty state）。

import Link from 'next/link';
import type { ReactNode } from 'react';

import { Card } from '@/components/ui/Card';
import GrowthLineChart from './GrowthLineChart';
import SelfAnalysisRadarChart from './SelfAnalysisRadarChart';
import type {
  CareerGrowthSeries,
  CareerMyPageProgress,
} from '@/lib/careerMyPageProgress/types';

// ── 共通パーツ ──────────────────────────────────────────────────────

function CardShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card variant="default" padding="md">
      <h3 className="text-sm font-semibold text-slate-900 mb-3">{title}</h3>
      {children}
    </Card>
  );
}

function EmptyBody({ message, hint, href, cta }: { message: string; hint: string; href: string; cta: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-4 py-6 text-center">
      <p className="text-sm text-slate-700">{message}</p>
      <p className="mt-1 text-xs text-slate-500 leading-relaxed">{hint}</p>
      <Link
        href={href}
        className="mt-3 inline-block text-xs text-brand-600 hover:text-brand-700 transition-colors"
      >
        {cta} →
      </Link>
    </div>
  );
}

/** 前回比。2 件目以降でだけ数値を出し、初回は「初回」と明示する（0 と書かない）。 */
function DeltaLabel({ series }: { series: CareerGrowthSeries }) {
  if (series.history.length === 0) return null;
  if (series.delta === null) {
    return <span className="text-sm text-slate-500">初回</span>;
  }
  if (series.delta === 0) {
    return <span className="text-sm text-slate-500">変化なし</span>;
  }
  const up = series.delta > 0;
  return (
    <span className={`text-sm font-medium ${up ? 'text-brand-600' : 'text-slate-600'}`}>
      {up ? '+' : ''}
      {series.delta}
    </span>
  );
}

function LineCard({
  title,
  series,
  unitLabel,
  emptyMessage,
  emptyHint,
  href,
  cta,
}: {
  title: string;
  series: CareerGrowthSeries;
  unitLabel: string;
  emptyMessage: string;
  emptyHint: string;
  href: string;
  cta: string;
}) {
  if (series.history.length === 0) {
    return (
      <CardShell title={title}>
        <EmptyBody message={emptyMessage} hint={emptyHint} href={href} cta={cta} />
      </CardShell>
    );
  }

  return (
    <CardShell title={title}>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 mb-3">
        <div>
          <p className="text-xs text-slate-500">現在の評価</p>
          <p className="text-2xl font-semibold text-slate-900 tabular-nums leading-tight">
            {series.latestScore}
            <span className="ml-1 text-xs font-normal text-slate-500">/ 100</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500">前回比</p>
          <p className="leading-tight">
            <DeltaLabel series={series} />
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <GrowthLineChart points={series.history} ariaLabel={`${title}の総合評価の推移`} />
      </div>

      <p className="mt-2 text-xs text-slate-500">
        {series.history.length}
        {unitLabel}
        {/* 評価が付いていない実施（旧ログ・添削前の版など）がある場合だけ内訳を注記する。 */}
        {series.totalCount > series.history.length && (
          <span className="text-slate-400">（全 {series.totalCount} 件中）</span>
        )}
      </p>
    </CardShell>
  );
}

// ── セクション本体 ──────────────────────────────────────────────────

export default function GrowthSection({ progress }: { progress: CareerMyPageProgress }) {
  const latest = progress.selfAnalysis.latest;

  return (
    <section>
      <h2 className="text-sm font-semibold text-brand-600 mb-3 px-1">成長進度</h2>
      {/* mobile は 1 カラム、desktop は 2 カラム。グラフは viewBox 依存なのではみ出さない。 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ① 自己分析（レーダー） */}
        <CardShell title="自己分析">
          {latest ? (
            <>
              <SelfAnalysisRadarChart dimensions={latest.dimensions} />
              <p className="mt-2 text-xs text-slate-500 leading-relaxed">
                最新の自己分析で、いまどの領域まで言語化できているかです。
                <span className="text-slate-400">
                  （点数ではなく件数。自己分析には点数評価がありません）
                </span>
              </p>
            </>
          ) : (
            <EmptyBody
              message="まだ自己分析の結果がありません"
              hint="自己分析をすると、ここに現在の自己理解が表示されます。"
              href="/career/self-analysis"
              cta="自己分析をはじめる"
            />
          )}
        </CardShell>

        {/* ② ES作成 */}
        <LineCard
          title="ES作成"
          series={progress.es}
          unitLabel="件の添削"
          emptyMessage="まだ添削済みのESがありません"
          emptyHint="ESを書いてAI添削を受けると、総合評価の推移がここに表示されます。"
          href="/career/es"
          cta="ESをつくる"
        />

        {/* ③ 面接練習 */}
        <LineCard
          title="面接練習"
          series={progress.interview}
          unitLabel="回の面接"
          emptyMessage="まだ面接の評価がありません"
          emptyHint="面接練習を最後まで行うと、総合評価の推移がここに表示されます。"
          href="/career/interview"
          cta="面接練習をはじめる"
        />

        {/* ④ プレゼン */}
        <LineCard
          title="プレゼン"
          series={progress.presentation}
          unitLabel="回のプレゼン"
          emptyMessage="まだプレゼンの評価がありません"
          emptyHint="プレゼン練習を最後まで行うと、総合評価の推移がここに表示されます。"
          href="/career/presentation"
          cta="プレゼン練習をはじめる"
        />
      </div>
    </section>
  );
}

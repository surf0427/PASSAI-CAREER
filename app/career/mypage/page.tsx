'use client';

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import CareerProfileSummary from '@/components/career/CareerProfileSummary';
import {
  buildMypageSummary,
  type MypageSummary,
  type ProgressItem,
  type ProgressState,
  type RecentOutput,
  type NextAction,
  type ScoreStat,
} from './mypageSummary';

// 就活版マイページ（就活ダッシュボード）。
//   - /career/home は「機能入口ランチャー」、本ページは「進捗・履歴・次アクションの振り返り」。
//   - localStorage canonical。各 career 機能の load* を読み取り集約表示するだけ（保存はしない）。
//   - 受験版 /mypage のコンポーネント（BillingCard / UsageStatusCard / LoginNudge 等・課金/受験系）は
//     一切流用しない。就活版として新規実装する。

// SSR-stable mount flag（/career/home と同形）。hydration 後に true へ切替え、
// storage 読み出しを post-hydration に揃える（SSR では常に false）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function formatYmd(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

export default function CareerMypagePage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const summary = useMemo<MypageSummary | null>(
    () => (isMounted ? buildMypageSummary() : null),
    [isMounted],
  );

  // hydration セーフ: mount 前は何も描画しない（/career/home と同方針）。
  if (!isMounted || !summary) return null;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
      {/* 1. ヘッダー */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">マイページ</h1>
          <div className="flex items-center gap-3">
            <Link
              href="/career/home"
              className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
            >
              ← ホーム
            </Link>
            <Link
              href="/career/consultation"
              className="text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors"
            >
              就活相談AI →
            </Link>
          </div>
        </div>
        <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
          就活の進捗・練習履歴・次にやることをまとめて確認できます。
        </p>
      </div>

      {summary.isEmpty ? (
        <EmptyState />
      ) : (
        <div className="space-y-8">
          {/* 2. プロフィール概要 */}
          <ProfileSection summary={summary} />

          {/* 3. 次にやるべきこと */}
          <NextActionsSection actions={summary.nextActions} />

          {/* 4. 就活進捗サマリー */}
          <ProgressSection items={summary.progress} />

          {/* 5. 実績サマリー */}
          <AchievementSection summary={summary} />

          {/* 6. 最近のアウトプット */}
          <RecentSection recent={summary.recent} />

          {/* 7. 相談CTA */}
          <ConsultationCta />
        </div>
      )}
    </div>
  );
}

// ── セクション: プロフィール概要 ─────────────────────────────────────

function ProfileSection({ summary }: { summary: MypageSummary }) {
  if (!summary.profile) {
    return (
      <SectionCard title="プロフィール">
        <p className="text-sm text-gray-600 mb-3">
          基本情報がまだ登録されていません。まずはあなたの就活状況を PASSAI CAREER に覚えさせましょう。
        </p>
        <LinkButton href="/career/profile" variant="primary" size="md">
          基本情報を入力する
        </LinkButton>
      </SectionCard>
    );
  }
  return <CareerProfileSummary profile={summary.profile} editHref="/career/profile" />;
}

// ── セクション: 次にやるべきこと ─────────────────────────────────────

function NextActionsSection({ actions }: { actions: NextAction[] }) {
  if (actions.length === 0) return null;
  return (
    <section>
      <SectionTitle>次にやるべきこと</SectionTitle>
      <div className="space-y-3">
        {actions.map((a) => (
          <Card key={a.key} variant="soft" padding="md">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-gray-800 mb-1">{a.title}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{a.description}</p>
              </div>
              <div className="shrink-0 sm:self-center">
                <LinkButton href={a.href} variant="primary" size="md">
                  {a.cta} →
                </LinkButton>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

// ── セクション: 就活進捗サマリー ─────────────────────────────────────

const STATE_BADGE: Record<ProgressState, string> = {
  done: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  has_history: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  in_progress: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  empty: 'bg-gray-100 text-gray-500',
};

function ProgressSection({ items }: { items: ProgressItem[] }) {
  const doneCount = items.filter((i) => i.state !== 'empty').length;
  return (
    <section>
      <SectionTitle right={`${doneCount} / ${items.length} 着手`}>就活進捗</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {items.map((item) => (
          <Link key={item.key} href={item.href} className="block">
            <Card variant="default" padding="sm" className="h-full">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-gray-800">{item.label}</span>
                <span
                  className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${STATE_BADGE[item.state]}`}
                >
                  {item.statusLabel}
                </span>
              </div>
              {item.latest && (
                <p className="mt-1 text-xs text-gray-400">最終更新 {formatYmd(item.latest)}</p>
              )}
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ── セクション: 実績サマリー ────────────────────────────────────────

function AchievementSection({ summary }: { summary: MypageSummary }) {
  const a = summary.achievements;
  const tiles: Array<{ label: string; value: number; href: string }> = [
    { label: 'ES作成', value: a.es, href: '/career/es' },
    { label: '面接練習', value: a.interview, href: '/career/interview' },
    { label: 'プレゼン', value: a.presentation, href: '/career/presentation' },
    { label: 'GD（ソロ）', value: a.gdSolo, href: '/career/gd' },
    { label: 'GD（複数人）', value: a.gdMulti, href: '/career/gd' },
    { label: '企業研究', value: a.companyResearch, href: '/career/company-research' },
    { label: '自己分析', value: a.selfAnalysis, href: '/career/self-analysis' },
    { label: '相談', value: a.consultation, href: '/career/consultation' },
  ];

  return (
    <section>
      <SectionTitle
        right={
          a.lastFeatureLabel && a.lastUpdated
            ? `最終利用 ${a.lastFeatureLabel}・${formatYmd(a.lastUpdated)}`
            : undefined
        }
      >
        練習・作成の実績
      </SectionTitle>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href} className="block">
            <Card variant="default" padding="sm" className="h-full text-center">
              <div className="text-2xl font-bold text-gray-800">{t.value}</div>
              <div className="mt-0.5 text-xs text-gray-500">{t.label}</div>
            </Card>
          </Link>
        ))}
      </div>

      {summary.achievements.scores.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {summary.achievements.scores.map((s) => (
            <ScoreCard key={s.key} score={s} />
          ))}
        </div>
      )}
    </section>
  );
}

function ScoreCard({ score }: { score: ScoreStat }) {
  return (
    <Card variant="soft" padding="sm">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold text-gray-700">{score.label}スコア</span>
        <span className="text-xs text-gray-400">{score.count}件</span>
      </div>
      <div className="mt-1 flex items-baseline gap-3">
        <div>
          <span className="text-2xl font-bold text-gray-800">{score.average}</span>
          <span className="text-xs text-gray-500 ml-1">平均</span>
        </div>
        <div className="text-xs text-gray-500">
          最新 <span className="font-semibold text-gray-700">{score.latest}</span>
        </div>
      </div>
    </Card>
  );
}

// ── セクション: 最近のアウトプット ─────────────────────────────────

function RecentSection({ recent }: { recent: RecentOutput[] }) {
  if (recent.length === 0) return null;
  return (
    <section>
      <SectionTitle>最近のアウトプット</SectionTitle>
      <Card variant="default" padding="none">
        <ul className="divide-y divide-slate-100">
          {recent.map((r) => (
            <li key={r.id}>
              <Link
                href={r.href}
                className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors"
              >
                <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                  {r.type}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-gray-800 truncate">
                    {r.title}
                  </span>
                  {r.description && (
                    <span className="block text-xs text-gray-500 truncate">
                      {r.description}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-gray-400">{formatYmd(r.date)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

// ── セクション: 相談CTA ─────────────────────────────────────────────

function ConsultationCta() {
  return (
    <Card variant="soft" padding="md" className="ring-1 ring-blue-100">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex-1">
          <h3 className="text-base font-bold text-gray-800 mb-1">迷ったら就活相談AIへ</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            ここまでの整理をもとに、今の現在地と次にやることを横断で相談できます。
          </p>
        </div>
        <div className="shrink-0 sm:self-center">
          <LinkButton href="/career/consultation" variant="primary" size="md">
            相談する →
          </LinkButton>
        </div>
      </div>
    </Card>
  );
}

// ── 空状態 ──────────────────────────────────────────────────────────

function EmptyState() {
  const steps = [
    {
      title: 'まずは基本情報を登録',
      body: '大学・学年などを登録して、PASSAI CAREER にあなたの就活状況を覚えさせましょう。',
      href: '/career/profile',
      cta: '基本情報を入力',
    },
    {
      title: '活動を整理する',
      body: '学生時代の経験を入力すると、ES・面接・企業研究の精度が上がります。',
      href: '/career/activity',
      cta: '活動整理へ',
    },
    {
      title: '就活軸を整理する',
      body: '基本情報と就活軸を入れておくと、就活相談AIの回答がぐっと具体的になります。',
      href: '/career/values',
      cta: '就活軸整理へ',
    },
  ];
  return (
    <div className="space-y-6">
      <Card variant="soft" padding="lg">
        <h2 className="text-lg font-bold text-gray-800 mb-1.5">
          まだ記録がありません
        </h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          各機能を使うと、その結果や履歴・進捗がここに集まります。<br />
          まずは下のステップから就活を一歩ずつ進めましょう。
        </p>
      </Card>

      <div className="space-y-3">
        {steps.map((s) => (
          <Card key={s.href} variant="default" padding="md">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex-1">
                <h3 className="text-base font-bold text-gray-800 mb-1">{s.title}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{s.body}</p>
              </div>
              <div className="shrink-0 sm:self-center">
                <LinkButton href={s.href} variant="primary" size="md">
                  {s.cta} →
                </LinkButton>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── 共通の小さな部品 ─────────────────────────────────────────────────

function SectionTitle({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: string;
}) {
  return (
    <div className="flex items-center justify-between mb-3 px-1">
      <h2 className="text-sm font-semibold text-brand-600">{children}</h2>
      {right && <span className="text-xs text-gray-400">{right}</span>}
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <Card variant="default" padding="md">
        {children}
      </Card>
    </section>
  );
}

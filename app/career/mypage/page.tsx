'use client';

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import CareerProfileSummary from '@/components/career/CareerProfileSummary';
import CareerLoginStatusCard from '@/app/career/components/CareerLoginStatusCard';
import CareerBillingCard from '@/app/career/components/CareerBillingCard';
import CareerEventTimelineSection from './CareerEventTimeline';
// NEXT-7: 同意取得カード。gate（運用 flag + 法務承認 + readiness）が閉じている間は null を返し何も描画しない。
import CareerConsentCard from './CareerConsentCard';
// User Data Spine Layer 1 の canonical bundle loader（server reader と同じ CareerSourceBundle 型）。
import { loadCanonicalSourceBundle } from '@/app/career/sourceSyncClient';
import {
  subscribeCanonicalSnapshot,
  getCanonicalSnapshotVersion,
  getCanonicalSnapshotServerVersion,
  notifyCanonicalSnapshotChanged,
} from './canonicalSnapshotStore';
import { CROSS_FEATURE_SYNC_KINDS } from '@/lib/careerSourceSync/kinds';
import type { CareerSourceBundle } from '@/lib/careerSourceData/types';
import { buildMypageSpineView, type MypageSpineView } from './mypageDataSpineView';
import AspirationCard from './AspirationCard';
import {
  UnderstandingSection,
  ExperienceSection,
  SelfAnalysisSection,
  CompletenessSection,
} from './SpineSections';
import {
  buildMypageSummary,
  hasBasicProfileContent,
  type MypageSummary,
  type ProgressItem,
  type ProgressState,
  type RecentOutput,
  type NextAction,
  type ScoreStat,
} from './mypageSummary';

// 就活版マイページ = **User Data Hub**（User Data Spine の presentation / editing layer）。
//
//   Layer 1 canonical（localStorage + career_* mirror）
//        ↓ loadCanonicalSourceBundle（1 request 1 snapshot）
//   CareerSourceBundle
//        ├→ buildMypageSpineView   … Data Spine と同一の projection で Layer 2 を組み、表示へ翻訳
//        └→ buildMypageSummary     … 進捗・実績・履歴の集約
//        ↓
//   マイページ UI（志望条件のみ編集可能 → canonical write path → 各 Career AI へ伝播）
//
// 厳守:
//   - マイページ専用のデータ体系（MyPageProfile / mypage localStorage / 専用 table）を作らない。
//   - 表示は実 canonical data 由来のみ。ダミー profile / ダミー insight を作らない。
//   - AI 呼び出しをここで新設しない（mypage_summary purpose は DORMANT のまま）。
//   - /career/home は「機能入口ランチャー」、本ページは「自分のデータの確認・管理」。
//   - 受験版 /mypage のコンポーネント（BillingCard / UsageStatusCard / LoginNudge 等）は流用しない。

// 進捗行のうち、canonical ドキュメント系（基本情報 / 活動整理 / 就活軸）は
// 「データの充実度」セクションが担当するため、進捗セクションからは除外して重複表示を避ける。
const PROGRESS_KEYS_OWNED_BY_COMPLETENESS = ['basic', 'activity', 'values'];

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
  // Layer 1 canonical は external store（localStorage）。SSR / hydration 中は server snapshot(-1)
  // が返るため何も描画しない。保存後は notifyCanonicalSnapshotChanged() で version が進み、
  // 下の useMemo が canonical を読み直す（UI state を真実にしない）。
  const canonicalVersion = useSyncExternalStore(
    subscribeCanonicalSnapshot,
    getCanonicalSnapshotVersion,
    getCanonicalSnapshotServerVersion,
  );

  const bundle = useMemo<CareerSourceBundle | null>(
    () =>
      canonicalVersion < 0 ? null : loadCanonicalSourceBundle(CROSS_FEATURE_SYNC_KINDS),
    [canonicalVersion],
  );

  // 同じ 1 つの snapshot から両方の view を導く（表示間で不整合が起きない）。
  const summary = useMemo<MypageSummary | null>(
    () => (bundle ? buildMypageSummary(bundle) : null),
    [bundle],
  );
  const spine = useMemo<MypageSpineView | null>(
    () => (bundle ? buildMypageSpineView(bundle) : null),
    [bundle],
  );

  if (!summary || !spine) return null;

  const handleSaved = () => notifyCanonicalSnapshotChanged();

  const practiceProgress = summary.progress.filter(
    (p) => !PROGRESS_KEYS_OWNED_BY_COMPLETENESS.includes(p.key),
  );

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
          PASSAI CAREER があなたについて把握している内容を確認・管理できます。
          ここに登録した情報が、ES・面接・プレゼン・GD・企業分析などすべてのAI機能の前提になります。
        </p>
      </div>

      {/* ログイン状態（履歴・クラウド同期の導線） */}
      <div className="mb-6">
        <CareerLoginStatusCard redirect="/career/mypage" />
      </div>

      {/* 契約状態（Stripe）。member 以外・課金未配線では自身で null を返し何も描画しない。 */}
      <div className="mb-6">
        <CareerBillingCard />
      </div>

      {summary.isEmpty ? (
        <div className="space-y-8">
          <EmptyState />

          {/* 空状態でも志望条件は入力できる（ここが canonical な入口）。 */}
          <AspirationCard aspiration={spine.aspiration} onSaved={handleSaved} />
        </div>
      ) : (
        <div className="space-y-8">
          {/* Section A: 本人が明示的に設定する基本プロフィール */}
          <ProfileSection summary={summary} />

          {/* Section A': canonical な志望条件（マイページから編集 → Data Spine → 各 AI） */}
          <AspirationCard aspiration={spine.aspiration} onSaved={handleSaved} />

          {/* Section B: Data Spine から集約した「PASSAI が理解しているあなた」 */}
          <UnderstandingSection facts={spine.understanding} />

          {/* Section C: 経験・活動（活動整理の canonical projection） */}
          <ExperienceSection experience={spine.experience} />

          {/* Section D: 自己分析（最新 canonical 結果のみ。履歴は既存画面へ導線） */}
          <SelfAnalysisSection view={spine.selfAnalysis} />

          {/* データの充実度（決定論・実 canonical data 由来） */}
          <CompletenessSection items={spine.completeness} done={spine.completenessDone} />

          {/* 次にやるべきこと */}
          <NextActionsSection actions={summary.nextActions} />

          {/* 練習・作成の進捗（履歴系のみ。ドキュメント系は充実度セクションが担当） */}
          <ProgressSection items={practiceProgress} />

          {/* 実績サマリー */}
          <AchievementSection summary={summary} />

          {/* 最近のアウトプット */}
          <RecentSection recent={summary.recent} />
        </div>
      )}

      {/* 8. 最近の利用履歴（P9-B: career_user_events の本人向け read path。
          isEmpty 分岐の外に置き、guest/env なし/0 件でも適切なガイドを出す。
          AI prompt / context / body には接続しない本人専用表示）。 */}
      <div className="mt-8">
        <CareerEventTimelineSection />
      </div>

      {/* 9. データ利用の同意（NEXT-7）。既定では API が enabled:false を返すため何も描画されない
          （＝現行 UI は不変）。法務承認 + readiness + 運用 flag が揃ったときだけ現れる。 */}
      <div className="mt-8">
        <CareerConsentCard />
      </div>
    </div>
  );
}

// ── セクション: プロフィール概要 ─────────────────────────────────────

function ProfileSection({ summary }: { summary: MypageSummary }) {
  // 存在ではなく **内容** で判定する（志望条件だけ先に保存した skeleton profile を
  // 「登録済み」に見せない）。
  if (!hasBasicProfileContent(summary.profile)) {
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
      <SectionTitle right={`${doneCount} / ${items.length} 着手`}>練習・作成の進捗</SectionTitle>
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

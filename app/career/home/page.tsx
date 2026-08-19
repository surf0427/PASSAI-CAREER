'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { LinkButton } from '@/components/ui/LinkButton';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import CareerProfileSummary from '@/components/career/CareerProfileSummary';
import type { CareerProfile } from '@/types/careerProfile';
import { isCareerCompanyMatchingUiEnabled } from '@/lib/careerMatchingGate/flag';
import { isCareerGdUiEnabled } from '@/lib/careerGdGate/flag';

// ── 機能カードの定義 ──────────────────────────────────────────────
// 受験版 app/home/page.tsx の FEATURES をそのまま踏襲（title / description）。
// Phase2 時点では就活版の各機能ページがまだ存在しないため、href には遷移させず
// 「準備中（disabled）」表示にする。後続フェーズで /career 配下の実ページへ順次接続する。
const FEATURES = [
  {
    key: 'activity',
    title: '活動整理',
    description: '部活・ボランティア・資格など、これまでの活動を整理します。',
    href: '/career/activity',
  },
  {
    key: 'self-analysis',
    title: '自己分析',
    description: 'AIとの壁打ちを通じて、自分の強みや価値観を深掘りします。',
    href: '/career/self-analysis',
  },
  {
    key: 'values',
    title: '就活軸整理',
    description: '重視する条件・避けたい条件・業界・職種・働き方・社風などをチェック形式で整理し、就活の軸を言語化します。',
    href: '/career/values',
  },
  {
    key: 'company-matching',
    title: '企業マッチングAI',
    description: 'これまでの結果を統合し、企業との相性と「なぜ向いているのか」を可視化します。',
    href: '/career/matching',
  },
  {
    key: 'company-research',
    title: '企業研究',
    description: '自分で調べた企業研究の素材をもとに、AIが企業分析を行い不足や思い込みを指摘します。',
    href: '/career/company-research',
  },
  {
    key: 'es',
    title: 'ES作成',
    description: 'AIのサポートで、ガクチカ・自己PR・志望動機などのESを書き上げます。',
    href: '/career/es',
  },
  {
    key: 'interview',
    title: '面接練習',
    description: '新卒就活の面接官AIと、質問→回答→深掘りのターン形式で練習できます。',
    href: '/career/interview',
  },
  {
    key: 'presentation',
    title: 'プレゼン対策',
    description: '自己PR・ガクチカ・志望動機・ケース課題などの発表を、AIが構成・説得力・具体性・時間配分の観点で評価します。発表後の質疑応答も練習できます。',
    href: '/career/presentation',
  },
  {
    key: 'gd',
    title: 'GD練習',
    description: 'AI参加者とグループディスカッションを実施し、論理性・協調性・議論推進力などを企業選考目線で評価。個別フィードバックと企業評価を受け取れます。',
    href: '/career/gd',
  },
] as const;

// ── おすすめの進め方 ─────────────────────────────────────────────
// Home 上部に固定表示する推奨順。順番そのものが情報なので並び替えないこと。
// href は上記 FEATURES と同じ既存ページのみを参照する（新規 route は作らない）。
const RECOMMENDED_STEPS = [
  { key: 'activity',         label: '活動整理',   href: '/career/activity' },
  { key: 'values',           label: '就活軸整理', href: '/career/values' },
  { key: 'self-analysis',    label: '自己分析',   href: '/career/self-analysis' },
  { key: 'company-matching', label: '企業マッチング', href: '/career/matching' },
  { key: 'company-research', label: '企業研究',   href: '/career/company-research' },
  { key: 'es',               label: 'ES',         href: '/career/es' },
  { key: 'interview',        label: '面接',       href: '/career/interview' },
  { key: 'presentation',     label: 'プレゼン',   href: '/career/presentation' },
  { key: 'gd',               label: 'GD',         href: '/career/gd' },
] as const;

// ── 企業マッチング公開ゲート ──────────────────────────────────────
// 初回リリースでは企業マッチングを出さない（flag OFF が既定）。
// 「準備中」バッジや Coming Soon は出さず、**定義ごと配列から落として存在しない機能として見せる**。
// 番号付き RECOMMENDED_STEPS は filter 後の index で採番されるため連番が飛ばず、
// FEATURES は grid なので 1 枚減ってもレイアウトは崩れない。
// build-time env なので module scope で 1 回だけ評価する（描画ごとの再計算は不要）。
const MATCHING_UI_ENABLED = isCareerCompanyMatchingUiEnabled();

// ── GD 公開ゲート（STEP-GD-31）────────────────────────────────────
// 企業マッチングと同じ扱い: OFF なら「準備中」を出さず **定義ごと配列から落とす**。
// ★ これは導線の可視性だけを制御する。実行権限は server flag（CAREER_GD_ENABLED）が
//   単独で持つため、この値が誤って true でも API は 404 のまま（fail-closed）。
const GD_UI_ENABLED = isCareerGdUiEnabled();

const VISIBLE_FEATURES = FEATURES.filter(
  (f) =>
    (MATCHING_UI_ENABLED || f.key !== 'company-matching') && (GD_UI_ENABLED || f.key !== 'gd'),
);
const VISIBLE_RECOMMENDED_STEPS = RECOMMENDED_STEPS.filter(
  (s) => (MATCHING_UI_ENABLED || s.key !== 'company-matching') && (GD_UI_ENABLED || s.key !== 'gd'),
);

// ── ページ本体 ───────────────────────────────────────────────────

// SSR-stable mount flag（受験版 app/home/page.tsx と同形パターン）。
// hydration 後に true に切り替わり、storage 読み出しを post-hydration に揃える。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerHomePage() {
  const router = useRouter();

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // 就活版 localStorage（careerBasicFormData）を source of truth として派生する。
  //   - SSR / 初回 client render は isMounted=false で null を返し hydration セーフ
  //   - mount 後は就活版 loadBasicInfo() を直接読む（受験版 storage は参照しない）
  const basicInfo = useMemo<CareerProfile | null>(
    () => (isMounted ? loadBasicInfo() : null),
    [isMounted],
  );

  // 基本情報未入力なら就活版 /career/profile へ遷移させる side-effect。
  // 受験版は /input/basic だったが、就活版は /career/profile に置き換える。
  useEffect(() => {
    if (isMounted && !basicInfo) {
      router.replace('/career/profile');
    }
  }, [isMounted, basicInfo, router]);

  if (!isMounted) return null;
  if (!basicInfo) return null; // mount 済 + 未入力。上記 effect で /career/profile へ replace 中

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">

      {/* ユーザー情報 */}
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-gray-800 mb-2">
          こんにちは、{basicInfo.name}さん
        </h1>
        <p className="text-gray-600 text-sm leading-relaxed mb-4">
          自己分析からES・面接対策まで、<br />
          AIが就職活動をサポートします。<br />
          <br />
          あなたに合った企業探しと選考対策を<br />
          一歩ずつ進めましょう。
        </p>
        <CareerProfileSummary profile={basicInfo} />
        <Link
          href="/career/profile"
          className="inline-block border border-gray-300 hover:border-gray-400 text-gray-600 hover:text-gray-800 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          基本情報を編集
        </Link>
      </div>

      {/* おすすめの進め方 — 旧「内定獲得までの進捗」ステッパーを置き換えたセクション。
          初めて使うユーザーが「何からやればいいのか」を一目で把握できるよう、
          RECOMMENDED_STEPS の順番どおりに番号付きで並べる。
          レイアウト: mobile 1 列 → sm 2 列 → lg 3 列（9 項目を 3 段に折り返す）。 */}
      <Card variant="soft" padding="md" className="mb-8">
        <p className="text-xs font-semibold text-brand-600 mb-1">おすすめの進め方</p>
        <p className="text-sm text-gray-600 leading-relaxed mb-4">
          この順番で進めるのがおすすめです。
        </p>
        <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {VISIBLE_RECOMMENDED_STEPS.map((step, i) => (
            <li key={step.key}>
              <Link
                href={step.href}
                className="flex items-center gap-3 rounded-xl border border-blue-100 bg-white px-3 py-2.5 hover:border-brand-200 hover:bg-blue-50/60 transition-colors"
              >
                <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-brand-600 text-white text-xs font-bold">
                  {i + 1}
                </span>
                <span className="text-sm font-medium text-gray-800">{step.label}</span>
              </Link>
            </li>
          ))}
        </ol>
      </Card>

      {/* 機能カード一覧（受験版のメイン機能をそのまま並べる。Phase2 では全て準備中） */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {VISIBLE_FEATURES.map((feature) => {
          // 就活版で実ページが存在する機能だけ href を持つ。href があれば遷移可能カード、
          // 無ければ「準備中（disabled）」のまま表示する。
          const href = 'href' in feature ? feature.href : undefined;
          return (
            <Card
              key={feature.key}
              variant="default"
              padding="md"
              className="flex flex-col gap-3"
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h2 className="text-base font-bold text-gray-800">
                    {feature.title}
                  </h2>
                  {!href && (
                    <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                      準備中
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-500 leading-relaxed">
                  {feature.description}
                </p>
              </div>
              <div className="mt-auto pt-1">
                {href ? (
                  <LinkButton href={href} variant="primary" size="md">
                    はじめる
                  </LinkButton>
                ) : (
                  <Button variant="primary" size="md" disabled>
                    準備中
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/* マイページ（就活ダッシュボード）。進捗・練習履歴・次アクションを集約した
          就活版 /career/mypage へ遷移する（受験版 /mypage には遷移させない）。 */}
      <section className="mt-10">
        <p className="text-xs text-gray-500 mb-3 px-1">就活の振り返り</p>
        <Card variant="soft" padding="md">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold text-gray-800 mb-1.5">マイページ</h2>
              <p className="text-sm text-gray-600 leading-relaxed">
                就活の進捗・練習履歴・次にやることをまとめて確認できます。
              </p>
            </div>
            <div className="shrink-0 sm:self-end">
              <LinkButton href="/career/mypage" variant="outline" size="md">
                マイページを見る →
              </LinkButton>
            </div>
          </div>
        </Card>
      </section>

    </div>
  );
}

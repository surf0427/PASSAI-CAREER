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
    description: '自分で調べた企業研究メモをAIが家庭教師として添削し、不足や思い込みを指摘します。',
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

      {/* 就活の司令塔AI（最上位導線）。入力済みデータを横断し、現在地と次アクションを提案する。
          STEP-CONSULT-05: 相談AIをホーム上部へ昇格。深リンク（?starter=）で相談テーマも渡す。 */}
      <Card
        variant="default"
        padding="md"
        className="mb-8 ring-1 ring-blue-100 bg-blue-50/40"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-brand-600 mb-1">就活の司令塔AI</p>
            <h2 className="text-lg font-bold text-gray-800 mb-1.5">迷ったら、まずここで相談</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              自己分析・ES・面接・GD・企業研究・マッチングを横断して、今の現在地と次にやることを整理します。
              入力済みのデータをもとに、あなたに合った相談テーマも提案します。
            </p>
          </div>
          <div className="shrink-0 sm:self-center">
            <LinkButton href="/career/consultation" variant="primary" size="md">
              相談する →
            </LinkButton>
          </div>
        </div>
        {/* データ状態に沿った入口（深リンク）。押すと相談テーマがプリフィルされる。 */}
        <div className="mt-3 flex flex-wrap gap-2">
          {[
            { label: '何から始めるか整理', starter: 'priority' },
            { label: '就活軸と企業のズレ確認', starter: 'axis' },
            { label: '受ける企業の優先順位', starter: 'matching' },
          ].map((chip) => (
            <Link
              key={chip.starter}
              href={`/career/consultation?starter=${chip.starter}`}
              className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-slate-50 transition-colors"
            >
              {chip.label}
            </Link>
          ))}
        </div>
      </Card>

      {/* 内定獲得までの進捗 — 就活フロー全体の道筋を示すステップカード（固定表示）。
          既存の Card / 配色トークンに合わせ、横並び（wrap）のステッパーで表示する。 */}
      <Card variant="soft" padding="md" className="mb-8">
        <p className="text-xs font-semibold text-brand-600 mb-3">内定獲得までの進捗</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          {['プロフィール', '活動整理', '就活軸整理', '自己分析', 'ES', '面接', '内定'].map(
            (step, i, arr) => (
              <span key={step} className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-full px-3 py-1">
                  {step}
                </span>
                {i < arr.length - 1 && <span className="text-gray-400 text-sm">→</span>}
              </span>
            ),
          )}
        </div>
      </Card>

      {/* AIからの分析コメント（就活版・固定文）＋ 自己分析への CTA。
          受験版の診断フィードバックは参照せず、就活版の固定メッセージを表示する。 */}
      <Card variant="default" padding="md" className="mb-8">
        <p className="text-xs font-semibold text-brand-600 mb-2">AIからの分析コメント</p>
        <div className="space-y-3 text-sm text-gray-700 leading-relaxed mb-4">
          <p>
            今回の内容からは、<br />
            主体的に行動し経験から学びを得るタイプという特徴が見えます。
          </p>
          <p>
            これまでの活動経験は、<br />
            ESや面接で活用できる強みになる可能性があります。
          </p>
          <p>
            今後は自己分析や就活軸整理を進めることで、<br />
            企業選びや志望動機の精度をさらに高められます。
          </p>
        </div>
        <LinkButton href="/career/self-analysis" variant="primary" size="md">
          自己分析を始める →
        </LinkButton>
      </Card>

      {/* キャリア適性診断。強み・価値観から向いている業界・職種の傾向を分析する導線。
          既存の企業マッチング（/career/matching）へ接続する。 */}
      <Card variant="soft" padding="md" className="mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-gray-800 mb-1.5">キャリア適性診断</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              あなたの強みや価値観から、向いている業界・職種の傾向を分析します。
            </p>
          </div>
          <div className="shrink-0 sm:self-center">
            <LinkButton href="/career/matching" variant="primary" size="md">
              キャリア適性診断を受ける
            </LinkButton>
          </div>
        </div>
      </Card>

      {/* 今日やるべきこと（就活版）。各ステップを既存の機能ページへの導線として固定表示する。 */}
      <Card variant="soft" padding="md" className="mb-8">
        <p className="text-xs font-semibold text-brand-600 mb-2">今日やるべきこと</p>
        <ul className="space-y-2">
          {[
            { label: '基本情報を入力する', href: '/career/profile' },
            { label: '活動整理を完了する', href: '/career/activity' },
            { label: '就活軸を整理する', href: '/career/values' },
            { label: '自己分析を実施する', href: '/career/self-analysis' },
            { label: 'おすすめ企業を確認する', href: '/career/matching' },
          ].map((task) => (
            <li key={task.label}>
              <Link
                href={task.href}
                className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900 transition-colors"
              >
                <span className="text-gray-400">□</span>
                {task.label}
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      {/* 機能カード一覧（受験版のメイン機能をそのまま並べる。Phase2 では全て準備中） */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {FEATURES.map((feature) => {
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

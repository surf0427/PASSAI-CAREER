'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { LinkButton } from '@/components/ui/LinkButton';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import type { BasicInfo } from '@/types/basicInfo';

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
    key: 'admission-matching',
    title: '志望校マッチング',
    description: 'あなたのプロフィールに合った志望校を見つけます。',
  },
  {
    key: 'statement',
    title: '志望理由書作成',
    description: 'AIのサポートで志望理由書を書き上げます。',
  },
  {
    key: 'essay',
    title: '小論文練習',
    description: 'テーマに沿って小論文を書き、AIからフィードバックをもらいます。',
  },
  {
    key: 'interview',
    title: '面接練習',
    description: '予想質問の作成や、練習結果の記録・振り返りをします。',
  },
  {
    key: 'presentation',
    title: 'プレゼン対策',
    description: '大学入試のプレゼンテーションを録画し、AIが構成力・説得力・具体性・時間配分を評価します。発表後の質疑応答も練習できます。',
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
  const basicInfo = useMemo<BasicInfo | null>(
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

  const firstPreference = basicInfo.preferences[0];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">

      {/* ユーザー情報 */}
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-gray-800 mb-2">
          こんにちは、{basicInfo.name}さん
        </h1>
        {firstPreference && (
          <p className="text-gray-500 text-sm mb-4">
            第一志望：{firstPreference.university}　{firstPreference.faculty}
          </p>
        )}
        <p className="text-gray-600 text-sm leading-relaxed mb-4">
          総合型選抜（AO・推薦）の対策をAIがサポートします。<br />
          活動整理から志望理由書・面接対策まで、一歩ずつ進めましょう。
        </p>
        <Link
          href="/career/profile"
          className="inline-block border border-gray-300 hover:border-gray-400 text-gray-600 hover:text-gray-800 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          基本情報を編集
        </Link>
      </div>

      {/* 受験タイプ診断（準備中）
          受験版では DiagnosisTypeCard / DiagnosisCtaCard が診断結果や /diagnosis への
          導線を表示するが、就活版では診断機能をまだコピーしていないため、視覚スロットは
          残しつつ準備中プレースホルダーとして無効化する（受験版データは読まない）。 */}
      <Card variant="soft" padding="md" className="mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex-1">
            <h2 className="text-base font-bold text-gray-800 mb-1.5">受験タイプ診断</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              就活版の診断機能は準備中です。順次公開予定です。
            </p>
          </div>
          <div className="shrink-0 sm:self-center">
            <Button variant="outline" size="md" disabled>
              準備中
            </Button>
          </div>
        </div>
      </Card>

      {/* 今日やるべきこと（準備中）
          受験版では進捗ステータス（localStorage）から次に進む機能を案内するが、
          就活版の各機能ページ／進捗ストレージはまだ無いため、まずは基本情報整備へ誘導する。 */}
      <Card variant="soft" padding="md" className="mb-8">
        <p className="text-xs font-semibold text-brand-600 mb-2">今日やるべきこと</p>
        <p className="text-base font-bold text-gray-800 mb-1">
          まずは基本情報を整えておきましょう。
        </p>
        <p className="text-sm text-gray-600 mb-4">
          各機能は順次公開予定です。基本情報を最新にしておくと、公開後すぐに使い始められます。
        </p>
        <LinkButton href="/career/profile" variant="primary" size="md">
          基本情報を編集する
        </LinkButton>
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

      {/* マイページ（準備中）。受験版では /mypage へ遷移するが就活版は未コピー。 */}
      <section className="mt-10">
        <p className="text-xs text-gray-500 mb-3 px-1">学習の振り返り</p>
        <Card variant="soft" padding="md">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="flex-1">
              <h2 className="text-base font-bold text-gray-800 mb-1.5">マイページ</h2>
              <p className="text-sm text-gray-600 leading-relaxed">
                学習の積み重ねとスコア推移を見る
              </p>
            </div>
            <div className="shrink-0 sm:self-end">
              <Button variant="outline" size="md" disabled>
                準備中
              </Button>
            </div>
          </div>
        </Card>
      </section>

      {/* チューターAI（準備中）。受験版では /tutor へ遷移するが就活版は未コピー。 */}
      <section className="mt-10">
        <p className="text-xs text-gray-500 mb-3 px-1">詰まった時の整理</p>
        <Card variant="soft" padding="md">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="flex-1">
              <h2 className="text-base font-bold text-gray-800 mb-1.5">就活チューターAI</h2>
              <p className="text-sm text-gray-600 leading-relaxed">
                志望動機・面接・不安など、今引っかかっていることを軽く整理して、次に何を進めるか一緒に見ます。
              </p>
            </div>
            <div className="shrink-0 sm:self-end">
              <Button variant="outline" size="md" disabled>
                準備中
              </Button>
            </div>
          </div>
        </Card>
      </section>

    </div>
  );
}

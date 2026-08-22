'use client';

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import CareerProfileSummary from '@/components/career/CareerProfileSummary';
import CareerLoginStatusCard from '@/app/career/components/CareerLoginStatusCard';
import CareerBillingCard from '@/app/career/components/CareerBillingCard';
// NEXT-7: 同意取得カード。gate（運用 flag + 法務承認 + readiness）が閉じている間は null を返し何も描画しない。
import CareerConsentCard from './CareerConsentCard';
// User Data Spine Layer 1 の canonical bundle loader（server reader と同じ CareerSourceBundle 型）。
import { loadCanonicalSourceBundle } from '@/app/career/sourceSyncClient';
import {
  subscribeCanonicalSnapshot,
  getCanonicalSnapshotVersion,
  getCanonicalSnapshotServerVersion,
} from './canonicalSnapshotStore';
import { CROSS_FEATURE_SYNC_KINDS } from '@/lib/careerSourceSync/kinds';
import type { CareerSourceBundle } from '@/lib/careerSourceData/types';
import type { CareerProfile } from '@/types/careerProfile';
import { hasBasicProfileContent } from './mypageSummary';

// 就活版マイページ = **View 専用画面**。
//
//   Layer 1 canonical（localStorage + career_* mirror）
//        ↓ loadCanonicalSourceBundle（1 request 1 snapshot）
//   CareerSourceBundle
//        ↓
//   「いま PASSAI CAREER に保存されている自分の情報」の確認表示
//
// 厳守:
//   - マイページ専用のデータ体系（MyPageProfile / mypage localStorage / 専用 table）を作らない。
//   - 表示は実 canonical data 由来のみ。ダミー profile / ダミー insight を作らない。
//   - AI 呼び出しをここで新設しない（mypage_summary purpose は DORMANT のまま）。
//   - ここは dashboard ではない。次のアクション提案・実績/履歴/アウトプットの一覧・
//     充実度メーター・各機能への CTA は持たない（機能入口は /career/home が担当）。
//   - 受験版 /mypage のコンポーネント（BillingCard / UsageStatusCard / LoginNudge 等）は流用しない。

export default function CareerMypagePage() {
  // Layer 1 canonical は external store（localStorage）。SSR / hydration 中は server snapshot(-1)
  // が返るため何も描画しない。canonical が更新されると version が進み、下の useMemo が読み直す
  // （UI state を真実にしない）。
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

  if (!bundle) return null;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
      {/* ヘッダー */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">マイページ</h1>
          <Link
            href="/career/home"
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            ← ホーム
          </Link>
        </div>
        <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
          いま PASSAI CAREER に登録されているあなたの情報と、アカウントの状態を確認できます。
        </p>
      </div>

      {/* 以下はすべて「現在の登録内容の確認」。描画対象が無いカードは自身で null を返すため、
          wrapper を挟まず space-y で並べて空セクション・二重余白を作らない。 */}
      <div className="space-y-6">
        {/* ログイン状態 */}
        <CareerLoginStatusCard redirect="/career/mypage" />

        {/* 契約状態（Stripe）。member 以外・課金未配線では自身で null を返し何も描画しない。 */}
        <CareerBillingCard />

        {/* 登録済みの基本情報 */}
        <ProfileSection profile={bundle.profile} />

        {/* データ利用の同意（NEXT-7）。既定では API が enabled:false を返すため何も描画されない。
            法務承認 + readiness + 運用 flag が揃ったときだけ現れる。 */}
        <CareerConsentCard />
      </div>
    </div>
  );
}

// ── セクション: 基本情報（登録済み内容の確認） ───────────────────────

function ProfileSection({ profile }: { profile: CareerProfile | null }) {
  // 存在ではなく **内容** で判定する（志望条件だけ先に保存した skeleton profile を
  // 「登録済み」に見せない）。
  if (!hasBasicProfileContent(profile)) {
    return (
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <h2 className="text-sm font-semibold text-brand-600">プロフィール</h2>
        </div>
        <Card variant="default" padding="md">
          <p className="text-sm text-gray-600 mb-3">基本情報がまだ登録されていません。</p>
          <LinkButton href="/career/profile" variant="primary" size="md">
            基本情報を入力する
          </LinkButton>
        </Card>
      </section>
    );
  }
  return <CareerProfileSummary profile={profile} editHref="/career/profile" />;
}

'use client';

// PASSAI 就活版 — 企業詳細（/career/company/[companyId]）。Company Data Spine Phase A / R2。
//
// 本 slice の役割は「登録済み企業のハブ」まで:
//   - 企業名の表示（server の企業マスタが canonical。表示キャッシュへ fallback）
//   - 自分の情報（企業研究）への導線
//   - この企業で ES / 面接 / プレゼンを始める導線
//
// ★ Official Sourced Facts（公式情報の取得・表示）は **本 slice では作らない**（R7 scope）。
//   情報が無い状態でもページとして成立させる（空状態でよい）。

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { lookupCompanyById } from '../companyClient';
import { lookupCompanyDisplayName } from '../companyDirectory';
import { CompanyApplicationCard } from './CompanyApplicationCard';

// マウント前 false / マウント後 true（他ページと同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerCompanyDetailPage() {
  const params = useParams<{ companyId: string }>();
  const companyId = useMemo(() => {
    const raw = params?.companyId;
    return typeof raw === 'string' ? decodeURIComponent(raw) : '';
  }, [params]);

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // 表示キャッシュ（同期・offline でも読める）を初期表示に使う。
  const cachedName = useMemo(
    () => (isMounted && companyId ? lookupCompanyDisplayName(companyId) : ''),
    [isMounted, companyId],
  );

  // server の企業マスタが canonical。取れたら上書きする（外部システムとの同期なので effect）。
  // setState は非同期コールバック内だけで行う（同期 setState を effect body に置かない）。
  const [serverName, setServerName] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!isMounted || !companyId) return;
    let cancelled = false;
    void lookupCompanyById(companyId).then((res) => {
      if (cancelled) return;
      if (res.available && res.data) setServerName(res.data.displayName);
      setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isMounted, companyId]);

  // companyId が無いケースはマウント時点で確定（取得を待たない）。
  const loaded = companyId ? checked : isMounted;
  const displayName = serverName ?? cachedName;
  const title = displayName || (loaded ? '（名称を取得できませんでした）' : '読み込み中…');

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title={title} description="この企業の情報と、各機能への入口です。" />

      {loaded && !displayName && (
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-xs text-slate-500 leading-relaxed">
            企業名を取得できませんでした（未ログイン・通信不可・企業が削除された等）。
            各機能では企業名を直接入力してそのまま利用できます。
          </p>
        </Card>
      )}

      {/* Application Context（R6）: 応募職種 / 選考年度 / 選考段階 / 志望度 */}
      {companyId && <CompanyApplicationCard companyId={companyId} />}

      <Card variant="soft" padding="md" className="mb-5">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">自分の情報</p>
        <p className="text-xs text-slate-500 leading-relaxed mb-3">
          説明会・OB/OG訪問・インターン・社員との会話・配布資料など、あなた自身が得た情報は
          企業研究に記録します。記録した内容はあなただけが利用します。
        </p>
        <Link
          href={`/career/company-research/do?companyId=${encodeURIComponent(companyId)}${
            displayName ? `&companyName=${encodeURIComponent(displayName)}` : ''
          }`}
          className="inline-flex items-center gap-1 text-sm font-semibold text-blue-700 hover:text-blue-900"
        >
          企業研究に記録する →
        </Link>
      </Card>

      <Card variant="soft" padding="md" className="mb-5">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">この企業で</p>
        <div className="flex flex-col gap-2">
          <FeatureLink href="/career/es" label="ESを書く" />
          <FeatureLink href="/career/interview/target" label="面接練習をする" />
          <FeatureLink href="/career/presentation/target" label="プレゼン対策をする" />
          <FeatureLink href="/career/company-research" label="企業研究を見る" />
        </div>
      </Card>

      <Link
        href="/career/company"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
      >
        ← 企業一覧に戻る
      </Link>
    </div>
  );
}

function FeatureLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="block rounded-xl bg-white ring-1 ring-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 transition-colors"
    >
      {label}
    </Link>
  );
}

'use client';

// PASSAI 就活版 — 企業一覧（/career/company）。Company Data Spine Phase A / R2。
//
// 役割: 「この端末で使った登録済み企業」の一覧と、新規登録への入口。
//   - 一覧の元は表示キャッシュ（careerCompanyDirectory）。canonical は server の企業マスタ。
//   - Official Sourced Facts（企業公式情報の取得）は **本 slice では実装しない**。
//   - 分析ダッシュボード・スコア・推薦などは作らない（MVP scope 外）。
//
// DB / AI / 課金には接続しない（企業マスタの read は詳細ページ側の API 経由）。

import { useMemo, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { LinkButton } from '@/components/ui/LinkButton';
import { loadCompanyDirectory } from './companyDirectory';
import type { CareerCompanyDirectoryEntry } from '@/types/careerCompanyIdentity';

// マウント前 false / マウント後 true（他ページと同じ SSR 安全パターン）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerCompanyListPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );
  const entries = useMemo<CareerCompanyDirectoryEntry[] | null>(
    () => (isMounted ? loadCompanyDirectory() : null),
    [isMounted],
  );

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="企業"
        description="一度登録した企業は、ES・面接練習・プレゼン対策・企業研究から選ぶだけで使えます。"
      />

      <div className="mb-5">
        <LinkButton href="/career/company/new" variant="primary" size="md">
          企業を追加する
        </LinkButton>
      </div>

      {entries === null ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : entries.length === 0 ? (
        <Card variant="soft" padding="md">
          <p className="text-sm font-bold text-slate-800 mb-1.5">
            まだ登録した企業はありません
          </p>
          <p className="text-xs text-slate-500 leading-relaxed">
            企業を登録すると、ES・面接・プレゼン・企業研究で企業名を毎回入力しなくてよくなります。
            登録しなくても、各機能で企業名を直接入力して進めることもできます。
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((e) => (
            <li key={e.companyId}>
              <Link
                href={`/career/company/${encodeURIComponent(e.companyId)}`}
                className="block rounded-xl bg-white ring-1 ring-slate-200 px-4 py-3 hover:bg-slate-50 transition-colors"
              >
                <p className="text-sm font-semibold text-slate-800 break-words">
                  {e.displayName || '（名称不明）'}
                </p>
                {e.lastUsedAt && (
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    最終利用 {formatDate(e.lastUsedAt)}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6">
        <Link
          href="/career/home"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
        >
          ← ホームに戻る
        </Link>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ja-JP');
}

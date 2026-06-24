'use client';

// PASSAI 就活版 — 自己分析AI 実行画面（最小版）
//
// 入力: careerBasicFormData（基本情報）/ careerActivityFormData（活動整理）を localStorage から読む。
// 実行: /api/career/self-analysis を呼び、結果を careerSelfAnalysisLogs に保存して結果画面へ遷移する。
// DB / 課金 / usage には接続しない（localStorage のみ）。

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData } from '@/app/career/activity/activityStorage';
import { appendSelfAnalysisLog } from '../selfAnalysisStorage';
import type { BasicInfo } from '@/types/basicInfo';
import type { ActivityData } from '@/types/activity';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';

// マウント前 false / マウント後 true（hub と同じ SSR 安全パターン）。
// SSR では localStorage を読まず、hydration 後に useMemo を再評価させる。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

// SSR / 旧 runtime fallback 付き UUID（lib/tutorChatStorage.ts と同方針）。
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `csa-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// activity の各カテゴリ配列に 1 件でも入っていれば「活動あり」とみなす。
function hasAnyActivity(activity: ActivityData | null): boolean {
  if (!activity) return false;
  return Object.values(activity).some((v) => Array.isArray(v) && v.length > 0);
}

export default function CareerSelfAnalysisRunPage() {
  const router = useRouter();
  const [userInput, setUserInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // localStorage は client でのみ読む（hydration 後に useMemo を再評価）。
  const basicInfo = useMemo<BasicInfo | null>(
    () => (isMounted ? loadBasicInfo() : null),
    [isMounted],
  );
  const activity = useMemo<ActivityData | null>(
    () => (isMounted ? loadActivityData() : null),
    [isMounted],
  );

  const profileReady = !!basicInfo;
  const activityReady = hasAnyActivity(activity);
  const canRun = profileReady || activityReady;

  async function handleRun() {
    if (!canRun || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/career/self-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: basicInfo,
          activity,
          userInput,
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '自己分析の生成に失敗しました。');
      }

      const data = (await res.json()) as { result: CareerSelfAnalysisResult };
      appendSelfAnalysisLog({
        id: newId(),
        // ISO 文字列（表示・ソート用）。
        createdAt: new Date().toISOString(),
        userInput: userInput.trim(),
        result: data.result,
      });

      router.push('/career/self-analysis/result');
    } catch (e) {
      setError(e instanceof Error ? e.message : '自己分析の生成に失敗しました。');
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="自己分析AIを実行"
        description="登録済みの基本情報と活動整理をもとに、就活向けの自己分析を生成します。"
      />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">入力データ</p>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <ReadyItem label="基本情報" ready={profileReady} href="/career/profile" />
          <ReadyItem label="活動整理" ready={activityReady} href="/career/activity" />
        </div>
        {!canRun && (
          <p className="mt-4 text-xs text-amber-700 leading-relaxed">
            基本情報または活動整理のいずれかを入力すると実行できます。
          </p>
        )}
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <label className="block text-sm font-bold text-slate-800 mb-2">
          相談・補足（任意）
        </label>
        <Textarea
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          placeholder="例: 志望業界に向けて、自分の強みをどう言語化すればいいか整理したい。"
          rows={4}
          disabled={loading}
        />
      </Card>

      {error && (
        <p className="mb-4 text-sm text-red-600 leading-relaxed" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <Button
          variant="primary"
          size="md"
          onClick={handleRun}
          disabled={!canRun || loading}
          className="w-full sm:w-auto"
        >
          {loading ? '生成中…' : '自己分析を生成する →'}
        </Button>
        <Link
          href="/career/self-analysis"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← 自己分析トップに戻る
        </Link>
      </div>
    </div>
  );
}

function ReadyItem({ label, ready, href }: { label: string; ready: boolean; href: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500 mb-0.5">{label}</p>
      {ready ? (
        <p className="text-sm font-semibold text-emerald-700">入力あり</p>
      ) : (
        <Link href={href} className="text-sm font-semibold text-blue-600 hover:underline">
          未入力（入力する →）
        </Link>
      )}
    </div>
  );
}

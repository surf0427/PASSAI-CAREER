'use client';

// PASSAI 就活版 — 企業マッチングAI 開始画面。
// 各機能の結果（入力データ）を確認 → 実行 → 結果を careerMatchingResults に保存 → result へ遷移。
// DB / 課金 / usage 非接続（localStorage のみ）。

import { Suspense, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import {
  loadActivityData,
  hasAnyActivity,
} from '@/app/career/activity/activityStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadEsLogs } from '@/app/career/es/esStorage';
import { loadInterviewResults } from '@/app/career/interview/interviewStorage';
import { loadConsultationThreads } from '@/app/career/consultation/consultationStorage';
import { loadCareerValues } from '@/app/career/values/careerValuesStorage';
import { loadGdResults } from '@/app/career/gd/gdStorage';
import {
  buildLatestGdMatchingSnapshot,
  buildGdMatchingSnapshotById,
} from '@/lib/careerGd/context';
import { appendMatchingLog } from './matchingStorage';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import { upsertCareerMatchingResultsToSupabase } from '@/lib/supabase/careerMatching';
import type { CareerConsultationResult } from '@/types/careerConsultation';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cmatch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// 直近の就活相談（最新スレッドの最後の assistant 結果）を取り出す。
function latestConsultationResult(): CareerConsultationResult | null {
  const threads = loadConsultationThreads();
  if (threads.length === 0) return null;
  const messages = threads[0].messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.result) return m.result;
  }
  return null;
}

// マッチングAIに渡す統合コンテキストを localStorage から組み立てる。
// gdResultId があればその GD 結果を優先し、無い/見つからない場合は最新にフォールバックする。
function buildMatchingContext(gdResultId?: string | null) {
  const selfLogs = loadSelfAnalysisLogs();
  const esLogs = loadEsLogs();
  const interviewResults = loadInterviewResults();
  const gdResults = loadGdResults();
  const gdSnapshot =
    (gdResultId ? buildGdMatchingSnapshotById(gdResults, gdResultId) : null) ??
    buildLatestGdMatchingSnapshot(gdResults);
  return {
    profile: loadBasicInfo(),
    activity: loadActivityData(),
    values: loadCareerValues(),
    selfAnalysis: selfLogs.length > 0 ? selfLogs[0].result : null,
    es: esLogs.length > 0 ? esLogs[0].result : null,
    interviewResult: interviewResults.length > 0 ? interviewResults[0].result : null,
    consultation: latestConsultationResult(),
    // GD 練習結果を補助文脈として渡す。主情報ではなく参考扱い。
    gdSnapshot,
  };
}

type Readiness = {
  profile: boolean;
  activity: boolean;
  selfAnalysis: boolean;
  es: boolean;
  interview: boolean;
  consultation: boolean;
  gd: boolean;
};

function CareerMatchingStartInner() {
  const router = useRouter();
  const userId = useCurrentUserId();
  const searchParams = useSearchParams();
  const gdResultId = searchParams.get('gdResultId');
  const [userInput, setUserInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const readiness = useMemo<Readiness | null>(() => {
    if (!isMounted) return null;
    const ctx = buildMatchingContext(gdResultId);
    return {
      profile: !!ctx.profile,
      activity: hasAnyActivity(ctx.activity),
      selfAnalysis: !!ctx.selfAnalysis,
      es: !!ctx.es,
      interview: !!ctx.interviewResult,
      consultation: !!ctx.consultation,
      gd: !!ctx.gdSnapshot,
    };
  }, [isMounted, gdResultId]);

  // マッチングは判断材料が必要。基本情報・活動・自己分析のいずれかがあれば実行可。
  const canRun =
    !!readiness && (readiness.profile || readiness.activity || readiness.selfAnalysis);

  async function handleRun() {
    if (!canRun || loading) return;
    setLoading(true);
    setError(null);
    try {
      const ctx = buildMatchingContext(gdResultId);
      const res = await fetch('/api/career/matching', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...ctx, userInput }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'マッチングの生成に失敗しました。');
      }
      const data = (await res.json()) as { result: CareerMatchEngineResult };
      const log = {
        id: newId(),
        createdAt: new Date().toISOString(),
        userInput: userInput.trim(),
        result: data.result,
      };
      appendMatchingLog(log);
      // Supabase durable mirror（best-effort / member のみ）。
      if (userId) void upsertCareerMatchingResultsToSupabase(userId, [log]);
      router.push('/career/matching/result');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'マッチングの生成に失敗しました。');
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="企業マッチングAI"
        description="これまでの結果を統合し、企業との相性と「なぜ向いているのか」を可視化します。"
      />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">統合する入力データ</p>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <ReadyItem label="基本情報" ready={readiness?.profile} href="/career/profile" />
          <ReadyItem label="活動整理" ready={readiness?.activity} href="/career/activity" />
          <ReadyItem label="自己分析" ready={readiness?.selfAnalysis} href="/career/self-analysis" />
          <ReadyItem label="ES" ready={readiness?.es} href="/career/es" />
          <ReadyItem label="面接結果" ready={readiness?.interview} href="/career/interview" />
          <ReadyItem label="就活相談" ready={readiness?.consultation} href="/career/consultation" />
          <ReadyItem label="GD結果" ready={readiness?.gd} href="/career/gd" />
        </div>
        {readiness && !canRun && (
          <p className="mt-4 text-xs text-amber-700 leading-relaxed">
            基本情報・活動整理・自己分析のいずれかを入力するとマッチングを実行できます。
          </p>
        )}
        {canRun && (
          <p className="mt-4 text-xs text-slate-500 leading-relaxed">
            入力データが多いほど、相性の根拠がより具体的になります。
          </p>
        )}
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <label className="block text-sm font-bold text-slate-800 mb-2">
          志望の方向性メモ（任意）
        </label>
        <Textarea
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          placeholder="例: 裁量の大きい環境で成長したい。BtoC か無形商材に興味がある。"
          rows={3}
          disabled={loading}
        />
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-xs text-slate-500 leading-relaxed">
          ※ 実在する日本国内企業を中心に、大手・ベンチャーを偏らせず業界を分散して提案します。
          根拠が弱い場合は「（候補）」と明記し、年収・福利厚生などの待遇は断定しません。
        </p>
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
          {loading ? 'マッチング中…' : 'マッチングを開始する →'}
        </Button>
        <Link
          href="/career/matching/result"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          過去の結果を見る
        </Link>
      </div>

      <div className="mt-8">
        <Link
          href="/career/home"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← ホームに戻る
        </Link>
      </div>
    </div>
  );
}

function ReadyItem({
  label,
  ready,
  href,
}: {
  label: string;
  ready: boolean | undefined;
  href: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500 mb-0.5">{label}</p>
      {ready === undefined ? (
        <p className="text-sm font-semibold text-slate-400">—</p>
      ) : ready ? (
        <p className="text-sm font-semibold text-emerald-700">入力あり</p>
      ) : (
        <Link href={href} className="text-sm font-semibold text-blue-600 hover:underline">
          未入力（入力する →）
        </Link>
      )}
    </div>
  );
}

export default function CareerMatchingStartPage() {
  return (
    <Suspense fallback={null}>
      <CareerMatchingStartInner />
    </Suspense>
  );
}

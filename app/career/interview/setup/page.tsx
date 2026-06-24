'use client';

// PASSAI 就活版 — 面接AI setup 画面。
// 入力データの確認 + モード選択（テキスト / 音声）→ start API → セッション作成 → session へ遷移。

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import {
  buildInterviewContextPayload,
  hasAnyActivity,
  type CareerInterviewContextPayload,
} from '../contextSource';
import { upsertInterviewSession } from '../interviewStorage';
import { useVoice } from '../useVoice';
import type { CareerInterviewMode, CareerInterviewSession } from '@/types/careerInterview';

// 回答ターン上限（サーバ CAREER_INTERVIEW_MAX_TURNS=5 と一致。進行バー表示に使う）。
const MAX_TURNS = 5;

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cint-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export default function CareerInterviewSetupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<CareerInterviewMode>('text');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { sttSupported } = useVoice();

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const ctx = useMemo<CareerInterviewContextPayload | null>(
    () => (isMounted ? buildInterviewContextPayload() : null),
    [isMounted],
  );

  const profileReady = !!ctx?.profile;
  const activityReady = hasAnyActivity(ctx?.activity ?? null);
  const selfAnalysisReady = !!ctx?.selfAnalysis;
  const esReady = !!ctx?.es;
  const canStart = profileReady || activityReady;

  async function handleStart() {
    if (!canStart || loading || !ctx) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/career/interview/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ctx),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '面接の開始に失敗しました。');
      }
      const data = (await res.json()) as { question: string };

      const now = new Date().toISOString();
      // 音声モードは Web Speech 非対応なら text に倒す。
      const effectiveMode: CareerInterviewMode =
        mode === 'voice' && !sttSupported ? 'text' : mode;
      const session: CareerInterviewSession = {
        id: newId(),
        createdAt: now,
        updatedAt: now,
        status: 'in_progress',
        mode: effectiveMode,
        turns: [{ role: 'question', content: data.question }],
        maxTurns: MAX_TURNS,
      };
      upsertInterviewSession(session);
      router.push('/career/interview/session');
    } catch (e) {
      setError(e instanceof Error ? e.message : '面接の開始に失敗しました。');
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="面接の準備" description="モードを選んで面接を始めます。" />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">入力データ</p>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <ReadyItem label="基本情報" ready={profileReady} href="/career/profile" />
          <ReadyItem label="活動整理" ready={activityReady} href="/career/activity" />
          <ReadyItem label="自己分析" ready={selfAnalysisReady} href="/career/self-analysis" />
          <ReadyItem label="ES" ready={esReady} href="/career/es" />
        </div>
        {!canStart && (
          <p className="mt-4 text-xs text-amber-700 leading-relaxed">
            基本情報または活動整理のいずれかを入力すると面接を始められます。
          </p>
        )}
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">回答モード</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ModeOption
            label="テキストで回答"
            description="キーボードで回答を入力します。"
            active={mode === 'text'}
            onClick={() => setMode('text')}
          />
          <ModeOption
            label="音声で回答"
            description={
              sttSupported
                ? 'マイクで話して回答します（ブラウザの音声認識）。'
                : 'お使いのブラウザは音声認識に未対応のため、テキストで回答します。'
            }
            active={mode === 'voice'}
            disabled={!sttSupported}
            onClick={() => sttSupported && setMode('voice')}
          />
        </div>
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
          onClick={handleStart}
          disabled={!canStart || loading}
          className="w-full sm:w-auto"
        >
          {loading ? '準備中…' : '面接を始める →'}
        </Button>
        <Link
          href="/career/interview"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← 面接トップに戻る
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

function ModeOption({
  label,
  description,
  active,
  disabled,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const base = 'w-full text-left rounded-xl ring-1 p-4 transition-colors';
  const cls = disabled
    ? `${base} ring-slate-200 bg-slate-50 opacity-60 cursor-not-allowed`
    : active
      ? `${base} ring-blue-500 bg-blue-50`
      : `${base} ring-slate-200 bg-white hover:bg-slate-50`;
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cls}>
      <p className="text-sm font-bold text-slate-900 mb-1">{label}</p>
      <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
    </button>
  );
}

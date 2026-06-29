'use client';

// PASSAI 就活版 — プレゼン対策AI setup 画面。
// プレゼンの種類 + テーマ（手動 / AI即興生成）+ 制限時間 + 入力モードを選び、セッションを作成して session へ。

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import {
  buildPresentationContextPayload,
  type CareerPresentationContextPayload,
} from '../contextSource';
import { upsertPresentationSession } from '../presentationStorage';
import { useVoice } from '@/app/career/interview/useVoice';
import {
  CAREER_PRESENTATION_MODES,
  CAREER_PRESENTATION_TIME_LIMITS,
  DEFAULT_CAREER_PRESENTATION_TYPE,
  getPresentationModeConfig,
} from '../presentationModes';
import type {
  CareerPresentationMode,
  CareerPresentationSession,
  CareerPresentationType,
} from '@/types/careerPresentation';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cprez-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export default function CareerPresentationSetupPage() {
  const router = useRouter();
  const [presentationType, setPresentationType] = useState<CareerPresentationType>(
    DEFAULT_CAREER_PRESENTATION_TYPE,
  );
  const [theme, setTheme] = useState('');
  const [timeLimitSec, setTimeLimitSec] = useState<number>(180);
  const [mode, setMode] = useState<CareerPresentationMode>('voice');
  const [generating, setGenerating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { sttSupported } = useVoice();

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const ctx = useMemo<CareerPresentationContextPayload | null>(
    () => (isMounted ? buildPresentationContextPayload() : null),
    [isMounted],
  );

  const config = getPresentationModeConfig(presentationType);

  async function handleGenerateTheme() {
    if (generating || !ctx) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/career/presentation/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...ctx, presentationType }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'テーマの生成に失敗しました。');
      }
      const data = (await res.json()) as { theme: string };
      setTheme(data.theme);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'テーマの生成に失敗しました。');
    } finally {
      setGenerating(false);
    }
  }

  function handleStart() {
    if (loading) return;
    if (!theme.trim()) {
      setError('発表テーマを入力するか、AIに生成してもらってください。');
      return;
    }
    setLoading(true);
    setError(null);
    // 音声モードは Web Speech 非対応なら text に倒す。
    const effectiveMode: CareerPresentationMode =
      mode === 'voice' && !sttSupported ? 'text' : mode;
    const now = new Date().toISOString();
    const session: CareerPresentationSession = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      status: 'in_progress',
      presentationType,
      mode: effectiveMode,
      theme: theme.trim(),
      timeLimitSec,
      durationSec: 0,
      transcript: '',
    };
    upsertPresentationSession(session);
    router.push('/career/presentation/session');
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="プレゼンの準備" description="種類・テーマ・制限時間を選んで発表を始めます。" />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">プレゼンの種類</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {CAREER_PRESENTATION_MODES.map((m) => (
            <TypeOption
              key={m.type}
              emoji={m.emoji}
              label={m.label}
              description={m.description}
              recommended={m.recommendedData}
              active={presentationType === m.type}
              onClick={() => setPresentationType(m.type)}
            />
          ))}
        </div>
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest">発表テーマ</p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerateTheme}
            disabled={generating || !ctx}
          >
            {generating ? '生成中…' : '🤖 AIにテーマを提案してもらう'}
          </Button>
        </div>
        <Textarea
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          placeholder={config.themePlaceholder}
          rows={2}
        />
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">制限時間</p>
        <div className="flex flex-wrap gap-2">
          {CAREER_PRESENTATION_TIME_LIMITS.map((t) => (
            <button
              key={t.sec}
              type="button"
              onClick={() => setTimeLimitSec(t.sec)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold ring-1 transition-colors ${
                timeLimitSec === t.sec
                  ? 'ring-blue-500 bg-blue-50 text-blue-700'
                  : 'ring-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">入力モード</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ModeOption
            label="音声で発表"
            description={
              sttSupported
                ? 'マイクで話して発表します（ブラウザの音声認識で文字起こし）。'
                : 'お使いのブラウザは音声認識に未対応のため、テキスト入力になります。'
            }
            active={mode === 'voice'}
            disabled={!sttSupported}
            onClick={() => sttSupported && setMode('voice')}
          />
          <ModeOption
            label="テキストで発表"
            description="発表原稿を入力・貼り付けして評価します。"
            active={mode === 'text'}
            onClick={() => setMode('text')}
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
          disabled={loading}
          className="w-full sm:w-auto"
        >
          {loading ? '準備中…' : '発表を始める →'}
        </Button>
        <Link
          href="/career/presentation"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← プレゼントップに戻る
        </Link>
      </div>
    </div>
  );
}

function TypeOption({
  emoji,
  label,
  description,
  recommended,
  active,
  onClick,
}: {
  emoji: string;
  label: string;
  description: string;
  recommended: string;
  active: boolean;
  onClick: () => void;
}) {
  const base = 'w-full text-left rounded-xl ring-1 p-4 transition-colors';
  const cls = active
    ? `${base} ring-blue-500 bg-blue-50`
    : `${base} ring-slate-200 bg-white hover:bg-slate-50`;
  return (
    <button type="button" onClick={onClick} className={cls}>
      <p className="text-sm font-bold text-slate-900 mb-1">
        <span aria-hidden className="mr-1">
          {emoji}
        </span>
        {label}
      </p>
      <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
      <p className="mt-1.5 text-[11px] text-slate-400">活きるデータ: {recommended}</p>
    </button>
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

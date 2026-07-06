'use client';

// PASSAI 就活版 — プレゼン対策AI setup 画面（お題ベース）。
// 就活・選考で出される「お題」に対して発表する形式。最重要は「お題」と「発表時間」。
// 想定シーン・企業/業界/職種・発表形式・評価観点・補足メモは任意（画面を重くしない）。
// お題は手動入力 or AIに提案してもらう。セッションを作成して session へ。

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
import { useCurrentUserId } from '@/app/components/AuthProvider';
import { upsertCareerPresentationSessionsToSupabase } from '@/lib/supabase/careerPresentation';
import { useVoice } from '@/app/career/interview/useVoice';
import {
  CAREER_PRESENTATION_TIME_LIMITS,
  CAREER_PRESENTATION_SCENARIOS,
  CAREER_PRESENTATION_FORMATS,
  CAREER_PRESENTATION_EVAL_FOCUS,
  CAREER_PRESENTATION_DIFFICULTIES,
  DEFAULT_CAREER_PRESENTATION_SCENARIO,
  getScenarioConfig,
} from '../presentationModes';
import type {
  CareerPresentationMode,
  CareerPresentationSession,
  CareerPresentationScenario,
  CareerPresentationFormat,
  CareerPresentationConfig,
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
  const userId = useCurrentUserId();

  // 最重要（お題・発表時間）。
  const [theme, setTheme] = useState('');
  const [timeLimitSec, setTimeLimitSec] = useState<number>(180);

  // 任意設定（想定シーン・企業/業界/職種・発表形式・評価観点・補足メモ）。
  const [scenario, setScenario] = useState<CareerPresentationScenario>(
    DEFAULT_CAREER_PRESENTATION_SCENARIO,
  );
  const [companyName, setCompanyName] = useState('');
  const [industry, setIndustry] = useState('');
  const [jobType, setJobType] = useState('');
  const [format, setFormat] = useState<CareerPresentationFormat>('unspecified');
  const [evaluationFocus, setEvaluationFocus] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [difficulty, setDifficulty] = useState<'easy' | 'standard' | 'hard'>('standard');
  const [showDetails, setShowDetails] = useState(false);

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

  // 現在の入力から config を組み立てる（空値は入れない）。
  function buildConfig(): CareerPresentationConfig {
    const cfg: CareerPresentationConfig = { scenario };
    if (companyName.trim()) cfg.companyName = companyName.trim();
    if (industry.trim()) cfg.industry = industry.trim();
    if (jobType.trim()) cfg.jobType = jobType.trim();
    if (format !== 'unspecified') cfg.format = format;
    if (evaluationFocus.length > 0) cfg.evaluationFocus = evaluationFocus;
    if (note.trim()) cfg.note = note.trim();
    return cfg;
  }

  function toggleFocus(key: string) {
    setEvaluationFocus((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  async function handleGenerateTheme() {
    if (generating || !ctx) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch('/api/career/presentation/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...ctx, config: buildConfig(), timeLimitSec, difficulty }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'お題の生成に失敗しました。');
      }
      const data = (await res.json()) as { theme: string };
      setTheme(data.theme);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'お題の生成に失敗しました。');
    } finally {
      setGenerating(false);
    }
  }

  function handleStart() {
    if (loading) return;
    if (!theme.trim()) {
      setError('お題を入力するか、AIに提案してもらってください。');
      return;
    }
    setLoading(true);
    setError(null);
    // 音声モードは Web Speech 非対応なら text に倒す。
    const effectiveMode: CareerPresentationMode =
      mode === 'voice' && !sttSupported ? 'text' : mode;
    const config = buildConfig();
    // presentationType は後方互換のため scenario からマッピングして埋める（Supabase 列・旧表示用）。
    const presentationType: CareerPresentationType = getScenarioConfig(scenario).legacyType;
    const now = new Date().toISOString();
    const session: CareerPresentationSession = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      status: 'in_progress',
      presentationType,
      config,
      mode: effectiveMode,
      theme: theme.trim(),
      timeLimitSec,
      durationSec: 0,
      transcript: '',
    };
    upsertPresentationSession(session);
    // Supabase durable mirror（best-effort / member のみ。config 列は無いため mirror されない）。
    if (userId) void upsertCareerPresentationSessionsToSupabase(userId, [session]);
    router.push('/career/presentation/session');
  }

  const scenarioCfg = getScenarioConfig(scenario);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="お題プレゼンの準備"
        description="就活・選考で出される「お題」に対して発表する練習です。お題と発表時間を決めれば始められます。"
      />

      {/* お題（必須・主役） */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest">お題（必須）</p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerateTheme}
            disabled={generating || !ctx}
          >
            {generating ? '生成中…' : '🤖 AIにお題を作ってもらう'}
          </Button>
        </div>
        <Textarea
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          placeholder="例: あなたの強みを3分でプレゼンしてください / 若者向けの新サービスを提案してください"
          rows={3}
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-400">AI提案の難易度:</span>
          {CAREER_PRESENTATION_DIFFICULTIES.map((d) => (
            <Chip
              key={d.key}
              label={d.label}
              active={difficulty === d.key}
              onClick={() => setDifficulty(d.key)}
            />
          ))}
        </div>
      </Card>

      {/* 発表時間（重要） */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">発表時間</p>
        <div className="flex flex-wrap gap-2">
          {CAREER_PRESENTATION_TIME_LIMITS.map((t) => (
            <Chip
              key={t.sec}
              label={t.label}
              active={timeLimitSec === t.sec}
              onClick={() => setTimeLimitSec(t.sec)}
            />
          ))}
        </div>
      </Card>

      {/* 詳細設定（任意・折りたたみ） */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="w-full flex items-center justify-between"
        >
          <span className="text-[11px] font-bold text-blue-700 tracking-widest">
            詳細設定（任意）
          </span>
          <span className="text-xs text-slate-400">
            {showDetails ? '閉じる ▲' : `想定シーン・企業・観点など ▼`}
          </span>
        </button>

        {!showDetails && (
          <p className="mt-2 text-xs text-slate-500">
            現在の想定シーン: {scenarioCfg.emoji} {scenarioCfg.label}
            {evaluationFocus.length > 0 && `・評価観点 ${evaluationFocus.length}件`}
          </p>
        )}

        {showDetails && (
          <div className="mt-4 flex flex-col gap-5">
            {/* 想定シーン */}
            <div>
              <p className="text-xs font-bold text-slate-700 mb-2">想定シーン</p>
              <div className="flex flex-wrap gap-2">
                {CAREER_PRESENTATION_SCENARIOS.map((s) => (
                  <Chip
                    key={s.scenario}
                    label={`${s.emoji} ${s.label}`}
                    active={scenario === s.scenario}
                    onClick={() => setScenario(s.scenario)}
                  />
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
                {scenarioCfg.evaluationEmphasis}
              </p>
            </div>

            {/* 企業名・業界・職種 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <TextField label="企業名" value={companyName} onChange={setCompanyName} placeholder="例: 〇〇株式会社" />
              <TextField label="業界" value={industry} onChange={setIndustry} placeholder="例: IT・人材" />
              <TextField label="職種" value={jobType} onChange={setJobType} placeholder="例: 営業・企画" />
            </div>

            {/* 発表形式 */}
            <div>
              <p className="text-xs font-bold text-slate-700 mb-2">発表形式</p>
              <div className="flex flex-wrap gap-2">
                {CAREER_PRESENTATION_FORMATS.map((f) => (
                  <Chip
                    key={f.key}
                    label={f.label}
                    active={format === f.key}
                    onClick={() => setFormat(f.key)}
                  />
                ))}
              </div>
            </div>

            {/* 評価してほしい観点（複数選択） */}
            <div>
              <p className="text-xs font-bold text-slate-700 mb-2">評価してほしい観点（複数可）</p>
              <div className="flex flex-wrap gap-2">
                {CAREER_PRESENTATION_EVAL_FOCUS.map((f) => (
                  <Chip
                    key={f.key}
                    label={f.label}
                    active={evaluationFocus.includes(f.key)}
                    onClick={() => toggleFocus(f.key)}
                  />
                ))}
              </div>
            </div>

            {/* 補足メモ */}
            <div>
              <p className="text-xs font-bold text-slate-700 mb-2">補足メモ</p>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="発表の前提・意識したいことなどを自由に。"
                rows={2}
              />
            </div>
          </div>
        )}
      </Card>

      {/* 入力モード */}
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

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3.5 py-2 text-sm font-semibold ring-1 transition-colors ${
        active
          ? 'ring-blue-500 bg-blue-50 text-blue-700'
          : 'ring-slate-200 bg-white text-slate-700 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-bold text-slate-700 mb-1.5">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg ring-1 ring-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400"
      />
    </label>
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

'use client';

// PASSAI 就活版 — プレゼン対策AI setup 画面（お題ベース）。
// 選考文脈（企業/業界/職種/選考種別など）は前段 /career/presentation/target で入力し、
// 本画面はその要約を表示するに留める。setup の主役は「お題」「発表時間」「評価してほしい観点」。
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
import {
  upsertPresentationSession,
  loadPresentationTargetDraft,
} from '../presentationStorage';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import { upsertCareerPresentationSessionsToSupabase } from '@/lib/supabase/careerPresentation';
import {
  CAREER_PRESENTATION_TIME_LIMITS,
  CAREER_PRESENTATION_EVAL_FOCUS,
  presentationConfigFromTarget,
  getSelectionTypeLabel,
  resolveDifficulty,
  CAREER_PRESENTATION_NEW_SESSION_TYPE,
} from '../presentationModes';
import type {
  CareerPresentationSession,
  CareerPresentationConfig,
  CareerPresentationTarget,
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

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  // 前段 /target の選考文脈（下書き）。setup ではこれを要約表示し、config の土台にする。
  const target = useMemo<CareerPresentationTarget | null>(
    () => (isMounted ? loadPresentationTargetDraft() : null),
    [isMounted],
  );

  // 最重要（お題・発表時間・評価してほしい観点）。
  const [theme, setTheme] = useState('');
  const [timeLimitSec, setTimeLimitSec] = useState<number>(180);
  const [evaluationFocus, setEvaluationFocus] = useState<string[]>([]);
  // 直近に生成したお題（多様性のため theme API へ excludeThemes として渡す。永続化しない）。
  const [recentThemes, setRecentThemes] = useState<string[]>([]);
  // 登録済みの自己分析・ES等（他PASSAI機能データ）を補助的に参考にするか（既定 off）。
  const [useCareerContext, setUseCareerContext] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ctx = useMemo<CareerPresentationContextPayload | null>(
    () => (isMounted ? buildPresentationContextPayload() : null),
    [isMounted],
  );

  const difficulty = resolveDifficulty(target?.difficulty);

  // target（選考文脈）＋ setup（評価観点）から最終 config を組み立てる。
  function buildConfig(): CareerPresentationConfig {
    const cfg = presentationConfigFromTarget(target);
    if (evaluationFocus.length > 0) cfg.evaluationFocus = evaluationFocus;
    if (useCareerContext) cfg.useCareerContext = true;
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
        body: JSON.stringify({
          ...ctx,
          config: buildConfig(),
          timeLimitSec,
          difficulty,
          excludeThemes: recentThemes,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'お題の生成に失敗しました。');
      }
      const data = (await res.json()) as { theme: string };
      setTheme(data.theme);
      // 直近お題として保持（重複除外・最大5件）。次回生成で似すぎないようにする。
      const t = data.theme.trim();
      if (t) {
        setRecentThemes((prev) => [t, ...prev.filter((p) => p !== t)].slice(0, 5));
      }
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
    const config = buildConfig();
    const now = new Date().toISOString();
    const session: CareerPresentationSession = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      status: 'in_progress',
      // presentationType は後方互換（Supabase の presentation_type 列・旧履歴のラベル表示）のみで使う。
      // 新規フローでは分岐に使わないため固定値。
      presentationType: CAREER_PRESENTATION_NEW_SESSION_TYPE,
      config,
      // プレゼンは音声・録音で発表する形式のみ（テキスト発表は廃止）。
      // 音声認識に未対応の端末では session 側でテキスト入力にフォールバックする。
      mode: 'voice',
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

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="お題プレゼンの準備"
        description="お題と発表時間を決めれば始められます。想定した選考文脈に合わせて、AIがお題を作れます。"
      />

      {/* 今回の想定条件（前段 /target の要約） */}
      <TargetSummary target={target} isMounted={isMounted} />

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
        <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
          自分で入力するか、上のボタンで想定条件に沿ったお題をAIに作ってもらえます。
        </p>
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

      {/* 評価してほしい観点（任意・複数選択） */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
          評価してほしい観点（任意・複数可）
        </p>
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

        {/* 他PASSAI機能データを補助的に参考にするか（既定 off） */}
        <label className="mt-4 flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={useCareerContext}
            onChange={(e) => setUseCareerContext(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-400"
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-slate-800">
              登録済みの自己分析・ESなどを参考にする
            </span>
            <span className="block text-[11px] text-slate-500 leading-relaxed">
              オンにすると、あなたの登録済み情報を補助的に参考にします。お題への回答内容が評価の中心です。
            </span>
          </span>
        </label>
      </Card>

      {/* 発表方法（音声・録音のみ） */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">発表方法</p>
        <p className="text-sm text-slate-600 leading-relaxed">
          🎤 マイクで実際に声に出して発表します（ブラウザの音声認識でその場で文字起こしします）。
          本番と同じように「話して伝える」練習ができます。
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

// 前段 /target で入力した選考文脈の要約。未入力（汎用練習）なら案内を出す。
function TargetSummary({
  target,
  isMounted,
}: {
  target: CareerPresentationTarget | null;
  isMounted: boolean;
}) {
  const items: string[] = [];
  if (target) {
    if (target.companyName) items.push(target.companyName);
    if (target.industry) items.push(target.industry);
    if (target.jobType) items.push(target.jobType);
    if (target.selectionType) {
      const l = getSelectionTypeLabel(target.selectionType);
      if (l) items.push(l);
    }
  }

  return (
    <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest">今回の想定条件</p>
        <Link
          href="/career/presentation/target"
          className="text-xs font-semibold text-blue-600 hover:underline"
        >
          変更する
        </Link>
      </div>
      {!isMounted ? (
        <p className="text-sm text-slate-400">—</p>
      ) : items.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {items.map((it, i) => (
            <span
              key={i}
              className="rounded-md bg-white ring-1 ring-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700"
            >
              {it}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-500 leading-relaxed">
          企業・業界・職種は未設定です（汎用のお題で練習します）。
          <Link href="/career/presentation/target" className="ml-1 text-blue-600 hover:underline">
            選考文脈を設定する
          </Link>
          と、その選考で出そうなお題をAIが作りやすくなります。
        </p>
      )}
    </Card>
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


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
import {
  upsertInterviewSession,
  loadInterviewTargetDraft,
} from '../interviewStorage';
import {
  interviewSelectionLabel,
  interviewPhaseLabel,
} from '../interviewModes';
import { loadCompanyResearchLogs } from '@/app/career/company-research/companyResearchStorage';
import { buildCompanyResearchSnapshot } from '@/lib/careerCompanyResearch/context';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import { upsertCareerInterviewSessionsToSupabase } from '@/lib/supabase/careerInterview';
import { useVoice } from '../useVoice';
import {
  CAREER_INTERVIEW_MODES,
  DEFAULT_CAREER_INTERVIEW_TYPE,
} from '../interviewModes';
import type {
  CareerInterviewMode,
  CareerInterviewSession,
  CareerInterviewType,
  CareerInterviewTarget,
} from '@/types/careerInterview';
import {
  CAREER_COMPANY_INTEREST_LABELS,
  type CareerCompanyResearchLog,
} from '@/types/careerCompanyResearch';
import { withSourceSyncHeader } from '@/app/career/sourceSyncClient';
import { BASE_CONTEXT_SYNC_KINDS } from '@/lib/careerSourceSync/kinds';

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
  const userId = useCurrentUserId();
  const [mode, setMode] = useState<CareerInterviewMode>('text');
  const [interviewType, setInterviewType] = useState<CareerInterviewType>(
    DEFAULT_CAREER_INTERVIEW_TYPE,
  );
  // 任意: 参照する企業研究ログ。null = 使わない（従来どおり）。
  const [researchLogId, setResearchLogId] = useState<string | null>(null);
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
  // 前段（target 画面）で入力した受験先・選考の想定。未入力なら null（従来どおり）。
  const target = useMemo<CareerInterviewTarget | null>(
    () => (isMounted ? loadInterviewTargetDraft() : null),
    [isMounted],
  );
  // 保存済み企業研究ログ（最新更新順）。面接で深掘りの根拠に使える。
  const researchLogs = useMemo<CareerCompanyResearchLog[]>(() => {
    if (!isMounted) return [];
    return [...loadCompanyResearchLogs()].sort((a, b) =>
      (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''),
    );
  }, [isMounted]);
  const selectedResearchLog = useMemo<CareerCompanyResearchLog | null>(
    () => researchLogs.find((l) => l.id === researchLogId) ?? null,
    [researchLogs, researchLogId],
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
    // 企業研究ログ選択時は、その面接用コンテキストを含めて payload を作る（未選択なら null）。
    const payload = buildInterviewContextPayload(researchLogId);
    try {
      const res = await fetch('/api/career/interview/start', {
        method: 'POST',
        // D-R2: base context を server Source から出してよいかの証明（revision token のみ・生データ非送信）。
        headers: withSourceSyncHeader(
          { 'Content-Type': 'application/json' },
          BASE_CONTEXT_SYNC_KINDS,
        ),
        body: JSON.stringify({ ...payload, interviewType, target }),
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
        interviewType,
        turns: [{ role: 'question', content: data.question }],
        maxTurns: MAX_TURNS,
        // 受験先・選考の想定（前段入力・任意）。turn / complete でも同じ文脈に使う。
        ...(target ? { target } : {}),
        // 企業研究ログ連携（選択時のみ）。turn / complete でも同じログを文脈に使う。
        ...(selectedResearchLog
          ? {
              companyResearchLogId: selectedResearchLog.id,
              companyResearchSnapshot: buildCompanyResearchSnapshot(selectedResearchLog),
            }
          : {}),
      };
      upsertInterviewSession(session);
      // Supabase durable mirror（best-effort / member のみ）。
      if (userId) void upsertCareerInterviewSessionsToSupabase(userId, [session]);
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
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">
              受ける企業・選考
            </p>
            {target ? (
              <>
                <p className="text-sm font-bold text-slate-900 break-words">
                  {target.companyName}
                </p>
                <p className="mt-1 text-xs text-slate-500 leading-relaxed break-words">
                  {[
                    target.industry,
                    target.jobType,
                    interviewSelectionLabel(target.selectionType),
                    interviewPhaseLabel(target.interviewPhase),
                  ]
                    .filter((s) => s)
                    .join('・') || '企業名のみ指定'}
                </p>
              </>
            ) : (
              <p className="text-sm text-slate-600 leading-relaxed">
                企業は未指定です。特定の企業に合わせたい場合は設定できます。
              </p>
            )}
          </div>
          <Link
            href="/career/interview/target"
            className="shrink-0 text-xs font-semibold text-blue-600 hover:underline whitespace-nowrap"
          >
            {target ? '変更する' : '企業を設定'}
          </Link>
        </div>
      </Card>

      {researchLogs.length > 0 && (
        <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">
            企業研究ログを使う（任意）
          </p>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            保存した企業研究を選ぶと、面接官AIがその内容を前提に「なぜ興味を持ったか」「自分の経験との接続」「入社後の活かし方」を深掘りします（企業情報の暗記確認はしません）。
          </p>
          <div className="flex flex-col gap-2">
            <ResearchOption
              label="企業研究なしで進める"
              sub="登録済みの基本情報・活動・自己分析・ESをもとに面接します。"
              active={researchLogId === null}
              onClick={() => setResearchLogId(null)}
            />
            {researchLogs.map((log) => (
              <ResearchOption
                key={log.id}
                label={log.companyName || '（企業名なし）'}
                sub={researchSummary(log)}
                active={researchLogId === log.id}
                onClick={() => setResearchLogId(log.id)}
              />
            ))}
          </div>
        </Card>
      )}

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">面接の種類</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {CAREER_INTERVIEW_MODES.map((m) => (
            <TypeOption
              key={m.type}
              emoji={m.emoji}
              label={m.label}
              role={m.interviewerRole}
              description={m.description}
              recommended={m.recommendedData}
              active={interviewType === m.type}
              onClick={() => setInterviewType(m.type)}
            />
          ))}
        </div>
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

// 企業研究ログの 1 行サマリ（志望度・更新日・理解度スコア・メモ抜粋）。
function researchSummary(log: CareerCompanyResearchLog): string {
  const parts: string[] = [];
  if (log.interestLevel) parts.push(CAREER_COMPANY_INTEREST_LABELS[log.interestLevel]);
  const d = new Date(log.updatedAt || log.createdAt);
  if (!Number.isNaN(d.getTime())) parts.push(`更新 ${d.toLocaleDateString('ja-JP')}`);
  if (log.review?.overallScore) parts.push(`理解度${log.review.overallScore}点`);
  return parts.join('・');
}

function ResearchOption({
  label,
  sub,
  active,
  onClick,
}: {
  label: string;
  sub?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`w-full text-left rounded-xl px-3 py-2.5 ring-1 transition-colors ${
        active ? 'bg-blue-50 ring-blue-400' : 'bg-white ring-slate-200 hover:bg-slate-50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
            active ? 'border-blue-600' : 'border-slate-300'
          }`}
        >
          {active && <span className="h-2 w-2 rounded-full bg-blue-600" />}
        </span>
        <span className="text-sm font-semibold text-slate-800 truncate">{label}</span>
      </div>
      {sub && <p className="mt-1 pl-6 text-xs text-slate-500 leading-relaxed">{sub}</p>}
    </button>
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

function TypeOption({
  emoji,
  label,
  role,
  description,
  recommended,
  active,
  onClick,
}: {
  emoji: string;
  label: string;
  role: string;
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
        <span className="ml-2 text-[11px] font-medium text-slate-500">{role}</span>
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

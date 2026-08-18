'use client';

// PASSAI 就活版 — 面接AI「面接モード選択」画面（旧: setup / 回答モード選択）。
//
// 本番 UX: 基本情報（target）→ **面接モードを 4 種類から選ぶ** → start API → 音声面接へ直行。
//   - ★ テキスト / 音声の選択 UI は廃止した。新規面接は常に音声（mode: 'voice'）。
//   - ★ 企業研究ログの手動選択 UI も廃止した。企業情報は「面接画面で再入力・再選択させない」方針のため、
//     前段で入力した企業（target）に対応する既存の企業研究ログを **自動で** 文脈に載せる。
//     （Company Data Spine の User Private Evidence = 企業研究ログ。取得経路は既存のまま。）

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
import { loadCompanyResearchLogs } from '@/app/career/company-research/companyResearchStorage';
import { buildCompanyResearchSnapshot } from '@/lib/careerCompanyResearch/context';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import { upsertCareerInterviewSessionsToSupabase } from '@/lib/supabase/careerInterview';
import { useVoice } from '../useVoice';
import {
  CAREER_INTERVIEW_MODES,
  DEFAULT_CAREER_INTERVIEW_TYPE,
  interviewSelectionLabel,
  isInterviewTargetComplete,
} from '../interviewModes';
import type {
  CareerInterviewSession,
  CareerInterviewType,
  CareerInterviewTarget,
} from '@/types/careerInterview';
import type { CareerCompanyResearchLog } from '@/types/careerCompanyResearch';
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

/**
 * 前段で入力した企業（target）に対応する企業研究ログを自動で選ぶ（純粋なマッチングのみ）。
 *
 * ★ ここで新しい企業検索・企業マッチング機構は作らない。既存ログの中から
 *   ① Company Identity の companyId 一致 → ② 企業名の完全一致 の順で 1 件選ぶだけ。
 *   見つからなければ null（＝企業研究なしで面接。従来どおり成立する）。
 */
function pickCompanyResearchLog(
  logs: CareerCompanyResearchLog[],
  target: CareerInterviewTarget | null,
): CareerCompanyResearchLog | null {
  if (!target) return null;
  if (target.companyId) {
    const byId = logs.find((l) => l.companyId && l.companyId === target.companyId);
    if (byId) return byId;
  }
  const name = target.companyName.trim();
  if (!name) return null;
  return logs.find((l) => (l.companyName ?? '').trim() === name) ?? null;
}

export default function CareerInterviewSetupPage() {
  const router = useRouter();
  const userId = useCurrentUserId();
  const [interviewType, setInterviewType] = useState<CareerInterviewType>(
    DEFAULT_CAREER_INTERVIEW_TYPE,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 音声面接が唯一の runtime path。ただし STT 非対応環境で **開始そのものを塞がない**
  // （P0-2: 面接不能を作らない）。非対応のときは session 画面が緊急テキスト回答を出す。
  //   ★ ここで mode を 'text' に倒したり、text / voice セレクタを復活させたりはしない。
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
  // 前段（基本情報画面）で入力した受験先・選考の想定。必須 4 項目が揃っている前提。
  const target = useMemo<CareerInterviewTarget | null>(
    () => (isMounted ? loadInterviewTargetDraft() : null),
    [isMounted],
  );
  const targetReady = isInterviewTargetComplete(target);

  // 企業研究ログ（保存済み）から、今回の企業に対応するものを自動選択する（UI 選択は無し）。
  const selectedResearchLog = useMemo<CareerCompanyResearchLog | null>(() => {
    if (!isMounted || !target) return null;
    try {
      return pickCompanyResearchLog(loadCompanyResearchLogs(), target);
    } catch {
      // 企業研究ログが読めなくても面接は成立する（企業研究なしで進む）。
      return null;
    }
  }, [isMounted, target]);

  const profileReady = !!ctx?.profile;
  const activityReady = hasAnyActivity(ctx?.activity ?? null);
  const selfAnalysisReady = !!ctx?.selfAnalysis;
  const esReady = !!ctx?.es;
  const canStart = (profileReady || activityReady) && targetReady;

  async function handleStart() {
    if (!canStart || loading || !ctx) return;
    setLoading(true);
    setError(null);
    // 自動選択した企業研究ログがあれば、その面接用コンテキストを含めて payload を作る。
    const payload = buildInterviewContextPayload(selectedResearchLog?.id ?? null);
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
      const session: CareerInterviewSession = {
        id: newId(),
        createdAt: now,
        updatedAt: now,
        status: 'in_progress',
        // ★ 新規面接は常に音声。ユーザーにテキスト / 音声を選ばせない。
        mode: 'voice',
        interviewType,
        turns: [{ role: 'question', content: data.question }],
        maxTurns: MAX_TURNS,
        // 受験先・選考の想定（前段入力）。turn / complete でも同じ文脈に使う。
        ...(target ? { target } : {}),
        // 企業研究ログ連携（自動選択時のみ）。turn / complete でも同じログを文脈に使う。
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
      <PageHeader
        title="面接モードを選ぶ"
        description="練習したい内容に合わせてモードを選ぶと、そのまま音声面接が始まります。"
      />

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
                  ]
                    .filter((s) => s)
                    .join('・')}
                </p>
                {selectedResearchLog && (
                  <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
                    保存済みの企業研究（{selectedResearchLog.companyName}）を面接の文脈に使います。
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-slate-600 leading-relaxed">
                受ける企業・選考が未入力です。
              </p>
            )}
          </div>
          <Link
            href="/career/interview/target"
            className="shrink-0 text-xs font-semibold text-blue-600 hover:underline whitespace-nowrap"
          >
            {target ? '変更する' : '入力する'}
          </Link>
        </div>
        {!targetReady && (
          <p className="mt-3 text-xs text-amber-700 leading-relaxed">
            企業名・業界・職種・選考種別の入力が必要です。「
            {target ? '変更する' : '入力する'}」から入力してください。
          </p>
        )}
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">入力データ</p>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <ReadyItem label="基本情報" ready={profileReady} href="/career/profile" />
          <ReadyItem label="活動整理" ready={activityReady} href="/career/activity" />
          <ReadyItem label="自己分析" ready={selfAnalysisReady} href="/career/self-analysis" />
          <ReadyItem label="ES" ready={esReady} href="/career/es" />
        </div>
        {!profileReady && !activityReady && (
          <p className="mt-4 text-xs text-amber-700 leading-relaxed">
            基本情報または活動整理のいずれかを入力すると面接を始められます。
          </p>
        )}
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">面接モード</p>
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

      {/* 音声のみ運用だが、非対応環境でも面接を始められるようにする（P0-2）。
          音声を勧めたうえで、テキストでも続行できることを事前に伝える。 */}
      {isMounted && !sttSupported && (
        <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
          <p className="text-sm font-bold text-amber-700 mb-1">
            この環境では音声入力を使えません
          </p>
          <p className="text-xs text-slate-600 leading-relaxed">
            面接は音声で行います。お使いのブラウザが音声認識（マイク入力）に対応していないため、
            このまま始めるとテキストでの回答になります。音声で練習する場合は Chrome
            など音声認識に対応したブラウザで開き直し、マイクの使用を許可してください。
          </p>
        </Card>
      )}

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
          {loading ? '準備中…' : '音声面接を始める →'}
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

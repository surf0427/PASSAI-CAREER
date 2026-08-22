'use client';

// PASSAI 就活版 — GD session 画面（テキストベース・ターン制の本体）。
//
// 会話状態は localStorage（careerGdSessions）で保持し、各発言/評価はステートレス API
// （/api/career/gd/{turn,feedback}）に委ねる。DB / 課金 / usage 非接続。
// 進行: ユーザーが発言 → AI が1名応答（自動）。「AIの発言を進める」で AI 発言を追加できる。
// 強すぎない AI・ユーザーの発言機会確保のため、AI は1回につき1名だけ発言する。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { GD_ROLE_LABELS } from '../gdRoles';
import {
  getInProgressGdSession,
  upsertGdSession,
  appendGdResult,
} from '../gdStorage';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
import { upsertCareerGdSoloResultsToSupabase } from '@/lib/supabase/careerGdSolo';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import type {
  CareerGdSession,
  CareerGdResult,
  GdParticipant,
  GdUtterance,
} from '@/types/careerGd';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

// サーバ側 CAREER_GD_MAX_UTTERANCES と一致（発言総数の上限）。
const MAX_UTTERANCES = 20;

type Phase = 'discussing' | 'ai-thinking' | 'evaluating';

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function formatClock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function speechCount(session: CareerGdSession | null): number {
  if (!session) return 0;
  return session.transcript.filter((u) => u.kind !== 'system').length;
}

function selfSpeechCount(session: CareerGdSession | null): number {
  if (!session) return 0;
  const self = session.participants.find((p) => p.isSelf);
  if (!self) return 0;
  return session.transcript.filter((u) => u.participantId === self.id && u.kind !== 'system').length;
}

export default function CareerGdSessionPage() {
  const router = useRouter();
  // Event Log 用（member のみ）。useCallback の deps を変えないよう ref で最新 userId を参照。
  const userId = useCurrentUserId();
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const [session, setSession] = useState<CareerGdSession | null>(
    () => getInProgressGdSession(),
  );
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<Phase>('discussing');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // 次に発言する AI のローテーション位置。
  const aiPointerRef = useRef(0);

  const self = useMemo<GdParticipant | null>(
    () => session?.participants.find((p) => p.isSelf) ?? null,
    [session],
  );

  // 経過タイマー（表示のみ・強制終了しない）。
  useEffect(() => {
    if (!isMounted || !session || phase === 'evaluating') return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isMounted, session, phase]);

  const total = speechCount(session);
  const reachedCap = total >= MAX_UTTERANCES;

  // AI 1 名の発言を生成して current に追記する（stale closure を避けるため session を引数で受ける）。
  const runAiTurn = useCallback(async (current: CareerGdSession) => {
    const ais = current.participants.filter((p) => p.type === 'ai');
    if (ais.length === 0) return;
    if (current.transcript.filter((u) => u.kind !== 'system').length >= MAX_UTTERANCES) return;
    setPhase('ai-thinking');
    setError(null);
    const speaker = ais[aiPointerRef.current % ais.length];
    aiPointerRef.current += 1;
    const wrap =
      current.transcript.filter((u) => u.kind !== 'system').length >=
      Math.round(MAX_UTTERANCES * 0.7);
    try {
      const res = await fetch('/api/career/gd/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          theme: current.theme,
          format: current.format,
          participants: current.participants,
          speakerId: speaker.id,
          transcript: current.transcript,
          wrapUp: wrap,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'AIの発言生成に失敗しました。');
      }
      const data = (await res.json()) as { content: string };
      const utterance: GdUtterance = {
        id: newId('gdu'),
        participantId: speaker.id,
        content: data.content,
        createdAt: new Date().toISOString(),
        kind: 'speech',
      };
      const latest = getInProgressGdSession() ?? current;
      const next: CareerGdSession = {
        ...latest,
        transcript: [...latest.transcript, utterance],
        updatedAt: new Date().toISOString(),
      };
      upsertGdSession(next);
      setSession(next);
      setPhase('discussing');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AIの発言生成に失敗しました。');
      setPhase('discussing');
    }
  }, []);

  // 「AIの発言を進める」ボタン。
  const advanceAi = useCallback(() => {
    if (!session || phase !== 'discussing') return;
    void runAiTurn(session);
  }, [session, phase, runAiTurn]);

  // ユーザーが発言する → 保存後、AI 1 名が自動で応答する。
  const postUser = useCallback(async () => {
    if (!session || !self || phase !== 'discussing') return;
    const trimmed = draft.trim();
    if (!trimmed || reachedCap) return;
    const utterance: GdUtterance = {
      id: newId('gdu'),
      participantId: self.id,
      content: trimmed,
      createdAt: new Date().toISOString(),
      kind: 'speech',
    };
    const next: CareerGdSession = {
      ...session,
      transcript: [...session.transcript, utterance],
      updatedAt: new Date().toISOString(),
    };
    upsertGdSession(next);
    setSession(next);
    setDraft('');
    if (speechCount(next) < MAX_UTTERANCES) {
      await runAiTurn(next);
    }
  }, [session, self, phase, draft, reachedCap, runAiTurn]);

  // GD を終了して評価する。
  const finish = useCallback(async () => {
    if (!session || !self) return;
    if (selfSpeechCount(session) === 0) return;
    setPhase('evaluating');
    setError(null);
    try {
      const res = await fetch('/api/career/gd/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          theme: session.theme,
          participants: session.participants,
          transcript: session.transcript,
          participationMode: session.participationMode,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '評価の生成に失敗しました。');
      }
      const data = (await res.json()) as {
        feedbacks: CareerGdResult['feedbacks'];
        selfCompanyGrade: CareerGdResult['selfCompanyGrade'];
        overallSummary: string;
        matchingHints: CareerGdResult['matchingHints'];
        ranking?: CareerGdResult['ranking'];
      };

      const completed: CareerGdSession = {
        ...session,
        status: 'completed',
        updatedAt: new Date().toISOString(),
      };
      upsertGdSession(completed);

      const result: CareerGdResult = {
        id: session.id,
        createdAt: new Date().toISOString(),
        participationMode: session.participationMode,
        format: session.format,
        theme: session.theme,
        timeLimitSec: session.timeLimitSec,
        participants: session.participants,
        transcript: session.transcript,
        selfRole: self.role,
        feedbacks: data.feedbacks,
        selfCompanyGrade: data.selfCompanyGrade,
        overallSummary: data.overallSummary,
        matchingHints: data.matchingHints,
        ...(data.ranking ? { ranking: data.ranking } : {}),
      };
      appendGdResult(result);
      // Supabase durable mirror（best-effort / member のみ）。
      //   ES / 面接 / プレゼンと同じ「localStorage canonical + mirror + restore」パターン。
      //   ソロ GD だけ mirror が無く、端末変更で履歴が消えていたため揃える。
      //   DDL 未適用でも never-throw で no-op（既存 mirror と同じ fail-open 契約）。
      if (userIdRef.current) {
        void upsertCareerGdSoloResultsToSupabase(userIdRef.current, [result]);
      }
      // Event Log（本文なし・fire-and-forget / member のみ）。GD topic/発言/評価/改善本文・
      // 参加者名・ranking コメントは渡さない。selfCompanyGrade は既に S/A/B/C/D の band。
      void recordCareerEvent(userIdRef.current, {
        feature: 'gd',
        eventType: 'feature_completed',
        completionStatus: 'completed',
        clientEventId: result.id,
        scoreBand: result.selfCompanyGrade,
        metadata: {
          participationMode: result.participationMode,
          format: result.format,
          participantCount: result.participants.length,
        },
      });
      // STEP-GD-18: 完了後はソロ結果画面へ（run→result→view の導線統一）。
      router.push(`/career/gd/result?id=${encodeURIComponent(session.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '評価の生成に失敗しました。');
      setPhase('discussing');
    }
  }, [session, self, router]);

  if (!isMounted) return null;

  if (!session) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <PageHeader title="GD" description="" />
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">進行中のGDがありません。</p>
          <Link
            href="/career/gd/setup"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            GDを始める →
          </Link>
        </Card>
      </div>
    );
  }

  const remaining = session.timeLimitSec - elapsed;
  const nameOf = (id: string) =>
    session.participants.find((p) => p.id === id)?.displayName ?? '参加者';
  const roleOf = (id: string) => {
    const p = session.participants.find((x) => x.id === id);
    return p ? GD_ROLE_LABELS[p.role] : '';
  };
  const aiThinking = phase === 'ai-thinking';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="GD中" description="AI参加者とディスカッションを進めてください。" />

      {/* テーマ */}
      <Card variant="soft" padding="md" className="mb-5">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-1">テーマ</p>
        <p className="text-base font-bold text-slate-900 leading-relaxed mb-1">{session.theme.title}</p>
        <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">{session.theme.description}</p>
        {session.theme.constraints && session.theme.constraints.length > 0 && (
          <ul className="mt-2 list-disc pl-5 space-y-0.5">
            {session.theme.constraints.map((c, i) => (
              <li key={i} className="text-xs text-slate-500">{c}</li>
            ))}
          </ul>
        )}
      </Card>

      {/* 参加者・役割・時間 */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {session.participants.map((p) => (
            <span
              key={p.id}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${p.isSelf ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}
            >
              {p.displayName}・{GD_ROLE_LABELS[p.role]}
            </span>
          ))}
        </div>
        <span className={`shrink-0 text-sm font-semibold ${remaining <= 0 ? 'text-red-600' : 'text-slate-500'}`}>
          残り {formatClock(remaining)}
        </span>
      </div>

      {/* 議論ログ */}
      <Card variant="soft" padding="md" className="mb-5">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
          議論ログ（{total} / {MAX_UTTERANCES} 発言）
        </p>
        {session.transcript.length === 0 ? (
          <p className="text-sm text-slate-500 leading-relaxed">
            まだ発言はありません。あなたから口火を切るか、「AIの発言を進める」を押してください。
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {session.transcript.map((u) => {
              const isSelf = session.participants.find((p) => p.id === u.participantId)?.isSelf;
              return (
                <li key={u.id} className="text-sm leading-relaxed">
                  <span className={isSelf ? 'font-bold text-blue-700' : 'font-bold text-slate-900'}>
                    {nameOf(u.participantId)}
                    <span className="ml-1 text-[11px] font-medium text-slate-400">{roleOf(u.participantId)}</span>
                    ：
                  </span>
                  <span className="text-slate-700 whitespace-pre-wrap">{u.content}</span>
                </li>
              );
            })}
          </ul>
        )}
        {aiThinking && (
          <p className="mt-3 text-xs text-slate-400 italic">AI参加者が考えています…</p>
        )}
      </Card>

      {error && (
        <p className="mb-4 text-sm text-red-600 leading-relaxed" role="alert">
          {error}
        </p>
      )}

      {/* 入力・操作 */}
      {!reachedCap ? (
        <Card variant="soft" padding="md" className="mb-5">
          <label className="block text-sm font-bold text-slate-800 mb-2">あなたの発言</label>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="意見・提案・他の参加者への質問などを入力してください。"
            rows={4}
            disabled={aiThinking || phase === 'evaluating'}
          />
          <div className="mt-4 flex flex-col sm:flex-row gap-3">
            <Button
              variant="primary"
              size="md"
              onClick={postUser}
              disabled={aiThinking || phase === 'evaluating' || !draft.trim()}
              className="w-full sm:w-auto"
            >
              発言する →
            </Button>
            <Button
              variant="outline"
              size="md"
              onClick={advanceAi}
              disabled={aiThinking || phase === 'evaluating'}
              className="w-full sm:w-auto"
            >
              AIの発言を進める
            </Button>
          </div>
        </Card>
      ) : (
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm text-slate-600 leading-relaxed">
            発言数が上限に達しました。議論を終了して評価に進みましょう。
          </p>
        </Card>
      )}

      {/* 終了・評価 */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Button
          variant="primary"
          size="md"
          onClick={finish}
          disabled={phase === 'evaluating' || aiThinking || selfSpeechCount(session) === 0}
          className="w-full sm:w-auto"
        >
          {phase === 'evaluating' ? '評価を作成中…' : 'GDを終了して評価を見る →'}
        </Button>
        <Link
          href="/career/gd"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← 中断してGDトップに戻る
        </Link>
      </div>
      {selfSpeechCount(session) === 0 && (
        <p className="mt-2 text-xs text-amber-700">
          評価には、あなた自身の発言が1回以上必要です。
        </p>
      )}
    </div>
  );
}

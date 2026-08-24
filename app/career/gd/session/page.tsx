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
import { GD_ROLE_LABELS } from '../gdRoles';
import { GdCircleStage, useRecentSpeaker, type GdStageParticipant } from '../components/stage';
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
  // Forest Circle の「・・・」表示用（どの AI が生成中か）。進行ロジックには関与しない。
  const [aiSpeakerId, setAiSpeakerId] = useState<string | null>(null);
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
    // 生成中の AI を Speaking Indicator へ渡すだけ（選出も順番も従来どおり）。
    setAiSpeakerId(speaker.id);
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
      setAiSpeakerId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AIの発言生成に失敗しました。');
      setPhase('discussing');
      setAiSpeakerId(null);
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

  // ── Forest Circle 表示用の adapter（既存 state を写すだけ / 進行ロジック非関与）──
  //   直近の発言（system を除く）＝「今この人が話している」の source。
  const lastSpeech = useMemo<GdUtterance | null>(() => {
    const speeches = (session?.transcript ?? []).filter((u) => u.kind !== 'system');
    return speeches.length > 0 ? speeches[speeches.length - 1] : null;
  }, [session]);
  const recentSpeakerId = useRecentSpeaker(
    lastSpeech?.participantId ?? null,
    lastSpeech?.id ?? null,
  );
  // 自分は「入力中（draft がある）」を発言中として扱う（テキストGDでの自然な写像）。
  const selfTyping = draft.trim().length > 0;
  const stageParticipants = useMemo<GdStageParticipant[]>(() => {
    const list = session?.participants ?? [];
    // 自分を先頭（＝手前中央の席）へ。sort は安定なので他の並びは既存のまま。
    const ordered = [...list].sort((a, b) => (a.isSelf ? 0 : 1) - (b.isSelf ? 0 : 1));
    return ordered.map((p) => {
      const thinking = phase === 'ai-thinking' && p.id === aiSpeakerId;
      const speaking =
        !thinking && (p.isSelf ? selfTyping || recentSpeakerId === p.id : recentSpeakerId === p.id);
      return {
        key: p.id,
        participantId: p.id,
        displayName: p.displayName,
        roleLabel: GD_ROLE_LABELS[p.role],
        isSelf: !!p.isSelf,
        isAi: p.type === 'ai',
        isHost: false,
        speech: thinking ? 'thinking' : speaking ? 'speaking' : 'idle',
      };
    });
  }, [session, phase, aiSpeakerId, recentSpeakerId, selfTyping]);

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
  const thinkingAiName = aiThinking
    ? (session.participants.find((p) => p.id === aiSpeakerId)?.displayName ?? 'AI参加者')
    : null;
  const statusLabel =
    phase === 'evaluating'
      ? '評価を作成中…'
      : aiThinking
        ? `${thinkingAiName}が発言を考えています…`
        : reachedCap
          ? '発言数が上限に達しました'
          : null;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="GD中" description="森の円卓で、AI参加者とディスカッションを進めてください。" />

      <div className="gdf-shell">
        {/* 円になって座っている参加者（主役）。テーマ・残り時間は円の中央に置く。 */}
        <GdCircleStage
          participants={stageParticipants}
          themeTitle={session.theme.title || '（テーマ準備中）'}
          statusLabel={statusLabel}
          timer={
            <p
              className={`gdf-clock${remaining <= 0 ? ' gdf-clock--expired' : ''}`}
              data-testid="gd-solo-remaining"
            >
              残り {formatClock(remaining)}
            </p>
          }
          headerLeft={<span className="gdf-chip">参加者 {session.participants.length}人</span>}
          headerRight={
            <span className="gdf-chip">
              発言 {total} / {MAX_UTTERANCES}
            </span>
          }
        />

        <div className="mt-3 flex flex-col gap-3">
          {/* テーマの詳細（円の中央には見出しだけを置くため、本文はここに出す）。 */}
          {(session.theme.description || (session.theme.constraints?.length ?? 0) > 0) && (
            <div className="gdf-panel">
              <p className="gdf-panel__label">テーマの詳細</p>
              {session.theme.description && (
                <p className="mt-1 text-[13px] leading-relaxed text-[#e2f1e6] whitespace-pre-wrap">
                  {session.theme.description}
                </p>
              )}
              {session.theme.constraints && session.theme.constraints.length > 0 && (
                <ul className="mt-2 list-disc pl-5 space-y-0.5">
                  {session.theme.constraints.map((c, i) => (
                    <li key={i} className="text-xs text-[#bfd8c6]">{c}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 議論ログ */}
          <div className="gdf-panel">
            <p className="gdf-panel__label">議論ログ（{total} / {MAX_UTTERANCES} 発言）</p>
            <div className="gdf-log mt-2">
              {session.transcript.length === 0 ? (
                <p className="gdf-log__empty">
                  まだ発言はありません。あなたから口火を切るか、「AIの発言を進める」を押してください。
                </p>
              ) : (
                session.transcript.map((u) => {
                  const speaker = session.participants.find((p) => p.id === u.participantId);
                  if (u.kind === 'system') {
                    return (
                      <p key={u.id} className="gdf-msg__system">【進行】{u.content}</p>
                    );
                  }
                  return (
                    <div
                      key={u.id}
                      className={`gdf-msg${speaker?.isSelf ? ' gdf-msg--self' : ''}${speaker?.type === 'ai' ? ' gdf-msg--ai' : ''}`}
                    >
                      <span className="gdf-msg__who">
                        {nameOf(u.participantId)}
                        <span className="gdf-seat__role">{roleOf(u.participantId)}</span>
                      </span>
                      <span className="gdf-msg__body">{u.content}</span>
                    </div>
                  );
                })
              )}
              {aiThinking && (
                <p className="gdf-msg__system">{thinkingAiName}が考えています…</p>
              )}
            </div>
          </div>

          {error && (
            <p className="gdf-alert" role="alert">
              {error}
            </p>
          )}

          {/* 発言入力・操作 */}
          {!reachedCap ? (
            <div className="gdf-panel">
              <label htmlFor="gd-solo-input" className="gdf-panel__label">
                あなたの発言
              </label>
              <textarea
                id="gd-solo-input"
                className="gdf-field mt-2"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="意見・提案・他の参加者への質問などを入力してください。"
                rows={3}
                disabled={aiThinking || phase === 'evaluating'}
              />
              <div className="gdf-controls mt-3">
                <button
                  type="button"
                  className="gdf-btn gdf-btn--primary"
                  onClick={postUser}
                  disabled={aiThinking || phase === 'evaluating' || !draft.trim()}
                >
                  発言する →
                </button>
                <button
                  type="button"
                  className="gdf-btn gdf-btn--ghost"
                  onClick={advanceAi}
                  disabled={aiThinking || phase === 'evaluating'}
                >
                  AIの発言を進める
                </button>
              </div>
            </div>
          ) : (
            <div className="gdf-panel">
              <p className="text-[13px] leading-relaxed text-[#e2f1e6]">
                発言数が上限に達しました。議論を終了して評価に進みましょう。
              </p>
            </div>
          )}

          {/* 終了・評価 */}
          <div className="gdf-controls">
            <button
              type="button"
              className="gdf-btn gdf-btn--primary"
              onClick={finish}
              disabled={phase === 'evaluating' || aiThinking || selfSpeechCount(session) === 0}
            >
              {phase === 'evaluating' ? '評価を作成中…' : 'GDを終了して評価を見る →'}
            </button>
            <Link href="/career/gd" className="gdf-btn gdf-btn--ghost">
              ← 中断してGDトップに戻る
            </Link>
          </div>
          {selfSpeechCount(session) === 0 && (
            <p className="gdf-note">評価には、あなた自身の発言が1回以上必要です。</p>
          )}
        </div>
      </div>
    </div>
  );
}

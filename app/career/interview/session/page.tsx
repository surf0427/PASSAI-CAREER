'use client';

// PASSAI 就活版 — 面接AI session 画面（ターン制の本体）。
//
// 受験版 InterviewAiClient の UX（進行バー・質問読み上げ・回答→深掘り・タイマー・録音UI）を
// 踏襲しつつ、会話状態は localStorage（careerInterviewSessions）で保持し、各ターン生成は
// ステートレス API（/api/career/interview/{turn,complete}）に委ねる。DB / 課金 / usage 非接続。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { buildInterviewContextPayload } from '../contextSource';
import {
  getInProgressInterviewSession,
  upsertInterviewSession,
  appendInterviewResult,
} from '../interviewStorage';
import { useVoice } from '../useVoice';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import {
  upsertCareerInterviewSessionsToSupabase,
  upsertCareerInterviewResultsToSupabase,
} from '@/lib/supabase/careerInterview';
import { shadowWriteInterviewMemory } from '@/app/career/personalMemoryShadowWrite';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import { getInterviewModeConfig, resolveInterviewType } from '../interviewModes';
import { InterviewerAvatar, type AvatarState } from '../components/InterviewerAvatar';
import type {
  CareerInterviewSession,
  CareerInterviewResult,
} from '@/types/careerInterview';
import { withSourceSyncHeader } from '@/app/career/sourceSyncClient';
import { BASE_CONTEXT_SYNC_KINDS } from '@/lib/careerSourceSync/kinds';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

type Phase = 'answering' | 'thinking' | 'finished' | 'evaluating';

function countAnswers(session: CareerInterviewSession | null): number {
  if (!session) return 0;
  return session.turns.filter((t) => t.role === 'answer').length;
}

function currentQuestion(session: CareerInterviewSession | null): string | null {
  if (!session || session.turns.length === 0) return null;
  const last = session.turns[session.turns.length - 1];
  return last.role === 'question' ? last.content : null;
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function CareerInterviewSessionPage() {
  const router = useRouter();
  // Supabase mirror 用。useCallback の deps を変えないよう ref で最新 userId を参照する。
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

  // 進行中セッションを localStorage から lazy 取得（SSR では null）。出力は isMounted で gate する。
  const [session, setSession] = useState<CareerInterviewSession | null>(
    () => getInProgressInterviewSession(),
  );
  const [answer, setAnswer] = useState('');
  const [reaction, setReaction] = useState('');
  const [phase, setPhase] = useState<Phase>('answering');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const onFinalTranscript = useCallback((text: string) => {
    setAnswer((prev) => (prev ? `${prev} ${text}` : text));
  }, []);
  const {
    sttSupported,
    ttsSupported,
    listening,
    interimText,
    speaking,
    startListening,
    stopListening,
    speak,
    cancelSpeak,
  } = useVoice({ onFinalTranscript });

  const question = currentQuestion(session);
  const answered = countAnswers(session);
  const maxTurns = session?.maxTurns ?? 5;
  const isVoice = session?.mode === 'voice';
  const interviewType = resolveInterviewType(session?.interviewType);
  const modeConfig = getInterviewModeConfig(interviewType);

  // アバターの状態（評価/思考 → thinking、録音中 → listening、読み上げ中 → speaking）。
  const avatarState: AvatarState =
    phase === 'thinking' || phase === 'evaluating'
      ? 'thinking'
      : listening
        ? 'listening'
        : speaking
          ? 'speaking'
          : 'idle';

  // 新しい質問が来たら（voice モードかつ TTS 対応時）読み上げる。
  const lastSpokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isMounted || !question) return;
    if (isVoice && ttsSupported && lastSpokenRef.current !== question) {
      lastSpokenRef.current = question;
      speak(question);
    }
  }, [isMounted, question, isVoice, ttsSupported, speak]);

  // 回答中の経過タイマー（1 秒ごとに加算）。リセットは質問遷移の各ハンドラ側で行う
  // （effect 本体での同期 setState を避けるため）。
  useEffect(() => {
    if (phase !== 'answering' || !question) return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase, question]);

  const handleSubmit = useCallback(async () => {
    if (!session || phase !== 'answering') return;
    const trimmed = answer.trim();
    if (!trimmed) return;
    if (listening) stopListening();
    cancelSpeak();
    setPhase('thinking');
    setError(null);

    // セッションが企業研究ログを参照しているなら、その文脈も毎ターン渡す。
    const ctx = buildInterviewContextPayload(session.companyResearchLogId);
    const turnsBefore = session.turns;
    const withAnswer: CareerInterviewSession = {
      ...session,
      turns: [...turnsBefore, { role: 'answer', content: trimmed }],
      updatedAt: new Date().toISOString(),
    };

    try {
      const res = await fetch('/api/career/interview/turn', {
        method: 'POST',
        headers: withSourceSyncHeader(
          { 'Content-Type': 'application/json' },
          BASE_CONTEXT_SYNC_KINDS,
        ),
        body: JSON.stringify({
          ...ctx,
          interviewType: session.interviewType,
          target: session.target,
          turns: turnsBefore,
          answer: trimmed,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '次の質問の生成に失敗しました。');
      }
      const data = (await res.json()) as {
        done?: boolean;
        reaction?: string;
        question?: string | null;
      };

      if (data.done || !data.question) {
        // 上限到達 = 面接終了。回答だけ確定して評価フェーズへ。
        upsertInterviewSession(withAnswer);
        if (userIdRef.current)
          void upsertCareerInterviewSessionsToSupabase(userIdRef.current, [withAnswer]);
        setSession(withAnswer);
        setReaction(data.reaction ?? '');
        setAnswer('');
        setPhase('finished');
        return;
      }

      const next: CareerInterviewSession = {
        ...withAnswer,
        turns: [...withAnswer.turns, { role: 'question', content: data.question }],
        updatedAt: new Date().toISOString(),
      };
      upsertInterviewSession(next);
      if (userIdRef.current)
        void upsertCareerInterviewSessionsToSupabase(userIdRef.current, [next]);
      setSession(next);
      setReaction(data.reaction ?? '');
      setAnswer('');
      setElapsed(0);
      setPhase('answering');
    } catch (e) {
      setError(e instanceof Error ? e.message : '次の質問の生成に失敗しました。');
      setPhase('answering');
    }
  }, [session, phase, answer, listening, stopListening, cancelSpeak]);

  const handleComplete = useCallback(async () => {
    if (!session) return;
    if (countAnswers(session) === 0) return;
    setPhase('evaluating');
    setError(null);
    cancelSpeak();

    const ctx = buildInterviewContextPayload(session.companyResearchLogId);
    try {
      const res = await fetch('/api/career/interview/complete', {
        method: 'POST',
        headers: withSourceSyncHeader(
          { 'Content-Type': 'application/json' },
          BASE_CONTEXT_SYNC_KINDS,
        ),
        body: JSON.stringify({
          ...ctx,
          interviewType: session.interviewType,
          target: session.target,
          turns: session.turns,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '評価の生成に失敗しました。');
      }
      const data = (await res.json()) as { result: CareerInterviewResult['result'] };

      const completed: CareerInterviewSession = {
        ...session,
        status: 'completed',
        updatedAt: new Date().toISOString(),
      };
      upsertInterviewSession(completed);
      const resultLog: CareerInterviewResult = {
        id: session.id,
        createdAt: new Date().toISOString(),
        mode: session.mode,
        interviewType: session.interviewType,
        turns: session.turns,
        result: data.result,
        // 受験先・選考の想定（あれば結果からも辿れるよう保持）。
        ...(session.target ? { target: session.target } : {}),
        // 参照した企業研究ログ（あれば結果からも辿れるよう保持）。
        ...(session.companyResearchLogId
          ? {
              companyResearchLogId: session.companyResearchLogId,
              companyResearchSnapshot: session.companyResearchSnapshot,
            }
          : {}),
      };
      appendInterviewResult(resultLog);
      // Supabase durable mirror（best-effort / member のみ）。
      if (userIdRef.current) {
        void upsertCareerInterviewSessionsToSupabase(userIdRef.current, [completed]);
        void upsertCareerInterviewResultsToSupabase(userIdRef.current, [resultLog]);
        // P16-D: Personal Memory shadow write（完成 result のみ・flag OFF 既定＝no-op / best-effort / prompt 非利用）。
        void shadowWriteInterviewMemory();
        // Event Log（本文なし・fire-and-forget / member のみ）。面接回答本文は渡さない。
        void recordCareerEvent(userIdRef.current, {
          feature: 'interview',
          eventType: 'feature_completed',
          completionStatus: 'completed',
          clientEventId: resultLog.id,
          metadata: {
            ...(session.interviewType ? { interviewType: session.interviewType } : {}),
            ...(session.mode ? { mode: session.mode } : {}),
          },
        });
      }
      router.push('/career/interview/result');
    } catch (e) {
      setError(e instanceof Error ? e.message : '評価の生成に失敗しました。');
      setPhase('finished');
    }
  }, [session, cancelSpeak, router]);

  if (!isMounted) return null;

  // 進行中セッションが無い場合。
  if (!session) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <PageHeader title="面接" description="" />
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">進行中の面接がありません。</p>
          <Link
            href="/career/interview/setup"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            面接を始める →
          </Link>
        </Card>
      </div>
    );
  }

  const progressPct = Math.min(100, Math.round((answered / maxTurns) * 100));
  const questionNumber = Math.min(answered + 1, maxTurns);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="面接中" description="面接官AIの質問に回答してください。" />

      {/* 面接官アバター（状態表示） */}
      <Card variant="soft" padding="md" className="mb-5">
        <InterviewerAvatar
          role={modeConfig.interviewerRole}
          modeLabel={modeConfig.label}
          state={avatarState}
        />
      </Card>

      {/* 進行バー */}
      <div className="mb-5">
        <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
          <span>
            質問 {questionNumber} / {maxTurns}
          </span>
          <span>{formatElapsed(elapsed)}</span>
        </div>
        <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full bg-blue-600 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {reaction && phase === 'answering' && (
        <p className="mb-3 text-xs text-slate-500 italic">面接官: {reaction}</p>
      )}

      {/* 現在の質問 */}
      {question && (
        <Card variant="soft" padding="md" className="mb-5">
          <div className="flex items-start justify-between gap-3">
            <p className="text-base font-bold text-slate-900 leading-relaxed whitespace-pre-wrap">
              {question}
            </p>
            {ttsSupported && (
              <button
                type="button"
                onClick={() => speak(question)}
                className="shrink-0 text-xs text-blue-600 hover:underline"
                aria-label="質問を読み上げる"
              >
                🔊 読み上げ
              </button>
            )}
          </div>
        </Card>
      )}

      {/* 回答（評価前のみ） */}
      {phase !== 'finished' && phase !== 'evaluating' && (
        <Card variant="soft" padding="md" className="mb-5">
          <label className="block text-sm font-bold text-slate-800 mb-2">あなたの回答</label>
          <Textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="回答を入力してください。"
            rows={5}
            disabled={phase === 'thinking'}
          />
          {isVoice && (
            <div className="mt-3 flex items-center gap-3">
              {sttSupported ? (
                <Button
                  variant={listening ? 'outline' : 'primary'}
                  size="sm"
                  onClick={listening ? stopListening : startListening}
                  disabled={phase === 'thinking'}
                >
                  {listening ? '■ 録音を止める' : '🎤 録音して回答'}
                </Button>
              ) : (
                <span className="text-xs text-amber-700">
                  このブラウザは音声認識に未対応です。テキストで入力してください。
                </span>
              )}
              {listening && (
                <span className="text-xs text-slate-500">録音中… {interimText}</span>
              )}
            </div>
          )}

          {error && (
            <p className="mt-3 text-sm text-red-600 leading-relaxed" role="alert">
              {error}
            </p>
          )}

          <div className="mt-4 flex flex-col sm:flex-row gap-3">
            <Button
              variant="primary"
              size="md"
              onClick={handleSubmit}
              disabled={phase === 'thinking' || !answer.trim()}
              className="w-full sm:w-auto"
            >
              {phase === 'thinking' ? '面接官が考えています…' : '回答を送る →'}
            </Button>
            {answered >= 1 && (
              <Button
                variant="outline"
                size="md"
                onClick={handleComplete}
                disabled={phase === 'thinking'}
                className="w-full sm:w-auto"
              >
                ここで終了して評価を見る
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* 面接終了（上限到達 or 早期終了） */}
      {(phase === 'finished' || phase === 'evaluating') && (
        <Card variant="soft" padding="md" className="mb-5">
          {reaction && <p className="mb-3 text-xs text-slate-500 italic">面接官: {reaction}</p>}
          <p className="text-sm font-bold text-slate-800 mb-1">面接が終了しました</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">
            お疲れさまでした。AIが回答全体を評価します。
          </p>
          {error && (
            <p className="mb-3 text-sm text-red-600 leading-relaxed" role="alert">
              {error}
            </p>
          )}
          <Button
            variant="primary"
            size="md"
            onClick={handleComplete}
            disabled={phase === 'evaluating'}
            className="w-full sm:w-auto"
          >
            {phase === 'evaluating' ? '評価を作成中…' : '評価を見る →'}
          </Button>
        </Card>
      )}

      <div className="mt-2">
        <Link
          href="/career/interview"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← 中断して面接トップに戻る
        </Link>
      </div>
    </div>
  );
}

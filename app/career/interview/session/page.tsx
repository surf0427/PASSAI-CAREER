'use client';

// PASSAI 就活版 — 面接AI session 画面（ターン制の本体・音声面接）。
//
// 受験版 InterviewAiClient の UX（進行バー・質問読み上げ・回答→深掘り・タイマー・録音UI）を
// 踏襲しつつ、会話状態は localStorage（careerInterviewSessions）で保持し、各ターン生成は
// ステートレス API（/api/career/interview/{turn,complete}）に委ねる。DB / 課金 / usage 非接続。
//
// ★ 本番 UX: 回答は音声のみ。キーボードで回答を入力する UI は持たない。
//   ただし **内部の text pipeline は維持する**（削除してはいけない）:
//     ユーザー発話 → STT（Web Speech）→ transcript → LLM（turn/complete API）→
//     AI 応答テキスト → TTS 読み上げ / 評価用 transcript。
//   画面に出る「認識された回答」は STT transcript の確認表示であり、テキスト面接ではない。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { buildInterviewContextPayload } from '../contextSource';
import {
  getInProgressInterviewSession,
  upsertInterviewSession,
  appendInterviewResult,
} from '../interviewStorage';
import { useVoice } from '../useVoice';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
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
    voiceError,
    clearVoiceError,
    startListening,
    stopListening,
    speak,
    cancelSpeak,
  } = useVoice({ onFinalTranscript });

  const question = currentQuestion(session);
  const answered = countAnswers(session);
  const maxTurns = session?.maxTurns ?? 5;
  const interviewType = resolveInterviewType(session?.interviewType);
  const modeConfig = getInterviewModeConfig(interviewType);

  // 入力モード判定。新規セッションは常に 'voice'（setup 側で固定）。
  // 'text' は旧ログ／旧進行中セッションの read 互換のためだけに残る語彙なので、
  // 「明示的に 'text' のときだけテキスト面接の見た目」に倒す（未指定・不正値は音声扱い）。
  const isVoiceMode = session?.mode !== 'text';
  // 音声モードでは質問を「耳で聞く」ため、質問本文は画面に出さない。
  // ただし TTS 非対応ブラウザでは読み上げが届かないため、その場合だけ本文表示にフォールバックする
  // （出さないと質問が一切分からなくなり面接が成立しない）。
  const showQuestionText = !isVoiceMode || !ttsSupported;

  // アバターの状態（評価/思考 → thinking、録音中 → listening、読み上げ中 → speaking）。
  const avatarState: AvatarState =
    phase === 'thinking' || phase === 'evaluating'
      ? 'thinking'
      : listening
        ? 'listening'
        : speaking
          ? 'speaking'
          : 'idle';

  // 新しい質問が来たら読み上げる（音声モード かつ TTS 対応時）。
  // 旧 'text' セッションを再開したときは自動読み上げしない（旧テキスト面接の挙動を保つ）。
  const lastSpokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isMounted || !question) return;
    if (isVoiceMode && ttsSupported && lastSpokenRef.current !== question) {
      lastSpokenRef.current = question;
      speak(question);
    }
  }, [isMounted, question, isVoiceMode, ttsSupported, speak]);

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
            href="/career/interview/target"
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

      {/* 現在の質問。
          - 音声モード（TTS 可）: 質問本文は表示しない（耳で聞く）。聞き直すための操作だけを置く。
          - それ以外（旧 text セッション / TTS 非対応）: これまでどおり質問本文を表示する。 */}
      {question && showQuestionText && (
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
      {question && !showQuestionText && (
        <div className="mb-5 flex flex-col items-center gap-1.5">
          <p className="text-xs text-slate-400">聞き逃したときは</p>
          <Button
            variant="outline"
            size="md"
            onClick={() => speak(question)}
            aria-label="質問をもう一度聞く"
          >
            🔊 もう一度聞く
          </Button>
        </div>
      )}

      {/* 回答（音声のみ・評価前のみ） */}
      {phase !== 'finished' && phase !== 'evaluating' && (
        <Card variant="soft" padding="md" className="mb-5">
          <p
            className={`block text-sm font-bold text-slate-800 mb-2 ${
              isVoiceMode ? 'text-center' : ''
            }`}
          >
            あなたの回答（音声）
          </p>

          {/* 録音操作。マイクが使えない環境でもテキスト面接へは倒さない（案内と再試行のみ）。
              音声モードでは「次に押す場所」が一目で分かるよう主役 CTA サイズにする。 */}
          <div
            className={
              isVoiceMode
                ? 'flex flex-col items-center gap-2'
                : 'flex flex-wrap items-center gap-3'
            }
          >
            <Button
              variant={listening ? 'outline' : 'primary'}
              size={isVoiceMode ? 'lg' : 'sm'}
              className={
                isVoiceMode
                  ? 'w-full gap-2 px-8 py-4 text-base shadow-sm sm:w-auto sm:min-w-[18rem] sm:text-lg'
                  : ''
              }
              onClick={
                listening
                  ? stopListening
                  : () => {
                      clearVoiceError();
                      startListening();
                    }
              }
              disabled={phase === 'thinking'}
            >
              {listening ? '■ 録音を止める' : '🎙 録音して回答'}
            </Button>
            {listening && <span className="text-xs text-slate-500">録音中…</span>}
            {answer && !listening && (
              <button
                type="button"
                onClick={() => setAnswer('')}
                disabled={phase === 'thinking'}
                className="text-xs text-slate-500 hover:text-slate-800 underline disabled:opacity-50"
              >
                取り消して話し直す
              </button>
            )}
          </div>

          {/* STT transcript の確認表示（内部 text pipeline の可視化。入力欄ではない）。
              ★ 音声モードでは「入力欄に見える枠」を出さない（テキスト入力を促す見た目にしない）。
                発話が認識されたときだけ、字幕のように確認表示する。 */}
          {isVoiceMode ? (
            answer || interimText ? (
              <p className="mt-4 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap text-center">
                {answer}
                {interimText && (
                  <span className="text-slate-400">{answer ? ` ${interimText}` : interimText}</span>
                )}
              </p>
            ) : (
              <p className="mt-3 text-xs text-slate-400 leading-relaxed text-center">
                マイクに向かって話すと、認識された内容がここに表示されます。
              </p>
            )
          ) : (
            <div className="mt-3 min-h-[88px] rounded-xl bg-white ring-1 ring-slate-200 px-3 py-2.5">
              {answer || interimText ? (
                <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                  {answer}
                  {interimText && (
                    <span className="text-slate-400">
                      {answer ? ` ${interimText}` : interimText}
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-sm text-slate-400 leading-relaxed">
                  「録音して回答」を押して、マイクに向かって話してください。話した内容がここに表示されます。
                </p>
              )}
            </div>
          )}

          {!sttSupported && (
            <p className="mt-3 text-sm text-amber-700 leading-relaxed" role="alert">
              このブラウザは音声認識に対応していません。面接は音声で行うため、Chrome
              など対応ブラウザで開き直し、マイクの使用を許可してください。
            </p>
          )}
          {voiceError && (
            <p className="mt-3 text-sm text-amber-700 leading-relaxed" role="alert">
              {voiceError}
            </p>
          )}
          {error && (
            <p className="mt-3 text-sm text-red-600 leading-relaxed" role="alert">
              {error}
            </p>
          )}

          <div
            className={`mt-4 flex flex-col sm:flex-row gap-3 ${
              isVoiceMode ? 'sm:justify-center' : ''
            }`}
          >
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

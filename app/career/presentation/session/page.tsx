'use client';

// PASSAI 就活版 — プレゼン対策AI session（録画相当）画面。
//
// 受験版は MediaRecorder 動画録画 + Whisper STT + Supabase Storage だが、就活版は
// 「localStorage canonical / Supabase 非接続 / 課金なし」方針のため、ブラウザ標準の
// Web Speech API でライブ文字起こしする（動画保存はしない）。テキスト貼り付けにもフォールバックできる。
// 文字起こしは送信前に自由に編集できる（音声認識の誤りを直せる）。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { buildPresentationContextPayload } from '../contextSource';
import {
  getInProgressPresentationSession,
  upsertPresentationSession,
  appendPresentationResult,
} from '../presentationStorage';
import { getScenarioConfig } from '../presentationModes';
import { useVoice } from '@/app/career/interview/useVoice';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import {
  upsertCareerPresentationSessionsToSupabase,
  upsertCareerPresentationResultsToSupabase,
} from '@/lib/supabase/careerPresentation';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import { toScoreBand } from '@/lib/careerEvents/sanitize';
import type {
  CareerPresentationSession,
  CareerPresentationResult,
} from '@/types/careerPresentation';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function formatClock(sec: number): string {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.max(0, sec) % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function CareerPresentationSessionPage() {
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

  // セッションは setup で作成済み。本画面では読み取りのみ（更新は localStorage へ直接行う）。
  const [session] = useState<CareerPresentationSession | null>(
    () => getInProgressPresentationSession(),
  );
  const [transcript, setTranscript] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFinalTranscript = useCallback((text: string) => {
    setTranscript((prev) => (prev ? `${prev} ${text}` : text));
  }, []);
  const { sttSupported, listening, interimText, startListening, stopListening } = useVoice({
    onFinalTranscript,
  });

  const isVoice = session?.mode === 'voice';
  const timeLimitSec = session?.timeLimitSec ?? 0;
  const scenarioCfg = getScenarioConfig(session?.config?.scenario);
  const remaining = timeLimitSec > 0 ? timeLimitSec - elapsed : 0;

  // 録音中は経過時間を加算（durationSec の実測に使う）。制限時間に達したら自動停止。
  useEffect(() => {
    if (!listening) return;
    const id = setInterval(() => {
      setElapsed((s) => {
        const next = s + 1;
        if (timeLimitSec > 0 && next >= timeLimitSec) {
          // 制限時間に到達したら停止（次tickを待たずに止める）。
          stopListening();
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [listening, timeLimitSec, stopListening]);

  const handleEvaluate = useCallback(async () => {
    if (!session || evaluating) return;
    const text = transcript.trim();
    if (!text) {
      setError('発表内容が空です。録音するか、原稿を入力してください。');
      return;
    }
    if (listening) stopListening();
    setEvaluating(true);
    setError(null);

    // テキストモードは durationSec を測れないため 0（評価側は未設定として扱う）。
    const durationSec = isVoice ? elapsed : 0;
    const ctx = buildPresentationContextPayload();
    try {
      const res = await fetch('/api/career/presentation/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...ctx,
          config: session.config ?? null,
          theme: session.theme,
          timeLimitSec: session.timeLimitSec,
          durationSec,
          transcript: text,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? '評価の生成に失敗しました。');
      }
      const data = (await res.json()) as { result: CareerPresentationResult['result'] };

      const completed: CareerPresentationSession = {
        ...session,
        status: 'completed',
        durationSec,
        transcript: text,
        updatedAt: new Date().toISOString(),
      };
      upsertPresentationSession(completed);
      const resultLog: CareerPresentationResult = {
        id: session.id,
        createdAt: new Date().toISOString(),
        presentationType: session.presentationType,
        config: session.config,
        mode: session.mode,
        theme: session.theme,
        timeLimitSec: session.timeLimitSec,
        durationSec,
        transcript: text,
        result: data.result,
      };
      appendPresentationResult(resultLog);
      // Supabase durable mirror（best-effort / member のみ）。
      if (userIdRef.current) {
        void upsertCareerPresentationSessionsToSupabase(userIdRef.current, [completed]);
        void upsertCareerPresentationResultsToSupabase(userIdRef.current, [resultLog]);
        // Event Log（本文なし・fire-and-forget / member のみ）。プレゼン本文・お題本文・Q&A・
        // feedback 本文は渡さない。生スコアは band 化する。config の enum のみ metadata に載せる。
        const cfg = resultLog.config;
        void recordCareerEvent(userIdRef.current, {
          feature: 'presentation',
          eventType: 'feature_completed',
          completionStatus: 'completed',
          clientEventId: resultLog.id,
          scoreBand: toScoreBand(data.result.totalScore),
          industry: cfg?.industry || null,
          jobType: cfg?.jobType || null,
          metadata: {
            mode: resultLog.mode,
            ...(cfg?.scenario && cfg.scenario !== 'unspecified'
              ? { scenario: cfg.scenario }
              : {}),
            ...(cfg?.format && cfg.format !== 'unspecified' ? { format: cfg.format } : {}),
            ...(cfg?.selectionType ? { selectionType: cfg.selectionType } : {}),
          },
        });
      }
      router.push('/career/presentation/result');
    } catch (e) {
      setError(e instanceof Error ? e.message : '評価の生成に失敗しました。');
      setEvaluating(false);
    }
  }, [session, evaluating, transcript, listening, stopListening, isVoice, elapsed, router]);

  if (!isMounted) return null;

  if (!session) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <PageHeader title="プレゼン" description="" />
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-600 mb-4">進行中のプレゼンがありません。</p>
          <Link
            href="/career/presentation/target"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-600 hover:underline"
          >
            プレゼンを始める →
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="発表中" description="テーマに沿って発表してください。発表後にAIが評価します。" />

      {/* テーマ・条件 */}
      <Card variant="soft" padding="md" className="mb-5">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">
          {scenarioCfg.emoji} {scenarioCfg.label}
        </p>
        <p className="text-base font-bold text-slate-900 leading-relaxed whitespace-pre-wrap">
          {session.theme}
        </p>
        <p className="mt-2 text-xs text-slate-500">
          制限時間 {formatClock(timeLimitSec)}
          {isVoice && (
            <>
              {' ・ '}
              {listening ? `残り ${formatClock(remaining)}` : `経過 ${formatClock(elapsed)}`}
            </>
          )}
        </p>
      </Card>

      {/* 録音（音声モード） */}
      {isVoice && (
        <Card variant="soft" padding="md" className="mb-5">
          {sttSupported ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant={listening ? 'outline' : 'primary'}
                size="md"
                onClick={listening ? stopListening : startListening}
                disabled={evaluating}
              >
                {listening ? '■ 録音を止める' : '🎤 録音して発表する'}
              </Button>
              {listening && (
                <span className="text-xs text-emerald-700 font-semibold">● 録音中</span>
              )}
            </div>
          ) : (
            <p className="text-xs text-amber-700 leading-relaxed">
              このブラウザは音声認識に未対応です。下のテキスト欄に発表内容を入力してください。
            </p>
          )}
          {listening && interimText && (
            <p className="mt-3 text-xs text-slate-500">認識中… {interimText}</p>
          )}
        </Card>
      )}

      {/* 文字起こし / 原稿（送信前に編集可） */}
      <Card variant="soft" padding="md" className="mb-5">
        <label className="block text-sm font-bold text-slate-800 mb-2">
          {isVoice ? '文字起こし（送信前に編集できます）' : '発表原稿'}
        </label>
        <Textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder={
            isVoice
              ? '録音すると、ここに文字起こしが追記されます。誤りは直接修正できます。'
              : '発表する内容を入力・貼り付けしてください。'
          }
          rows={10}
          disabled={evaluating}
        />

        {error && (
          <p className="mt-3 text-sm text-red-600 leading-relaxed" role="alert">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-col sm:flex-row gap-3">
          <Button
            variant="primary"
            size="md"
            onClick={handleEvaluate}
            disabled={evaluating || !transcript.trim()}
            className="w-full sm:w-auto"
          >
            {evaluating ? 'AIが評価しています…' : '発表を終えて評価を見る →'}
          </Button>
        </div>
      </Card>

      <div className="mt-2">
        <Link
          href="/career/presentation"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← 中断してプレゼントップに戻る
        </Link>
      </div>
    </div>
  );
}

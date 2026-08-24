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
import { useVoice } from '@/app/career/interview/useVoice';
import { useCurrentUserId } from '@/app/career/components/CareerAuthProvider';
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

// 発表中の文字起こしを localStorage へ保存するまでの待ち時間（ms）。
// 音声認識の確定は数秒に 1 回程度なので、この程度なら write 連打にならず取りこぼしも小さい。
const DRAFT_SAVE_DEBOUNCE_MS = 800;

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
  // P1-2: 発表中の文字起こしは localStorage の in_progress セッションが正本。
  //   初期値をそこから復元することで、誤リロード / タブ復帰でも発表内容が消えない。
  const [transcript, setTranscript] = useState<string>(() => session?.transcript ?? '');
  const [elapsed, setElapsed] = useState<number>(() => session?.durationSec ?? 0);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 「発表中」か。タイマーと自動再開の権限をこの state が持つ。
  //   ★ listening ではなく presenting で駆動する理由:
  //     Web Speech API は無音などで勝手に onend を出すため、listening を時計の条件にすると
  //     ブラウザ都合の一瞬の中断で経過時間が止まり、durationSec と timeManagement 評価が壊れる。
  const [presenting, setPresenting] = useState(false);

  // ── 経過秒・文字起こしの ref（tick / flush から最新値を読むための正本）──────
  //   宣言をここに置くのは、下のタイマー effect と draft 保存の双方から参照するため。
  const elapsedRef = useRef<number>(session?.durationSec ?? 0);
  const transcriptRef = useRef<string>(session?.transcript ?? '');
  // 直近に localStorage へ書いた文字起こし（差分が無ければ書かない）。
  const lastSavedRef = useRef<string>(session?.transcript ?? '');
  // 評価が確定（completed 書き込み済み）したら以後 draft を書かないための門。
  const finishedRef = useRef(false);

  const onFinalTranscript = useCallback((text: string) => {
    setTranscript((prev) => (prev ? `${prev} ${text}` : text));
  }, []);
  const {
    sttSupported,
    listening,
    interimText,
    voiceError,
    recognitionStopped,
    recognitionStoppedMessage,
    startListening,
    stopListening,
  } = useVoice({
    onFinalTranscript,
    // P1-3: プレゼンだけ自動再開を有効にする（面接は従来挙動のまま）。
    autoRestart: true,
    presenting,
  });

  const isVoice = session?.mode === 'voice';
  const timeLimitSec = session?.timeLimitSec ?? 0;
  const remaining = timeLimitSec > 0 ? timeLimitSec - elapsed : 0;

  // ── 発表中の経過時間（durationSec の実測に使う）──────────────────────
  //   presenting の間だけ 1 秒刻みで加算する。認識の一時中断では止まらない。
  //   ★ 経過秒の正本は elapsedRef。tick 内で ref を進めてから state へ反映することで、
  //     「同じ tick の中で制限時間到達を判定する」を副作用フックなしに実現する
  //     （setElapsed の更新関数の中で stopListening を呼ばない／effect 本体で setState しない）。
  useEffect(() => {
    if (!presenting) return;
    const id = setInterval(() => {
      const next = elapsedRef.current + 1;
      elapsedRef.current = next;
      setElapsed(next);
      if (timeLimitSec > 0 && next >= timeLimitSec) {
        setPresenting(false);
        stopListening('time_limit');
      }
    }, 1000);
    return () => clearInterval(id);
  }, [presenting, timeLimitSec, stopListening]);

  // 録音の開始 / 停止（presenting と音声認識の状態を必ず一緒に動かす）。
  const handleStartPresenting = useCallback(() => {
    setPresenting(true);
    startListening();
  }, [startListening]);

  const handleStopPresenting = useCallback(() => {
    setPresenting(false);
    stopListening('manual_stop');
  }, [stopListening]);

  // ── P1-2: 発表中の文字起こしを localStorage へ debounce 保存 ────────────
  //
  // 監査 P1-2: transcript が React state のみだったため、発表途中のリロード・タブ復帰・
  //   モバイルのバックグラウンド破棄で 3 分話した内容が丸ごと消えていた。
  //
  // 契約:
  //   - canonical helper（upsertPresentationSession）だけを使う。専用ストレージを作らない。
  //   - 音声認識の確定ごとに書かず debounce する（連続発話中の write 連打を避ける）。
  //   - 評価が始まったら書かない（completed への遷移を in_progress で上書きしない）。
  //   - Supabase へは送らない。ここで防ぎたいのは「誤リロードでの消失」であり、
  //     durable mirror は従来どおり評価確定時に 1 回だけ行う。
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  const persistDraft = useCallback(() => {
    if (finishedRef.current || !session) return;
    const text = transcriptRef.current;
    if (text === lastSavedRef.current) return;
    upsertPresentationSession({
      ...session,
      status: 'in_progress',
      transcript: text,
      durationSec: elapsedRef.current,
      updatedAt: new Date().toISOString(),
    });
    lastSavedRef.current = text;
  }, [session]);

  useEffect(() => {
    if (!session || evaluating || finishedRef.current) return;
    if (transcript === lastSavedRef.current) return;
    const id = setTimeout(persistDraft, DRAFT_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [session, transcript, evaluating, persistDraft]);

  // アンマウント（中断して戻る等）と pagehide（モバイルのタブ破棄・アプリ切替）で
  //   未保存分を確定保存する。debounce の待ち時間中に離脱しても取りこぼさない。
  //   ★ iOS Safari は visibilitychange/pagehide の後にタブを破棄しうるため、mobile では必須。
  useEffect(() => {
    const flush = () => persistDraft();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      flush();
    };
  }, [persistDraft]);

  const handleEvaluate = useCallback(async () => {
    if (!session || evaluating) return;
    const text = transcript.trim();
    if (!text) {
      setError('発表内容が空です。録音するか、原稿を入力してください。');
      return;
    }
    // 発表を終える（自動再開の権限を降ろしてからマイクを止める）。
    setPresenting(false);
    if (listening) stopListening('manual_stop');
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
          // 企業公式情報の出し分けに使う（旧セッションの自己PR / ガクチカは除外される）。
          presentationType: session.presentationType,
          theme: session.theme,
          timeLimitSec: session.timeLimitSec,
          durationSec,
          transcript: text,
          // 発表資料（任意・setup で貼り付けたもの）。session が正本。
          //   未入力なら '' を送り、評価は従来どおり（資料なしで減点されない）。
          material: session.material ?? '',
          // 発表資料ファイル（任意）。★ path は送らない（server が identity から再生成する）。
          //   送るのは「どのセッションの・何形式の資料か」だけ。
          materialFile: session.materialFile
            ? {
                sessionId: session.id,
                mimeType: session.materialFile.mimeType,
                fileName: session.materialFile.fileName,
              }
            : null,
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
      // 以後 draft を書かない（completed を in_progress で上書きしないための門）。
      finishedRef.current = true;
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
      // 発表資料（任意）。あるときだけ履歴にも残す（session と同じ lifecycle）。
      if (session.material) resultLog.material = session.material;
      if (session.materialFile) resultLog.materialFile = session.materialFile;
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
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">お題</p>
        <p className="text-base font-bold text-slate-900 leading-relaxed whitespace-pre-wrap">
          {session.theme}
        </p>
        <p className="mt-2 text-xs text-slate-500">
          制限時間 {formatClock(timeLimitSec)}
          {isVoice && (
            <>
              {' ・ '}
              {presenting ? `残り ${formatClock(remaining)}` : `経過 ${formatClock(elapsed)}`}
            </>
          )}
        </p>

        {/* 発表資料（setup で貼り付けたもの）。あるときだけ表示する。
            発表中に見返せるよう折りたたみで置き、評価に使われることを明示する。 */}
        {(session.material || session.materialFile) && (
          <details className="mt-3 rounded-lg bg-white ring-1 ring-slate-200 px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-slate-700">
              発表資料（評価に使用されます）
            </summary>
            {session.materialFile && (
              <p className="mt-2 text-xs text-slate-600 break-all">
                📎 {session.materialFile.fileName}
              </p>
            )}
            {session.material && (
              <p className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-xs text-slate-600 leading-relaxed">
                {session.material}
              </p>
            )}
          </details>
        )}
      </Card>

      {/* 録音（音声モード） */}
      {isVoice && (
        <Card variant="soft" padding="md" className="mb-5">
          {sttSupported ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant={presenting ? 'outline' : 'primary'}
                size="md"
                onClick={presenting ? handleStopPresenting : handleStartPresenting}
                disabled={evaluating}
              >
                {presenting ? '■ 録音を止める' : '🎤 録音して発表する'}
              </Button>
              {listening ? (
                <span className="text-xs text-emerald-700 font-semibold">● 録音中</span>
              ) : (
                presenting && (
                  // 自動再開の待ち時間。無表示にすると「止まった」と誤解されるため必ず出す。
                  <span className="text-xs text-amber-700 font-semibold">● 再接続中…</span>
                )
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

          {/* P1-3: マイク不許可・no-speech・network 等を必ず表示する（無反応をゼロにする）。 */}
          {voiceError && (
            <p className="mt-3 text-sm text-red-600 leading-relaxed" role="alert">
              {voiceError}
            </p>
          )}
          {/* P1-3: 自動再開できなかった停止を必ず表示する（無言停止をゼロにする）。 */}
          {recognitionStopped && (
            <p className="mt-3 text-sm text-amber-700 leading-relaxed" role="alert">
              {recognitionStoppedMessage}
            </p>
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

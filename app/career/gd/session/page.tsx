'use client';

// PASSAI 就活版 — GD session 画面（ソロプレイ・**完全音声型**の本体）。
//
// 会話状態は localStorage（careerGdSessions）で保持し、各発言/評価はステートレス API
// （/api/career/gd/{turn,feedback}）に委ねる。DB / 課金 / usage 非接続。
//
// ★ STEP-GD-VOICE: ユーザーが文字を入力する場所は存在しない。
//   進行: マイクが常時開いている → 話す → 無音で 1 発言が自動確定（voiceSegmenter）
//         → /api/career/gd/voice/stt で文字起こし → transcript へ追記
//         → AI が 1 名応答し、その発言を **音声で再生**する（useCareerGdTts）。
//   文字起こしは評価の根拠として保持・表示するが、ユーザーが編集・送信する欄にはしない。
// 強すぎない AI・ユーザーの発言機会確保のため、AI は1回につき1名だけ発言する。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { GD_ROLE_LABELS } from '../gdRoles';
import { GdCircleStage, useRecentSpeaker, type GdStageParticipant } from '../components/stage';
import { GdVoiceBar } from '../components/voice/GdVoiceBar';
import { useCareerGdMic } from '@/hooks/useCareerGdMic';
import { useCareerGdVoiceCapture } from '@/hooks/useCareerGdVoiceCapture';
import { useCareerGdTts } from '@/hooks/useCareerGdTts';
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
  const [phase, setPhase] = useState<Phase>('discussing');
  // 音声の確定は非同期（STT の往復）で届くため、コールバック内から最新 phase を読む必要がある。
  // deps に phase を入れると onTranscript が作り替わって録音側の ref が揺れるので ref で持つ。
  const phaseRef = useRef<Phase>('discussing');
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

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

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

  /**
   * ユーザーの発言が音声から確定したときに呼ばれる（STEP-GD-VOICE）。
   *
   * ★ phase が 'ai-thinking' でも **発言は必ず記録する**。
   *   AI の生成待ちの最中に話した内容を捨てると、ユーザーには「自分の発言が消えた」
   *   としか見えない（テキスト時代は入力欄に残っていたので気付けたが、音声では消滅する）。
   *   AI の応答トリガだけを phase で制御する。
   *
   * ★ 最新の session は localStorage から読み直す。STT の往復中に AI 発言が
   *   追記されている可能性があり、state の closure を信じると発言が上書きで消える。
   */
  const commitUserSpeech = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const latest = getInProgressGdSession();
      if (!latest) return;
      const me = latest.participants.find((p) => p.isSelf);
      if (!me) return;
      if (speechCount(latest) >= MAX_UTTERANCES) return;

      const utterance: GdUtterance = {
        id: newId('gdu'),
        participantId: me.id,
        content: trimmed,
        createdAt: new Date().toISOString(),
        kind: 'speech',
      };
      const next: CareerGdSession = {
        ...latest,
        transcript: [...latest.transcript, utterance],
        updatedAt: new Date().toISOString(),
      };
      upsertGdSession(next);
      setSession(next);

      // AI 応答は「議論中」のときだけ起動する（生成中の二重起動・評価中の割り込みを防ぐ）。
      if (phaseRef.current === 'discussing' && speechCount(next) < MAX_UTTERANCES) {
        void runAiTurn(next);
      }
    },
    [runAiTurn],
  );

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

  // ── 音声（STEP-GD-VOICE）─────────────────────────────────────────
  //   マイクの所有者は 1 つ（useCareerGdMic）。文字起こしと読み上げがそれを共有する。
  const mic = useCareerGdMic();
  const tts = useCareerGdTts({
    audioContext: mic.audioContext,
    enabled: phase !== 'evaluating',
  });
  // effect の deps には安定した関数参照だけを入れる
  //   （Hook の返り値オブジェクトは毎レンダー新しくなるため、そのまま deps に入れると毎回走る）。
  const { speak: speakVoice, cancelAll: cancelVoice } = tts;
  const capture = useCareerGdVoiceCapture({
    stream: mic.stream,
    audioContext: mic.audioContext,
    // 評価中・発言上限到達後は録音しない（採点対象にならない発言を録っても課金が増えるだけ）。
    enabled: !!session && phase !== 'evaluating' && !reachedCap,
    muted: mic.muted,
    onTranscript: commitUserSpeech,
  });

  // AI の発言を音声で再生する。
  //   speakerKey は 'solo:<AI の並び順>'。同じ AI は常に同じ声になる（誰の発言か耳で分かる）。
  //   読み上げ済み判定は useCareerGdTts が utterance id で行うので、
  //   ここは「未再生のものを渡し直すだけ」で二重再生しない。
  const aiIndexById = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    const ais = (session?.participants ?? []).filter((p) => p.type === 'ai');
    ais.forEach((p, i) => {
      map[p.id] = i;
    });
    return map;
  }, [session]);

  useEffect(() => {
    if (!session || mic.status !== 'ready') return;
    for (const u of session.transcript) {
      if (u.kind === 'system') {
        speakVoice({ id: u.id, text: u.content, speakerKey: 'moderator', participantId: null });
        continue;
      }
      const speaker = session.participants.find((p) => p.id === u.participantId);
      if (!speaker || speaker.type !== 'ai') continue; // 自分の発言は読み上げない
      speakVoice({
        id: u.id,
        text: u.content,
        speakerKey: `solo:${aiIndexById[speaker.id] ?? 0}`,
        participantId: speaker.id,
      });
    }
  }, [session, mic.status, aiIndexById, speakVoice]);

  // マイクが有効になった直後、まだ誰も発言していなければ AI から口火を切る。
  //   音声 GD では「無音の画面を前に、何をすればいいか分からない」が最悪の入口になるため、
  //   最初の一声は必ず AI が出す。1 セッション 1 回だけ（ref で二重起動を防ぐ）。
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    if (mic.status !== 'ready' || !session) return;
    if (speechCount(session) > 0) return;
    if (phase !== 'discussing') return;
    openedRef.current = true;
    // マイク許可（外部システムの状態）が整った瞬間に、外部 API 呼び出しを 1 回だけ起動する。
    // openedRef が再入を防ぐため 1 セッション 1 回で、カスケードレンダリングにはならない。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 上記のとおり外部システムとの同期
    void runAiTurn(session);
  }, [mic.status, session, phase, runAiTurn]);

  // GD を離れる / 評価に入るときは読み上げを止める（結果画面に声が残らない）。
  useEffect(() => {
    if (phase === 'evaluating') cancelVoice();
  }, [phase, cancelVoice]);

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
  // 自分の「発言中」は、実際にマイクへ声が乗っているか（VAD の判定）で決まる。
  //   テキスト時代の「入力中」の置き換えだが、こちらは本物の発話状態である。
  const selfTalking = capture.speaking;
  const stageParticipants = useMemo<GdStageParticipant[]>(() => {
    const list = session?.participants ?? [];
    // 自分を先頭（＝手前中央の席）へ。sort は安定なので他の並びは既存のまま。
    const ordered = [...list].sort((a, b) => (a.isSelf ? 0 : 1) - (b.isSelf ? 0 : 1));
    // speaking は **同時に 1 人だけ**。優先順位を 1 つの speakerId へ解決してから配る。
    //   参加者ごとに独立判定すると「自分が話している最中に AI の読み上げが鳴る」瞬間に
    //   2 人が同時に「発言中」になってしまうため、ここで一意に決める。
    //   ① 自分が実際に話している（VAD）… 音声 GD では自分の発話が最も確かな現在情報
    //   ② AI の読み上げが鳴っている参加者 … 耳で聞こえている人と一致させる
    //   ③ 直近の確定発言者
    const selfId = ordered.find((x) => x.isSelf)?.id ?? null;
    const speakerId = selfTalking ? selfId : (tts.speakingParticipantId ?? recentSpeakerId);
    return ordered.map((p) => {
      const thinking = phase === 'ai-thinking' && p.id === aiSpeakerId;
      const speaking = !thinking && !!speakerId && p.id === speakerId;
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
  }, [session, phase, aiSpeakerId, recentSpeakerId, selfTalking, tts.speakingParticipantId]);

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
      <PageHeader
        title="GD中"
        description="森の円卓で、AI参加者と声でディスカッションを進めてください。文字入力は不要です。"
      />

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
          {/* テーマ（中央 HUD は 1 行に省略されるため、全文・与件はここが正）。 */}
          <div className="gdf-panel">
            <p className="gdf-panel__label">テーマ</p>
            <p className="mt-1 text-[14px] font-bold leading-relaxed text-[#f2fbf3]">
              {session.theme.title || '（テーマ準備中）'}
            </p>
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

          {/* 議論ログ */}
          <div className="gdf-panel">
            {/* 文字起こしは「評価の根拠を確認するための記録」。編集も送信もできない。 */}
            <p className="gdf-panel__label">
              議論ログ・文字起こし（{total} / {MAX_UTTERANCES} 発言）
            </p>
            <div className="gdf-log mt-2">
              {session.transcript.length === 0 ? (
                <p className="gdf-log__empty">
                  {mic.status === 'ready'
                    ? 'まもなくAIメンバーが口火を切ります。そのまま話しかけてください。'
                    : 'マイクを有効にすると、GDが始まります。'}
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

          {/* 発言は音声のみ。文字を入力する要素は置かない（STEP-GD-VOICE）。 */}
          {!reachedCap ? (
            <GdVoiceBar
              micStatus={mic.status}
              micError={mic.errorMessage}
              muted={mic.muted}
              onEnableMic={() => void mic.enable()}
              onToggleMute={mic.toggleMuted}
              captureStatus={capture.status}
              selfSpeaking={capture.speaking}
              captureError={capture.error}
              unusableCount={capture.unusableCount}
              ttsDegraded={tts.degraded}
              // ソロには他の人間参加者がいないので peer 音声の表示自体を出さない。
              peerAudio={null}
              disabled={phase === 'evaluating'}
            />
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
              disabled={phase === 'evaluating' || selfSpeechCount(session) === 0}
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

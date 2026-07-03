'use client';

// PASSAI 就活版 — GD Phase2 マルチGD ルーム画面（STEP-GD-14）。
// room.status に応じて表示を切り替える:
//   waiting  … ロビー（参加待機・host のみ開始）
//   active   … GDセッション（テーマ・残り時間・参加者・発言タイムライン・発言入力・AI発言・host終了）
//   finished … 簡易結果への導線（発言量ベースの暫定フィードバック＋参加ランキング）
//
// 共有状態は Supabase が正本。DB 操作はすべて API route 経由（クライアントは room 系テーブルを直接叩かない）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { useAuthStatus, useIsMember } from '@/app/components/AuthProvider';
import { GD_FORMAT_LABELS, GD_ROLE_LABELS } from '../../gdRoles';
import { GdEvaluationDetail } from '../../GdEvaluationDetail';
import { appendGdRoomLog } from '../../gdRoomLogStorage';
import type {
  CareerGdRoomDetailResponse,
  CareerGdRoomMember,
  CareerGdRoomMessage,
  CareerGdRoomResultView,
  CareerGdRoomLog,
  GdRoomStatus,
} from '@/types/careerGd';

const STATUS_LABELS: Record<GdRoomStatus, string> = {
  waiting: '参加受付中',
  active: 'GD進行中',
  finished: '終了',
  cancelled: '中止',
};

const POLL_INTERVAL_MS = 3000;

function newClientMsgId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `c-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// ── ルート（auth / 初期ロード / status ルーティング） ──────────────────

export default function CareerGdRoomPage() {
  const params = useParams<{ roomId: string }>();
  const roomId = params?.roomId ?? '';
  const authStatus = useAuthStatus();
  const isMember = useIsMember();

  const [detail, setDetail] = useState<CareerGdRoomDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}`);
      const data = (await res.json().catch(() => null)) as
        | (CareerGdRoomDetailResponse & { error?: string; detail?: string })
        | null;
      if (!res.ok || !data?.room) {
        throw new Error(data?.detail ?? 'ルーム情報の取得に失敗しました。');
      }
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ルーム情報の取得に失敗しました。');
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    if (authStatus === 'loading' || !isMember) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- API fetch on mount（外部同期）
    void refresh();
  }, [authStatus, isMember, refresh]);

  if (authStatus === 'loading') {
    return (
      <Shell status="waiting">
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      </Shell>
    );
  }

  if (!isMember) {
    return (
      <Shell status="waiting">
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm font-bold text-slate-800 mb-2">ログインが必要です</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            マルチGDルームの閲覧にはログインが必要です。
          </p>
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
          >
            ログインする →
          </Link>
        </Card>
        <BackLink />
      </Shell>
    );
  }

  if (loading && !detail && !error) {
    return (
      <Shell status="waiting">
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      </Shell>
    );
  }

  if (error || !detail) {
    return (
      <Shell status="waiting">
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm text-red-600 leading-relaxed mb-3" role="alert">
            {error ?? 'ルームを表示できません。'}
          </p>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            参加者でない、またはルームが存在しない可能性があります。合言葉で参加し直すか、GDトップへ戻ってください。
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              href="/career/gd/room/join"
              className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              合言葉で参加する →
            </Link>
            <BackLink />
          </div>
        </Card>
      </Shell>
    );
  }

  const status = detail.room.status;
  return (
    <Shell status={status}>
      {status === 'active' ? (
        <ActiveView initial={detail} onStatusChanged={refresh} />
      ) : status === 'waiting' ? (
        <WaitingView detail={detail} loading={loading} onRefresh={refresh} onStarted={setDetail} />
      ) : status === 'finished' ? (
        <FinishedView detail={detail} onRefresh={refresh} />
      ) : (
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm font-bold text-slate-800 mb-1">このルームは終了しています</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            {STATUS_LABELS[status]}の状態です。新しくGDを行うには、合言葉で別のルームに参加してください。
          </p>
        </Card>
      )}
      <div className="mt-5 flex flex-col sm:flex-row gap-3">
        <BackLink />
      </div>
    </Shell>
  );
}

// ── waiting（ロビー） ────────────────────────────────────────────────

function WaitingView({
  detail,
  loading,
  onRefresh,
  onStarted,
}: {
  detail: CareerGdRoomDetailResponse;
  loading: boolean;
  onRefresh: () => void;
  onStarted: (d: CareerGdRoomDetailResponse) => void;
}) {
  const { room, members, isHost } = detail;
  const humanCount = members.filter((m) => !m.isAi && !m.leftAt).length;
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch(`/api/career/gd/room/${encodeURIComponent(room.id)}/start`, { method: 'POST' });
      const data = (await res.json().catch(() => null)) as
        | (CareerGdRoomDetailResponse & { error?: string; detail?: string })
        | null;
      if (!res.ok || !data?.room) {
        onRefresh();
        throw new Error(data?.detail ?? 'ルームの開始に失敗しました。');
      }
      onStarted(data);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'ルームの開始に失敗しました。');
    } finally {
      setStarting(false);
    }
  }, [room.id, onRefresh, onStarted]);

  return (
    <>
      <div className="flex items-center justify-end mb-4">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? '更新中…' : '更新'}
        </Button>
      </div>

      <Card variant="soft" padding="md" className="mb-5">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">ルーム情報</p>
        <div className="grid grid-cols-3 gap-y-2 gap-x-4 text-sm">
          <Info label="形式" value={GD_FORMAT_LABELS[room.format]} />
          <Info label="予定人数" value={`${room.plannedParticipantCount}人`} />
          <Info label="制限時間" value={`${Math.round(room.timeLimitSec / 60)}分`} />
        </div>
        {isHost && (
          <p className="mt-4 text-xs text-amber-700 leading-relaxed">
            あなたはホストです。参加コードはセキュリティのため再表示できません。作成時に表示された6桁コードを参加者に共有してください。
          </p>
        )}
      </Card>

      <MembersCard members={members} plannedCount={room.plannedParticipantCount} />

      {isHost ? (
        <Card variant="soft" padding="md">
          <p className="text-sm font-bold text-slate-800 mb-1">GDを開始する</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">
            予定人数（{room.plannedParticipantCount}人・現在 {humanCount}人）に不足する分をAIメンバーが補完してGDを開始します。開始後は参加受付を締め切ります。
          </p>
          {startError && (
            <p className="text-xs text-red-600 leading-relaxed mb-3" role="alert">
              {startError}
            </p>
          )}
          <Button variant="primary" size="md" onClick={start} disabled={starting} className="w-full sm:w-auto">
            {starting ? '開始中…' : 'AIメンバーを補完して開始'}
          </Button>
        </Card>
      ) : (
        <Card variant="soft" padding="md">
          <p className="text-sm font-bold text-slate-800 mb-1">ホストの開始を待っています</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            ホストがGDを開始すると、この画面に反映されます。「更新」を押して最新状態を確認できます。
          </p>
        </Card>
      )}
    </>
  );
}

// ── active（GDセッション） ───────────────────────────────────────────

function ActiveView({
  initial,
  onStatusChanged,
}: {
  initial: CareerGdRoomDetailResponse;
  onStatusChanged: () => void;
}) {
  const roomId = initial.room.id;
  const [room, setRoom] = useState(initial.room);
  const [members, setMembers] = useState<CareerGdRoomMember[]>(initial.members);
  const [messages, setMessages] = useState<CareerGdRoomMessage[]>(initial.messages);
  const isHost = initial.isHost;
  const selfParticipantId = initial.currentUserMember?.participantId ?? '';

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [aiThinking, setAiThinking] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const latestSeq = messages.reduce((max, m) => (m.seq > max ? m.seq : max), 0);
  const latestSeqRef = useRef(latestSeq);
  useEffect(() => {
    latestSeqRef.current = latestSeq;
  }, [latestSeq]);

  // 受信した messages を seq でマージ（重複排除）。
  const mergeMessages = useCallback((incoming: CareerGdRoomMessage[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const bySeq = new Map<number, CareerGdRoomMessage>();
      for (const m of prev) bySeq.set(m.seq, m);
      for (const m of incoming) bySeq.set(m.seq, m);
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    });
  }, []);

  // ポーリング（room / members / 新規 messages）。status 変化を検知したら親へ通知。
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/career/gd/room/${encodeURIComponent(roomId)}?afterSeq=${latestSeqRef.current}`,
        );
        const data = (await res.json().catch(() => null)) as CareerGdRoomDetailResponse | null;
        if (cancelled || !res.ok || !data?.room) return;
        setRoom(data.room);
        setMembers(data.members);
        mergeMessages(data.messages);
        if (data.room.status !== 'active') {
          onStatusChanged();
        }
      } catch {
        // ポーリングの一時失敗は無視（次周期で回復）。
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [roomId, mergeMessages, onStatusChanged]);

  // 新着で最下部へスクロール。
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    setActionError(null);
    const clientMsgId = newClientMsgId();
    try {
      const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, clientMsgId }),
      });
      const data = (await res.json().catch(() => null)) as
        | { message?: CareerGdRoomMessage; error?: string; detail?: string }
        | null;
      if (!res.ok || !data?.message) {
        throw new Error(data?.detail ?? '発言の投稿に失敗しました。');
      }
      mergeMessages([data.message]);
      setInput('');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '発言の投稿に失敗しました。');
    } finally {
      setSending(false);
    }
  }, [input, sending, roomId, mergeMessages]);

  const aiTurn = useCallback(async () => {
    if (aiThinking) return;
    setAiThinking(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}/ai-turn`, { method: 'POST' });
      const data = (await res.json().catch(() => null)) as
        | { message?: CareerGdRoomMessage; error?: string; detail?: string }
        | null;
      if (!res.ok || !data?.message) {
        throw new Error(data?.detail ?? 'AI発言の生成に失敗しました。');
      }
      mergeMessages([data.message]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'AI発言の生成に失敗しました。');
    } finally {
      setAiThinking(false);
    }
  }, [aiThinking, roomId, mergeMessages]);

  const finish = useCallback(async () => {
    if (finishing) return;
    if (typeof window !== 'undefined' && !window.confirm('GDを終了しますか？終了すると発言できなくなります。')) return;
    setFinishing(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}/finish`, { method: 'POST' });
      const data = (await res.json().catch(() => null)) as { room?: unknown; error?: string; detail?: string } | null;
      if (!res.ok) {
        throw new Error(data?.detail ?? 'ルームの終了に失敗しました。');
      }
      onStatusChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'ルームの終了に失敗しました。');
    } finally {
      setFinishing(false);
    }
  }, [finishing, roomId, onStatusChanged]);

  const nameOf = useCallback(
    (participantId: string) => members.find((m) => m.participantId === participantId),
    [members],
  );

  return (
    <>
      <Card variant="soft" padding="md" className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-1">テーマ</p>
            <p className="text-sm font-bold text-slate-800 leading-snug">
              {room.theme?.title || '（テーマ準備中）'}
            </p>
            {room.theme?.description && (
              <p className="mt-1 text-xs text-slate-600 leading-relaxed">{room.theme.description}</p>
            )}
            {room.theme?.constraints && room.theme.constraints.length > 0 && (
              <ul className="mt-2 list-disc pl-4 text-xs text-slate-500 leading-relaxed">
                {room.theme.constraints.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
          </div>
          <RemainingTime startedAt={room.startedAt ?? null} timeLimitSec={room.timeLimitSec} />
        </div>
      </Card>

      <MembersCard members={members} plannedCount={room.plannedParticipantCount} className="mb-4" />

      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">ディスカッション</p>
        <div
          ref={timelineRef}
          className="max-h-[46vh] overflow-y-auto rounded-xl bg-white/60 border border-slate-100 p-3 flex flex-col gap-2.5"
        >
          {messages.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-6">
              まだ発言はありません。あなたの発言、または「AIに発言してもらう」で議論を始めましょう。
            </p>
          ) : (
            messages.map((m) => {
              const member = nameOf(m.participantId);
              const isSelf = m.participantId === selfParticipantId;
              return (
                <MessageRow
                  key={m.id || m.seq}
                  message={m}
                  displayName={member?.displayName ?? '参加者'}
                  isAi={member?.isAi ?? false}
                  isHost={member?.isHost ?? false}
                  isSelf={isSelf}
                />
              );
            })
          )}
          {aiThinking && <p className="text-xs text-emerald-600 text-center py-1">AIが考えています…</p>}
        </div>
      </Card>

      {actionError && (
        <p className="text-xs text-red-600 leading-relaxed mb-3" role="alert">
          {actionError}
        </p>
      )}

      <Card variant="soft" padding="md">
        <label htmlFor="gd-input" className="sr-only">
          発言を入力
        </label>
        <textarea
          id="gd-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          maxLength={600}
          placeholder="あなたの発言を入力（600文字まで）"
          className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"
        />
        <div className="mt-3 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
          <div className="flex gap-2">
            <Button variant="primary" size="md" onClick={send} disabled={sending || !input.trim()}>
              {sending ? '送信中…' : '発言する'}
            </Button>
            <Button variant="outline" size="md" onClick={aiTurn} disabled={aiThinking}>
              {aiThinking ? '生成中…' : 'AIに発言してもらう'}
            </Button>
          </div>
          {isHost && (
            <Button variant="ghost" size="md" onClick={finish} disabled={finishing} className="text-red-600">
              {finishing ? '終了処理中…' : 'GDを終了する'}
            </Button>
          )}
        </div>
        {!isHost && (
          <p className="mt-2 text-[11px] text-slate-400">GDの終了はホストが行います。</p>
        )}
      </Card>
    </>
  );
}

function RemainingTime({ startedAt, timeLimitSec }: { startedAt: string | null; timeLimitSec: number }) {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const started = startedAt ? new Date(startedAt).getTime() : null;
  const remainingSec = started != null ? Math.max(0, timeLimitSec - Math.floor((now - started) / 1000)) : timeLimitSec;
  const mm = Math.floor(remainingSec / 60);
  const ss = remainingSec % 60;
  const over = remainingSec === 0;
  return (
    <div className="shrink-0 text-right">
      <p className="text-[10px] text-slate-400 mb-0.5">残り時間</p>
      <p className={`text-lg font-bold tabular-nums ${over ? 'text-red-600' : 'text-slate-800'}`}>
        {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
      </p>
      {over && <p className="text-[10px] text-red-500">時間になりました</p>}
    </div>
  );
}

function MessageRow({
  message,
  displayName,
  isAi,
  isHost,
  isSelf,
}: {
  message: CareerGdRoomMessage;
  displayName: string;
  isAi: boolean;
  isHost: boolean;
  isSelf: boolean;
}) {
  if (message.kind === 'system') {
    return (
      <p className="text-[11px] text-slate-400 text-center py-1">【進行】{message.content}</p>
    );
  }
  return (
    <div className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'}`}>
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[11px] font-semibold text-slate-600">{displayName}</span>
        {isHost && <span className="rounded-full bg-indigo-50 px-1.5 text-[10px] font-semibold text-indigo-700">ホスト</span>}
        {isAi && <span className="rounded-full bg-emerald-50 px-1.5 text-[10px] font-semibold text-emerald-700">AI</span>}
      </div>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
          isSelf ? 'bg-blue-600 text-white' : isAi ? 'bg-emerald-50 text-slate-800' : 'bg-white text-slate-800 border border-slate-100'
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}

// ── finished（簡易結果） ─────────────────────────────────────────────

function FinishedView({
  detail,
  onRefresh,
}: {
  detail: CareerGdRoomDetailResponse;
  onRefresh: () => void;
}) {
  const roomId = detail.room.id;
  const room = detail.room;
  const members = detail.members;
  const [result, setResult] = useState<CareerGdRoomResultView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}/result`, { method: 'POST' });
      const data = (await res.json().catch(() => null)) as
        | { result?: CareerGdRoomResultView; error?: string; detail?: string }
        | null;
      if (!res.ok || !data?.result) {
        throw new Error(data?.detail ?? '結果の生成に失敗しました。');
      }
      setResult(data.result);

      // 学習履歴（localStorage canonical）へ書き戻す。roomId で重複排除。
      // Supabase career_gd_room_results が durable mirror、この log が /career/gd/view の閲覧用 canonical。
      const startedAt = room.startedAt ? new Date(room.startedAt).getTime() : NaN;
      const finishedAt = room.finishedAt ? new Date(room.finishedAt).getTime() : NaN;
      const durationSec =
        Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt
          ? Math.round((finishedAt - startedAt) / 1000)
          : room.timeLimitSec;
      const log: CareerGdRoomLog = {
        id: data.result.roomId,
        roomId: data.result.roomId,
        participantId: data.result.participantId,
        createdAt: data.result.createdAt || new Date().toISOString(),
        theme: room.theme ?? { title: '', description: '', format: room.format },
        format: room.format,
        participantCount: members.length,
        humanCount: members.filter((m) => !m.isAi).length,
        durationSec,
        evaluation: data.result.evaluation,
        ranking: data.result.ranking,
        matchingHints: data.result.matchingHints,
        consultationSummary: data.result.consultationSummary,
      };
      appendGdRoomLog(log);
    } catch (e) {
      setError(e instanceof Error ? e.message : '結果の生成に失敗しました。');
    } finally {
      setLoading(false);
    }
  }, [roomId, room, members]);

  return (
    <>
      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-sm font-bold text-slate-800 mb-1">GDは終了しました</p>
        <p className="text-xs text-slate-500 leading-relaxed mb-3">
          お疲れさまでした。あなたの発言内容をもとに、GD能力の評価とフィードバックを表示します。
        </p>
        {error && (
          <p className="text-xs text-red-600 leading-relaxed mb-3" role="alert">
            {error}
          </p>
        )}
        {!result && (
          <div className="flex gap-2">
            <Button variant="primary" size="md" onClick={generate} disabled={loading}>
              {loading ? '評価中…（10〜30秒）' : '評価を見る'}
            </Button>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
              更新
            </Button>
          </div>
        )}
      </Card>

      {result && (
        <GdEvaluationDetail
          evaluation={result.evaluation}
          ranking={result.ranking}
          matchingHints={result.matchingHints}
          selfParticipantId={result.participantId}
        />
      )}
      {result && (
        <div className="mb-4">
          <Link
            href="/career/gd/view"
            className="inline-flex items-center gap-1 text-sm font-semibold text-blue-700 hover:underline"
          >
            GD履歴（結果一覧）を見る →
          </Link>
        </div>
      )}
    </>
  );
}

// ── 共通 UI ─────────────────────────────────────────────────────────

function MembersCard({
  members,
  plannedCount,
  className,
}: {
  members: CareerGdRoomMember[];
  plannedCount: number;
  className?: string;
}) {
  const humanCount = members.filter((m) => !m.isAi && !m.leftAt).length;
  return (
    <Card variant="soft" padding="md" className={className ?? 'mb-5'}>
      <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
        参加者（{humanCount} / {plannedCount}）
      </p>
      <ul className="flex flex-col gap-2.5">
        {members.map((m) => (
          // E2E test hook (STEP-GD-20-H): non-functional attrs for Playwright roster assertions.
          <li key={m.id} className="text-sm" data-testid="gd-member-row" data-ai={String(m.isAi)}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-800">{m.displayName}</span>
              {m.isHost && (
                <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">ホスト</span>
              )}
              {m.isAi && (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">AI</span>
              )}
              {m.persona?.personaRole && <span className="text-[11px] text-slate-400">{m.persona.personaRole}</span>}
              <span className="text-[11px] text-slate-400">{GD_ROLE_LABELS[m.role]}</span>
            </div>
            {m.isAi && m.persona?.personaSummary && (
              <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">{m.persona.personaSummary}</p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Shell({ children, status }: { children: React.ReactNode; status: GdRoomStatus }) {
  const description =
    status === 'active'
      ? 'ディスカッションを進めましょう。'
      : status === 'finished'
        ? '結果を振り返りましょう。'
        : '参加者の入室を待っています。';
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex items-center justify-between gap-3 mb-4">
        <PageHeader title="マルチGD" description={description} />
        <span className="shrink-0 inline-flex items-center rounded-full bg-blue-100 px-3 py-1 text-xs font-bold text-blue-700">
          {STATUS_LABELS[status]}
        </span>
      </div>
      {children}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/career/gd"
      className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
    >
      ← GDトップに戻る
    </Link>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500 mb-0.5">{label}</p>
      <p className="text-sm font-semibold text-slate-800">{value}</p>
    </div>
  );
}

'use client';

// PASSAI 就活版 — GD Phase2 マルチGD ルーム画面（STEP-GD-14）。
// room.status に応じて表示を切り替える:
//   waiting  … ロビー（参加待機・host のみ開始）
//   active   … GDセッション（テーマ・残り時間・参加者・発言タイムライン・発言入力・AI発言・host終了）
//   finished … 簡易結果への導線（発言量ベースの暫定フィードバック＋参加ランキング）
//
// 共有状態は Supabase が正本。DB 操作はすべて API route 経由（クライアントは room 系テーブルを直接叩かない）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { useAuthStatus, useIsMember, useCurrentUserId } from '@/app/components/AuthProvider';
import { recordCareerEvent } from '@/lib/careerEvents/record';
import { useCareerGdRealtime } from '@/hooks/useCareerGdRealtime';
import { useCareerGdMessages, type GdPendingMessage } from '@/hooks/useCareerGdMessages';
import { useCareerGdTimer } from '@/hooks/useCareerGdTimer';
import type {
  GdPresenceMap,
  GdRealtimeConnectionState,
  GdRealtimeSelfIdentity,
} from '@/lib/careerGd/realtimeRoom';
import { GD_FORMAT_LABELS, GD_ROLE_LABELS } from '../../gdRoles';
import { GdEvaluationDetail } from '../../GdEvaluationDetail';
import { GdRoomOverallDetail } from '../../GdRoomOverallDetail';
import { appendGdRoomLog, loadGdRoomLogs } from '../../gdRoomLogStorage';
import type {
  CareerGdRoomDetailResponse,
  CareerGdRoomMember,
  CareerGdRoomMessage,
  CareerGdRoomResultView,
  CareerGdRoomLog,
  CareerGdRoomOverallEvaluation,
  GdRoomStatus,
} from '@/types/careerGd';

const STATUS_LABELS: Record<GdRoomStatus, string> = {
  waiting: '参加受付中',
  active: 'GD進行中',
  finished: '終了',
  cancelled: '中止',
};

const POLL_INTERVAL_MS = 3000;

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

  // ── STEP-GD-24: Realtime 基盤（Presence / room・participant 変更購読）──────────
  // 実データの正本は従来どおり API ポーリング。ここでは presence（オンライン表示）と
  // 「変更が起きた」シグナル（onSyncSignal → refresh）を追加するだけ（非破壊）。
  const selfMember = detail?.currentUserMember ?? null;
  const roomStatus = detail?.room.status ?? null;
  const selfParticipantId = selfMember?.participantId ?? '';
  const selfUserId = selfMember?.userId ?? null;
  const selfDisplayName = selfMember?.displayName ?? '';
  const self = useMemo<GdRealtimeSelfIdentity | null>(
    () =>
      selfParticipantId
        ? { participantId: selfParticipantId, userId: selfUserId, displayName: selfDisplayName }
        : null,
    [selfParticipantId, selfUserId, selfDisplayName],
  );
  const { presenceMap, connectionState } = useCareerGdRealtime({
    roomId,
    self,
    enabled: isMember && (roomStatus === 'waiting' || roomStatus === 'active'),
    onSyncSignal: refresh,
  });

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
            href={`/login?next=${encodeURIComponent(`/career/gd/room/${roomId}`)}`}
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
        <ActiveView
          initial={detail}
          onStatusChanged={refresh}
          presenceMap={presenceMap}
          connectionState={connectionState}
        />
      ) : status === 'waiting' ? (
        <WaitingView
          detail={detail}
          loading={loading}
          onRefresh={refresh}
          onStarted={setDetail}
          presenceMap={presenceMap}
          connectionState={connectionState}
        />
      ) : status === 'finished' ? (
        <FinishedView detail={detail} onRefresh={refresh} />
      ) : (
        // cancelled（部屋の終了 / リーダー退出による論理削除）。突然壊れた画面に見せない。
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm font-bold text-slate-800 mb-1">このGDセッションは終了しました</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            {detail.isHost
              ? 'この部屋は終了済みです。新しくGDを行うには、部屋を作り直すか別の部屋に参加してください。'
              : '部屋のリーダーが退出したため、このGDセッションは終了しました。新しくGDを行うには、別の部屋に参加してください。'}
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              href="/career/gd"
              className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              GDトップへ戻る →
            </Link>
          </div>
        </Card>
      )}
      <div className="mt-5 flex flex-col sm:flex-row gap-3">
        <BackLink />
      </div>
    </Shell>
  );
}

// ── waiting（ロビー） ────────────────────────────────────────────────
//
// host start 促し UI（STEP-GD-20-J）: host には目立つ開始 CTA と人数状況、非 host には
// 「ホストの開始待ち」＋AI 補完で開始可能な旨を表示し、room 放置を防ぐ。
// TODO(将来): host 自動開始 / 非host→host 催促 / room timeout・abandon cleanup / メール・Push 通知 /
//   Realtime は本 STEP では非対象（docs/gd 参照）。

function WaitingView({
  detail,
  loading,
  onRefresh,
  onStarted,
  presenceMap,
  connectionState,
}: {
  detail: CareerGdRoomDetailResponse;
  loading: boolean;
  onRefresh: () => void;
  onStarted: (d: CareerGdRoomDetailResponse) => void;
  presenceMap: GdPresenceMap;
  connectionState: GdRealtimeConnectionState;
}) {
  const { room, members, isHost } = detail;
  const humanCount = members.filter((m) => !m.isAi && !m.leftAt).length;
  const planned = room.plannedParticipantCount;
  // AI 補完予定 = 不足分（0 未満にならない）。4/6/8 いずれでも成立。
  const aiFillCount = Math.max(0, planned - humanCount);
  const isFull = humanCount >= planned;
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // ── STEP-GD-26: waiting の fallback ポーリング（Realtime 無効環境の担保）──
  // 非 host が host の手動開始を検知して active へ遷移でき、待機中の参加者/オンライン状態も更新する。
  // onStarted は root の setDetail。status が waiting でなくなれば root が active/finished へ再ルーティングする。
  // Realtime（GD-24 の onSyncSignal→refresh）が有効なら即時、無効でもこの poll で破綻しない。
  const roomId = room.id;
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}`);
        const data = (await res.json().catch(() => null)) as CareerGdRoomDetailResponse | null;
        if (cancelled || !res.ok || !data?.room) return;
        onStarted(data);
      } catch {
        // ポーリングの一時失敗は無視（次周期 / 手動更新で回復）。
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [roomId, onStarted]);

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

  const isRandom = room.roomType === 'random_match';
  return (
    <>
      <div className="flex items-center justify-end mb-4">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? '更新中…' : '更新'}
        </Button>
      </div>

      {/* room 由来バナー（ランダムマッチ由来であることを明示・公開ロビー/合言葉との混同防止）。 */}
      {isRandom && (
        <div
          className="mb-4 rounded-xl bg-indigo-50 ring-1 ring-indigo-100 px-4 py-3"
          data-testid="gd-random-origin"
        >
          <p className="text-sm font-bold text-indigo-800">ランダムマッチで成立したルームです</p>
          <p className="mt-1 text-xs text-indigo-700 leading-relaxed">
            同じ人数（{planned}人）を希望した就活生と自動でマッチングされました。合言葉や公開ロビーからの参加ではありません。
            不足している人数はAIメンバーが補完します。
          </p>
        </div>
      )}

      <Card variant="soft" padding="md" className="mb-5">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">ルーム情報</p>
        <div className="grid grid-cols-3 gap-y-2 gap-x-4 text-sm">
          <Info label="形式" value={GD_FORMAT_LABELS[room.format]} />
          <Info label="予定人数" value={`${room.plannedParticipantCount}人`} />
          <Info label="制限時間" value={`${Math.round(room.timeLimitSec / 60)}分`} />
        </div>
        {/* 確定した GD テーマ（作成時に保存済み・待機/進行/結果で同一テーマを参照）。 */}
        {room.theme?.title && (
          <div className="mt-4 rounded-xl bg-white/70 ring-1 ring-slate-200 px-3 py-3" data-testid="gd-waiting-theme">
            <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-1">GDテーマ</p>
            <p className="text-sm font-bold text-slate-800 leading-snug">{room.theme.title}</p>
            {room.theme.description && (
              <p className="mt-1 text-xs text-slate-600 leading-relaxed">{room.theme.description}</p>
            )}
            {room.theme.constraints && room.theme.constraints.length > 0 && (
              <ul className="mt-2 list-disc pl-4 text-xs text-slate-500 leading-relaxed">
                {room.theme.constraints.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {/* 6桁コード共有の案内は合言葉(invite) room のみ（ランダムマッチ・公開ロビーはコード無し）。 */}
        {isHost && room.roomType === 'invite' && (
          <p className="mt-4 text-xs text-amber-700 leading-relaxed">
            あなたはホストです。参加コードはセキュリティのため再表示できません。作成時に表示された6桁コードを参加者に共有してください。
          </p>
        )}
      </Card>

      {/* 人数状態（human / planned と AI 補完予定）。host/非host 共通。 */}
      <div
        className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-white/70 ring-1 ring-slate-200 px-4 py-3"
        data-testid="gd-waiting-status"
        data-human={humanCount}
        data-planned={planned}
        data-ai-fill={aiFillCount}
      >
        <span className="text-sm font-bold text-slate-800">
          参加状況: {humanCount} / {planned} 人
        </span>
        <span className="text-xs font-semibold text-emerald-700">
          {aiFillCount > 0 ? `AIメンバー補完予定: ${aiFillCount} 人` : '全員そろっています'}
        </span>
      </div>

      <MembersCard
        members={members}
        plannedCount={room.plannedParticipantCount}
        presenceMap={presenceMap}
        connectionState={connectionState}
      />

      {isHost ? (
        <Card variant="soft" padding="md">
          {isFull ? (
            <>
              <p className="text-sm font-bold text-slate-800 mb-1">参加者が全員そろいました</p>
              <p className="text-xs text-slate-500 leading-relaxed mb-3">
                準備ができたらGDを開始してください。（現在 {humanCount} / {planned} 人）
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-bold text-slate-800 mb-1">あなたがホストです</p>
              <p className="text-xs text-slate-500 leading-relaxed mb-3">
                参加者がそろったら、またはAIメンバーで始めたい場合は「開始」を押してください。現在 {humanCount} / {planned} 人が参加中です。不足分の {aiFillCount} 人はAIメンバーが自動で参加します。
              </p>
            </>
          )}
          {startError && (
            <p className="text-xs text-red-600 leading-relaxed mb-3" role="alert">
              {startError}
            </p>
          )}
          <Button variant="primary" size="md" onClick={start} disabled={starting} className="w-full sm:w-auto">
            {starting ? '開始中…' : isFull ? 'GDを開始する' : 'AIメンバーを補完して開始'}
          </Button>
        </Card>
      ) : (
        <Card variant="soft" padding="md">
          <p className="text-sm font-bold text-slate-800 mb-1">ホストの開始を待っています</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            このGDはホストが開始すると始まります。現在 {humanCount} / {planned} 人が参加中です。
            {aiFillCount > 0
              ? '参加者が足りない場合は、AIメンバーが自動で参加します。'
              : '参加者はそろっています。'}
            この画面は自動更新されます（「更新」でも確認できます）。
          </p>
        </Card>
      )}

      {/* 修正2/3: host=部屋を終了（cancelled 論理削除）/ 一般参加者=退出（部屋は継続）。 */}
      <ExitControls roomId={room.id} isHost={isHost} allowHostClose onChanged={onRefresh} />
    </>
  );
}

// ── active（GDセッション） ───────────────────────────────────────────

function ActiveView({
  initial,
  onStatusChanged,
  presenceMap,
  connectionState,
}: {
  initial: CareerGdRoomDetailResponse;
  onStatusChanged: () => void;
  presenceMap: GdPresenceMap;
  connectionState: GdRealtimeConnectionState;
}) {
  const roomId = initial.room.id;
  const [room, setRoom] = useState(initial.room);
  const [members, setMembers] = useState<CareerGdRoomMember[]>(initial.members);
  const isHost = initial.isHost;
  const selfMember = initial.currentUserMember;
  const selfParticipantId = selfMember?.participantId ?? '';
  const selfDisplayName = selfMember?.displayName ?? 'あなた';

  const [input, setInput] = useState('');
  const [aiThinking, setAiThinking] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // ── STEP-GD-25: 発言同期（optimistic UI + Realtime + fallback poll）──
  const self = useMemo<GdRealtimeSelfIdentity | null>(
    () =>
      selfParticipantId
        ? {
            participantId: selfParticipantId,
            userId: selfMember?.userId ?? null,
            displayName: selfMember?.displayName ?? '',
          }
        : null,
    [selfParticipantId, selfMember?.userId, selfMember?.displayName],
  );
  const {
    messages,
    pendingMessages,
    sendMessage,
    resendMessage,
    error: messageError,
    refreshMessages,
    latestSeq,
  } = useCareerGdMessages({
    roomId,
    self,
    enabled: room.status === 'active',
    initialMessages: initial.messages,
  });

  // ── STEP-GD-26: タイマー同期（started_at + time_limit_sec が正本・表示のみ毎秒更新）──
  const {
    remainingSeconds,
    isExpired: timerExpired,
    shouldAutoFinish,
  } = useCareerGdTimer({
    startedAt: room.startedAt ?? null,
    timeLimitSec: room.timeLimitSec,
    enabled: room.status === 'active',
  });

  const timelineRef = useRef<HTMLDivElement | null>(null);
  // detail ポーリングの afterSeq に使い、messages 二重取得を避ける（messages は hook が正本）。
  const latestSeqRef = useRef(latestSeq);
  useEffect(() => {
    latestSeqRef.current = latestSeq;
  }, [latestSeq]);

  // ポーリング（room / members / status のみ。messages は useCareerGdMessages が担当）。
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
  }, [roomId, onStatusChanged]);

  // 新着（確定 or pending）で最下部へスクロール。
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pendingMessages]);

  const handleSend = useCallback(() => {
    if (timerExpired) return; // ⑪ 時間切れ後は送信不可（最終判定は server も active を検証）
    const content = input.trim();
    if (!content) return; // ⑨ trim 後に空なら送信不可
    sendMessage(content); // optimistic（pending 表示は hook 側）。入力欄は即クリア＝多重送信防止。
    setInput('');
  }, [timerExpired, input, sendMessage]);

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // ⑨ Enter 送信 / Shift+Enter 改行（IME 変換確定中の Enter では送信しない）。
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

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
      // 生成された AI 発言は messages hook 側で取り込む（realtime / poll でも入るが即時反映）。
      refreshMessages();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'AI発言の生成に失敗しました。');
    } finally {
      setAiThinking(false);
    }
  }, [aiThinking, roomId, refreshMessages]);

  // 終了 API 呼び出し本体（手動終了・時間切れ自動終了で共用）。server は host & active を検証し、
  // 二重終了は冪等（already finished は 200）。複数クライアントが同時に叩いても破綻しない。
  const doFinish = useCallback(async () => {
    const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}/finish`, { method: 'POST' });
    const data = (await res.json().catch(() => null)) as { room?: unknown; error?: string; detail?: string } | null;
    if (!res.ok) {
      throw new Error(data?.detail ?? 'ルームの終了に失敗しました。');
    }
    onStatusChanged();
  }, [roomId, onStatusChanged]);

  // ⑨ 手動終了（host のみ・誤クリック確認・終了中ローディング）。
  const finish = useCallback(async () => {
    if (finishing) return;
    if (typeof window !== 'undefined' && !window.confirm('GDを終了しますか？終了すると発言できなくなります。')) return;
    setFinishing(true);
    setActionError(null);
    try {
      await doFinish();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'ルームの終了に失敗しました。');
    } finally {
      setFinishing(false);
    }
  }, [finishing, doFinish]);

  // ⑧ 時間切れ終了。host クライアントが 1 回だけ finish を叩く（server 冪等・非 host は 403 になるため
  //    呼ばず、status 変化を poll / realtime で受けて finished へ遷移する）。
  const autoFinishedRef = useRef(false);
  useEffect(() => {
    if (!shouldAutoFinish || !isHost) return;
    if (autoFinishedRef.current) return;
    if (room.status !== 'active') return;
    autoFinishedRef.current = true;
    void doFinish().catch(() => {
      // 失敗しても hot-loop させない（host は手動終了ボタンで再試行できる）。
    });
  }, [shouldAutoFinish, isHost, room.status, doFinish]);

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
          <RemainingTime remainingSeconds={remainingSeconds} isExpired={timerExpired} />
        </div>
      </Card>

      <MembersCard
        members={members}
        plannedCount={room.plannedParticipantCount}
        className="mb-4"
        presenceMap={presenceMap}
        connectionState={connectionState}
      />

      <Card variant="soft" padding="md" className="mb-4">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">ディスカッション</p>
        <div
          ref={timelineRef}
          className="max-h-[46vh] overflow-y-auto rounded-xl bg-white/60 border border-slate-100 p-3 flex flex-col gap-2.5"
        >
          {messages.length === 0 && pendingMessages.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-6">
              まだ発言はありません。あなたの発言、または「AIに発言してもらう」で議論を始めましょう。
            </p>
          ) : (
            <>
              {messages.map((m) => {
                const member = nameOf(m.participantId);
                const isSelf = m.participantId === selfParticipantId;
                return (
                  <MessageRow
                    key={m.id || `seq-${m.seq}`}
                    message={m}
                    displayName={member?.displayName ?? '参加者'}
                    isAi={member?.isAi ?? false}
                    isHost={member?.isHost ?? false}
                    isSelf={isSelf}
                  />
                );
              })}
              {/* optimistic（sending / failed）は確定メッセージの末尾に表示する。 */}
              {pendingMessages.map((p) => (
                <PendingMessageRow
                  key={p.clientMsgId}
                  pending={p}
                  displayName={selfDisplayName}
                  onResend={() => resendMessage(p.clientMsgId)}
                />
              ))}
            </>
          )}
          {aiThinking && <p className="text-xs text-emerald-600 text-center py-1">AIが考えています…</p>}
        </div>
      </Card>

      {(actionError || messageError) && (
        <p className="text-xs text-red-600 leading-relaxed mb-3" role="alert">
          {actionError ?? messageError}
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
          onKeyDown={onInputKeyDown}
          rows={2}
          maxLength={600}
          disabled={timerExpired}
          placeholder="あなたの発言を入力（Enterで送信 / Shift+Enterで改行・600文字まで）"
          className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
        />
        <div className="mt-3 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
          <div className="flex gap-2">
            <Button variant="primary" size="md" onClick={handleSend} disabled={timerExpired || !input.trim()}>
              発言する
            </Button>
            <Button variant="outline" size="md" onClick={aiTurn} disabled={aiThinking || timerExpired}>
              {aiThinking ? '生成中…' : 'AIに発言してもらう'}
            </Button>
          </div>
          {isHost && (
            <Button variant="ghost" size="md" onClick={finish} disabled={finishing} className="text-red-600">
              {finishing ? '終了処理中…' : 'GDを終了する'}
            </Button>
          )}
        </div>
        {timerExpired ? (
          <p className="mt-2 text-[11px] text-red-500">
            制限時間になりました。{isHost ? 'まもなく自動で終了します。' : 'ホストの終了をお待ちください。'}
          </p>
        ) : (
          !isHost && <p className="mt-2 text-[11px] text-slate-400">GDの終了はホストが行います。</p>
        )}
      </Card>

      {/* 修正3: 一般参加者の退出（部屋は継続）。host は上の「GDを終了する」で終了する。 */}
      <ExitControls roomId={roomId} isHost={isHost} allowHostClose={false} onChanged={onStatusChanged} />
    </>
  );
}

// 修正2/3: 部屋の終了（host・cancelled 論理削除）/ 退出（一般参加者・部屋は継続）の操作。
// 表示制御に加え、サーバ側（close / leave route）でも host 権限を検証する（多層防御）。
function ExitControls({
  roomId,
  isHost,
  allowHostClose,
  onChanged,
}: {
  roomId: string;
  isHost: boolean;
  allowHostClose: boolean;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'close' | 'leave'>(null);
  const [error, setError] = useState<string | null>(null);

  const closeRoom = useCallback(async () => {
    if (busy) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'この部屋を終了すると、参加者全員が退出し、現在のセッションは利用できなくなります。本当に終了しますか？',
      )
    ) {
      return;
    }
    setBusy('close');
    setError(null);
    try {
      const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}/close`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'ルームの終了に失敗しました。');
      }
      onChanged(); // status=cancelled を root が受けて cancelled 画面へ再ルーティング。
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ルームの終了に失敗しました。');
    } finally {
      setBusy(null);
    }
  }, [busy, roomId, onChanged]);

  const leaveRoom = useCallback(async () => {
    if (busy) return;
    const msg = isHost
      ? 'あなたはホストです。退出すると部屋が終了し、参加者全員が退出します。よろしいですか？'
      : 'この部屋から退出しますか？';
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    setBusy('leave');
    setError(null);
    try {
      const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}/leave`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'ルームの退出に失敗しました。');
      }
      router.push('/career/gd');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ルームの退出に失敗しました。');
    } finally {
      setBusy(null);
    }
  }, [busy, roomId, isHost, router]);

  return (
    <div className="mt-5">
      {error && (
        <p className="mb-2 text-xs text-red-600 leading-relaxed" role="alert">
          {error}
        </p>
      )}
      {isHost ? (
        allowHostClose ? (
          <div className="rounded-xl ring-1 ring-red-100 bg-red-50/40 px-4 py-3">
            <p className="text-xs text-slate-500 leading-relaxed mb-2">
              この部屋を終了すると参加者全員が退出し、セッションは利用できなくなります。
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={closeRoom}
              disabled={!!busy}
              className="text-red-600"
              data-testid="gd-close-room"
            >
              {busy === 'close' ? '終了処理中…' : '部屋を終了する'}
            </Button>
          </div>
        ) : null
      ) : (
        <button
          type="button"
          onClick={leaveRoom}
          disabled={!!busy}
          className="text-sm text-slate-500 hover:text-slate-800 underline disabled:opacity-50"
          data-testid="gd-leave-room"
        >
          {busy === 'leave' ? '退出中…' : '退出する'}
        </button>
      )}
    </div>
  );
}

// 残り時間の表示（presentational）。計算・1秒更新は useCareerGdTimer が担当する（STEP-GD-26）。
function RemainingTime({ remainingSeconds, isExpired }: { remainingSeconds: number; isExpired: boolean }) {
  const mm = Math.floor(remainingSeconds / 60);
  const ss = remainingSeconds % 60;
  return (
    <div className="shrink-0 text-right" data-testid="gd-remaining-time" data-expired={String(isExpired)}>
      <p className="text-[10px] text-slate-400 mb-0.5">残り時間</p>
      <p className={`text-lg font-bold tabular-nums ${isExpired ? 'text-red-600' : 'text-slate-800'}`}>
        {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
      </p>
      {isExpired && <p className="text-[10px] text-red-500">時間になりました</p>}
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

// STEP-GD-25: optimistic な自分の発言（sending / failed）。確定後は MessageRow へ置き換わる。
function PendingMessageRow({
  pending,
  displayName,
  onResend,
}: {
  pending: GdPendingMessage;
  displayName: string;
  onResend: () => void;
}) {
  const failed = pending.status === 'failed';
  return (
    <div
      className="flex flex-col items-end"
      data-testid="gd-pending-message"
      data-status={pending.status}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[11px] font-semibold text-slate-600">{displayName}</span>
      </div>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
          failed ? 'bg-red-50 text-slate-800 border border-red-200' : 'bg-blue-600/70 text-white'
        }`}
      >
        {pending.content}
      </div>
      {failed ? (
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-[10px] text-red-500">送信に失敗しました</span>
          <button
            type="button"
            onClick={onResend}
            className="text-[10px] font-semibold text-blue-600 hover:underline"
          >
            再送する
          </button>
        </div>
      ) : (
        <span className="mt-0.5 text-[10px] text-slate-400">送信中…</span>
      )}
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
  const [overallEval, setOverallEval] = useState<CareerGdRoomOverallEvaluation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Event Log 用（member のみ）。useCallback の deps を変えないよう ref で最新 userId を参照。
  const eventUserId = useCurrentUserId();
  const eventUserIdRef = useRef(eventUserId);
  useEffect(() => {
    eventUserIdRef.current = eventUserId;
  }, [eventUserId]);

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

      // STEP-GD-27: 議論全体評価は「新規生成時のみ」API に含まれる（冪等再取得では null）。
      // その場合は localStorage canonical（前回生成分）から復元して表示・保存を維持する。
      const existingLog = loadGdRoomLogs().find((l) => l.roomId === roomId);
      const overall = data.result.overallEvaluation ?? existingLog?.overallEvaluation ?? null;
      setOverallEval(overall);

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
        ...(overall ? { overallEvaluation: overall } : {}),
        source: 'realtime_room',
      };
      appendGdRoomLog(log);
      // Event Log（本文なし・fire-and-forget / member のみ）。GD topic/発言/評価/改善本文・
      // 参加者名・join code・ranking コメントは渡さない。room 自身の evaluation.rank は S/A/B/C/D の band。
      // clientEventId=roomId は unique index が (user_id, client_event_id) で user 別に閉じるため
      // 参加者間で衝突しない（同一 user の再取得のみ冪等吸収）。
      void recordCareerEvent(eventUserIdRef.current, {
        feature: 'gd',
        eventType: 'feature_completed',
        completionStatus: 'completed',
        clientEventId: log.roomId,
        scoreBand: log.evaluation.scored ? log.evaluation.rank : null,
        metadata: {
          participationMode: 'room',
          format: log.format,
          participantCount: log.participantCount,
          durationSec: log.durationSec,
        },
      });
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

      {overallEval && <GdRoomOverallDetail overall={overallEval} />}
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
  presenceMap,
  connectionState,
}: {
  members: CareerGdRoomMember[];
  plannedCount: number;
  className?: string;
  presenceMap?: GdPresenceMap;
  connectionState?: GdRealtimeConnectionState;
}) {
  const humanCount = members.filter((m) => !m.isAi && !m.leftAt).length;
  return (
    <Card variant="soft" padding="md" className={className ?? 'mb-5'}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest">
          参加者（{humanCount} / {plannedCount}）
        </p>
        {connectionState && <ConnectionBadge state={connectionState} />}
      </div>
      <ul className="flex flex-col gap-2.5">
        {members.map((m) => {
          // 人間参加者のみ presence を表示（AI は常時参加＝presence 対象外）。
          const online = !m.isAi && !!presenceMap && !!presenceMap[m.participantId];
          return (
            // E2E test hook (STEP-GD-20-H): non-functional attrs for Playwright roster assertions.
            <li key={m.id} className="text-sm" data-testid="gd-member-row" data-ai={String(m.isAi)}>
            <div className="flex flex-wrap items-center gap-2">
              {presenceMap && !m.isAi && <PresenceDot online={online} />}
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
          );
        })}
      </ul>
    </Card>
  );
}

// ── STEP-GD-24: Realtime presence / connection の最小 UI ────────────────

// ● オンライン / ○ オフライン（人間参加者のみ）。既存デザインに馴染む控えめな dot。
function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      data-testid="gd-presence-dot"
      data-online={String(online)}
      aria-label={online ? 'オンライン' : 'オフライン'}
      title={online ? 'オンライン' : 'オフライン'}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        online ? 'bg-emerald-500' : 'bg-slate-300'
      }`}
    />
  );
}

// channel 接続状態の控えめな表示（connected のみ緑・その他は淡色）。
function ConnectionBadge({ state }: { state: GdRealtimeConnectionState }) {
  if (state === 'idle') return null;
  const label =
    state === 'connected' ? 'リアルタイム接続中' : state === 'connecting' ? '接続中…' : 'オフライン（自動再接続）';
  const dotClass =
    state === 'connected' ? 'bg-emerald-500' : state === 'connecting' ? 'bg-amber-400' : 'bg-slate-300';
  return (
    <span
      data-testid="gd-connection-badge"
      data-state={state}
      className="inline-flex items-center gap-1 text-[11px] text-slate-500"
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
      {label}
    </span>
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

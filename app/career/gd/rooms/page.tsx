'use client';

// PASSAI 就活版 — GD部屋に入る（公開GD部屋 募集一覧）画面（STEP-GD-30）。
//
// 「モンストのマルチ募集一覧」に近い体験を目指す：現在募集中の公開GD部屋を一覧表示し、
// 参加ボタンから即入室する。ランダムマッチという文言は前面に出さない。
//
// 既存 API を流用（新規 API・DB 追加なし）：
//   - 一覧: GET  /api/career/gd/lobby/rooms（waiting × public_lobby × public のみ）
//   - 参加: POST /api/career/gd/lobby/join（RPC で満員/二重参加を原子制御）
// 参加・自室確認後は既存 /career/gd/room/[roomId]（ロビー）へ遷移する（room 画面は不変）。
//
// 秘密（host_user_id / user_id / email / join_code_hash 等）は表示しない。

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { GD_FORMAT_LABELS } from '../gdRoles';
import type {
  LobbyRoomSummary,
  LobbyRoomsResponse,
  LobbyJoinResponse,
} from '@/lib/careerGd/publicLobbyTypes';

const POLL_INTERVAL_MS = 10_000;

const DB_NOT_APPLIED_MESSAGE =
  '公開GD部屋のDB設定がまだ適用されていません。管理者に確認してください。';

// API の { error, detail } を、内部情報を出さない安全なメッセージへ写像する。
function friendlyError(
  status: number,
  data: { error?: string; detail?: string; message?: string } | null,
  fallback: string,
): string {
  if (data?.error === 'DB_NOT_APPLIED') return DB_NOT_APPLIED_MESSAGE;
  if (status === 429 || data?.error === 'RATE_LIMITED') {
    return (
      data?.detail ??
      data?.message ??
      '短時間に操作が集中しています。少し待ってからもう一度お試しください。'
    );
  }
  if (status === 401 || status === 403) {
    return 'この操作にはログイン（メール登録済み）が必要です。';
  }
  return data?.detail ?? fallback;
}

function formatMinutes(sec: number): string {
  return `${Math.round(sec / 60)}分`;
}

function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function CareerGdRoomsListPage() {
  const router = useRouter();

  const [rooms, setRooms] = useState<LobbyRoomSummary[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  // 表示名は localStorage の基本情報から補完（join 時に渡す・SSR 安全）。
  const displayNameRef = useRef<string>('');
  useEffect(() => {
    const t = setTimeout(() => {
      displayNameRef.current = loadBasicInfo()?.name?.trim() ?? '';
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const fetchRooms = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/career/gd/lobby/rooms');
      const data = (await res.json().catch(() => null)) as
        | (LobbyRoomsResponse & { error?: string; detail?: string })
        | null;
      if (!res.ok) {
        setRoomsError(friendlyError(res.status, data, '公開GD部屋の取得に失敗しました。'));
        return;
      }
      setRoomsError(null);
      setRooms(Array.isArray(data?.rooms) ? data.rooms : []);
    } catch {
      setRoomsError('公開GD部屋の取得に失敗しました。通信環境をご確認ください。');
    } finally {
      setRoomsLoaded(true);
      setRefreshing(false);
    }
  }, []);

  // 初回取得 + 10 秒ごとの自動更新。離脱時に timer を解除。
  useEffect(() => {
    const kick = setTimeout(() => {
      void fetchRooms();
    }, 0);
    const id = setInterval(() => {
      void fetchRooms();
    }, POLL_INTERVAL_MS);
    return () => {
      clearTimeout(kick);
      clearInterval(id);
    };
  }, [fetchRooms]);

  async function handleJoin(roomId: string) {
    if (joiningRoomId) return;
    setJoiningRoomId(roomId);
    setJoinError(null);
    try {
      const res = await fetch('/api/career/gd/lobby/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId,
          displayName: displayNameRef.current || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | (LobbyJoinResponse & { error?: string; detail?: string })
        | null;
      if (!res.ok || !data?.ok || !data.redirectTo) {
        setJoinError(friendlyError(res.status, data, '参加に失敗しました。'));
        // 満員・開始済み等は最新状態を取り直す。
        void fetchRooms();
        return;
      }
      router.push(data.redirectTo);
    } catch {
      setJoinError('参加に失敗しました。通信環境をご確認ください。');
    } finally {
      setJoiningRoomId(null);
    }
  }

  const isEmpty = roomsLoaded && !roomsError && rooms.length === 0;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="GD部屋に入る"
        description="現在募集中の公開GD部屋の一覧です。参加したい部屋を選んで入室してください（ログインが必要）。"
      />

      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-400">10秒ごとに自動更新されます。</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void fetchRooms()}
          disabled={refreshing}
        >
          {refreshing ? '更新中…' : '再検索'}
        </Button>
      </div>

      {joinError && (
        <p className="mb-3 text-xs font-semibold text-rose-600" role="alert">
          {joinError}
        </p>
      )}

      {roomsError ? (
        <Card variant="soft" padding="md">
          <p className="text-sm font-semibold text-slate-700">{roomsError}</p>
        </Card>
      ) : !roomsLoaded ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      ) : isEmpty ? (
        <Card variant="soft" padding="md">
          <p className="text-sm font-bold text-slate-800 mb-1">現在募集中の公開GD部屋はありません</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">
            自分で公開GD部屋を作成して募集するか、AIメンバーとのソロプレイで練習できます。
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <Link
              href="/career/gd/rooms/create"
              className="inline-flex items-center justify-center rounded-xl bg-teal-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-teal-700"
            >
              GD部屋を作る →
            </Link>
            <Link
              href="/career/gd/run"
              className="inline-flex items-center justify-center rounded-xl bg-white px-5 py-2.5 text-sm font-bold text-blue-700 ring-1 ring-blue-200 shadow-sm transition-colors hover:bg-blue-50"
            >
              ソロプレイで練習する →
            </Link>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {rooms.map((room) => (
            <RoomCard
              key={room.roomId}
              room={room}
              joining={joiningRoomId === room.roomId}
              disabled={joiningRoomId !== null}
              onJoin={() => handleJoin(room.roomId)}
            />
          ))}
        </div>
      )}

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <Link
          href="/career/gd/rooms/create"
          className="inline-flex items-center justify-center gap-1 text-sm font-bold text-teal-700 border border-teal-200 hover:bg-teal-50 rounded-lg px-4 py-2 transition-colors"
        >
          + GD部屋を作る
        </Link>
        <Link
          href="/career/gd"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← GD練習トップに戻る
        </Link>
      </div>
    </div>
  );
}

function RoomCard({
  room,
  joining,
  disabled,
  onJoin,
}: {
  room: LobbyRoomSummary;
  joining: boolean;
  disabled: boolean;
  onJoin: () => void;
}) {
  const roomHref = `/career/gd/room/${room.roomId}`;
  const createdAt = formatCreatedAt(room.createdAt);

  return (
    <Card padding="md">
      <div
        className="flex items-start justify-between gap-3"
        // E2E test hooks（STEP-GD-20-H 踏襲）: Playwright が部屋カードの状態を検証するための
        // 非機能属性。挙動には影響しない。
        data-room-id={room.roomId}
        data-count={room.currentHumanCount}
        data-full={String(room.isFull)}
        data-mine={String(room.isMine)}
        data-joined={String(room.isJoined)}
      >
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-900">
            {GD_FORMAT_LABELS[room.format]}GD
          </p>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>
              参加人数:{' '}
              <span className="font-semibold text-slate-700">
                {room.currentHumanCount} / {room.plannedParticipantCount}人
              </span>
            </span>
            <span>制限時間: {formatMinutes(room.timeLimitSec)}</span>
            <span className="truncate">作成者: {room.hostDisplayName}</span>
            {createdAt && <span>{createdAt}</span>}
          </div>
        </div>

        <div className="shrink-0">
          {room.isMine ? (
            <Link
              href={roomHref}
              className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-xs font-bold text-indigo-700 ring-1 ring-indigo-200 shadow-sm transition-colors hover:bg-indigo-50"
            >
              自分の部屋へ →
            </Link>
          ) : room.isJoined ? (
            <Link
              href={roomHref}
              className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-xs font-bold text-indigo-700 ring-1 ring-indigo-200 shadow-sm transition-colors hover:bg-indigo-50"
            >
              部屋へ戻る →
            </Link>
          ) : room.isFull ? (
            <Button variant="secondary" size="sm" disabled>
              満員
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={onJoin} disabled={disabled}>
              {joining ? '参加中…' : '参加する'}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

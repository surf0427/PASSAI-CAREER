'use client';

// PASSAI 就活版 — GD 公開ロビー画面（STEP-GD-20-C / UI 層）。
//
// できること：
//   1) 募集中の公開GDルーム一覧を見る（GET /api/career/gd/lobby/rooms・10秒ポーリング）
//   2) 公開GDルームを作る（POST /api/career/gd/lobby/create）
//   3) 公開GDルームに参加する（POST /api/career/gd/lobby/join）
//   4) 作成・参加後は既存の /career/gd/room/[roomId] へ遷移するだけ（room 画面は不変）
//   5) 0件時は「公開ルーム作成」「AIと今すぐ練習（/career/gd/setup）」の導線を出す
//
// 秘密（host_user_id / user_id / email / join_code_hash 等）は一切表示しない。
// API レスポンスの公開項目（LobbyRoomSummary）のみを描画する。

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { GD_FORMAT_LABELS } from '../gdRoles';
import type { GdFormat } from '@/types/careerGd';
import type {
  LobbyCreateResponse,
  LobbyRoomSummary,
  LobbyRoomsResponse,
  LobbyJoinResponse,
} from '@/lib/careerGd/publicLobbyTypes';

const FORMATS: GdFormat[] = ['free', 'case', 'abstract'];
const COUNT_OPTIONS = [2, 3, 4, 5, 6, 7, 8];
const TIME_OPTIONS = [
  { sec: 600, label: '10分' },
  { sec: 900, label: '15分' },
  { sec: 1200, label: '20分' },
  { sec: 1800, label: '30分' },
];
const POLL_INTERVAL_MS = 10_000;

const DB_NOT_APPLIED_MESSAGE =
  '公開ロビー機能のDB設定がまだ適用されていません。管理者に確認してください。';

// API の { error, detail } を、内部情報を出さない安全なメッセージに写像する。
function friendlyError(
  status: number,
  data: { error?: string; detail?: string } | null,
  fallback: string,
): string {
  if (data?.error === 'DB_NOT_APPLIED') return DB_NOT_APPLIED_MESSAGE;
  if (status === 401 || status === 403) {
    return 'この操作にはログイン（メール登録済み）が必要です。';
  }
  // detail はサーバが用意したユーザー向け文言（秘密を含まない設計）。無ければ fallback。
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

export default function CareerGdLobbyPage() {
  const router = useRouter();

  // ── 作成フォーム ──
  const [format, setFormat] = useState<GdFormat>('free');
  const [plannedParticipantCount, setPlannedParticipantCount] = useState(4);
  const [timeLimitSec, setTimeLimitSec] = useState(900);
  const [displayName, setDisplayName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createNotice, setCreateNotice] = useState<string | null>(null);

  // ── 一覧 ──
  const [rooms, setRooms] = useState<LobbyRoomSummary[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);

  // ── 参加 ──
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  // マウント後に既定の表示名を localStorage の基本情報から補完（SSR 安全）。
  // setState はタイマーコールバック経由にして effect 本体での同期 setState を避ける。
  useEffect(() => {
    const t = setTimeout(() => {
      const name = loadBasicInfo()?.name?.trim();
      if (name) setDisplayName(name);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const fetchRooms = useCallback(async () => {
    try {
      const res = await fetch('/api/career/gd/lobby/rooms');
      const data = (await res.json().catch(() => null)) as
        | (LobbyRoomsResponse & { error?: string; detail?: string })
        | null;
      if (!res.ok) {
        setRoomsError(friendlyError(res.status, data, '公開ルームの取得に失敗しました。'));
        return;
      }
      setRoomsError(null);
      setRooms(Array.isArray(data?.rooms) ? data.rooms : []);
    } catch {
      setRoomsError('公開ルームの取得に失敗しました。通信環境をご確認ください。');
    } finally {
      setRoomsLoaded(true);
    }
  }, []);

  // 初回取得 + 10 秒ポーリング。離脱時に timer を解除。
  // 初回取得もタイマーコールバック経由にして effect 本体での同期 setState を避ける。
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

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    setCreateNotice(null);
    try {
      const res = await fetch('/api/career/gd/lobby/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          plannedParticipantCount,
          timeLimitSec,
          displayName: displayName.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | (LobbyCreateResponse & { error?: string; detail?: string })
        | null;
      if (!res.ok || !data?.ok || !data.redirectTo) {
        setCreateError(friendlyError(res.status, data, 'ルームの作成に失敗しました。'));
        return;
      }
      if (data.reused) {
        setCreateNotice('既に募集中の公開ルームがあります。そちらへ移動します…');
      }
      router.push(data.redirectTo);
    } catch {
      setCreateError('ルームの作成に失敗しました。通信環境をご確認ください。');
    } finally {
      setCreating(false);
    }
  }

  async function handleJoin(roomId: string) {
    if (joiningRoomId) return;
    setJoiningRoomId(roomId);
    setJoinError(null);
    try {
      const res = await fetch('/api/career/gd/lobby/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, displayName: displayName.trim() || undefined }),
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
        title="公開GDロビー"
        description="他の就活生が作ったGDルームに参加したり、自分で公開ルームを作成できます。人数が足りない場合はAIが補助参加します（ログインが必要）。"
      />

      {/* ── B. 公開ルーム作成フォーム ── */}
      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <h2 className="text-sm font-bold text-slate-800 mb-3">公開ルームを作成</h2>

        <div className="space-y-4">
          <div>
            <p className="text-[11px] font-bold text-slate-500 mb-1.5">形式</p>
            <div className="flex flex-wrap gap-2">
              {FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold ring-1 transition-colors ${
                    format === f
                      ? 'bg-blue-600 text-white ring-blue-600'
                      : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {GD_FORMAT_LABELS[f]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="gd-lobby-count" className="block text-[11px] font-bold text-slate-500 mb-1.5">
                予定人数
              </label>
              <select
                id="gd-lobby-count"
                value={plannedParticipantCount}
                onChange={(e) => setPlannedParticipantCount(Number(e.target.value))}
                className="w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-800 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                {COUNT_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}人
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="gd-lobby-time" className="block text-[11px] font-bold text-slate-500 mb-1.5">
                制限時間
              </label>
              <select
                id="gd-lobby-time"
                value={timeLimitSec}
                onChange={(e) => setTimeLimitSec(Number(e.target.value))}
                className="w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-800 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                {TIME_OPTIONS.map((t) => (
                  <option key={t.sec} value={t.sec}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="gd-lobby-name" className="block text-[11px] font-bold text-slate-500 mb-1.5">
              表示名（任意）
            </label>
            <input
              id="gd-lobby-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={40}
              placeholder="ホスト"
              className="w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-800 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>

          {createError && (
            <p className="text-xs font-semibold text-rose-600" role="alert">
              {createError}
            </p>
          )}
          {createNotice && <p className="text-xs font-semibold text-blue-700">{createNotice}</p>}

          <Button variant="primary" onClick={handleCreate} disabled={creating} className="w-full sm:w-auto">
            {creating ? '作成中…' : '公開ルームを作成'}
          </Button>
        </div>
      </Card>

      {/* ── C. 公開ルーム一覧 ── */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-800">募集中の公開ルーム</h2>
        <button
          type="button"
          onClick={() => void fetchRooms()}
          className="text-xs font-semibold text-slate-500 hover:text-slate-800 rounded-lg border border-slate-200 px-3 py-1.5 transition-colors"
        >
          更新
        </button>
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
        // ── D. 空状態 ──
        <Card variant="soft" padding="md">
          <p className="text-sm font-bold text-slate-800 mb-1">現在募集中の公開ルームはありません</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">
            自分で公開ルームを作成して募集するか、AIと今すぐ練習を始められます。
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button variant="primary" onClick={handleCreate} disabled={creating} className="w-full sm:w-auto">
              {creating ? '作成中…' : '自分で公開ルームを作成する'}
            </Button>
            <Link
              href="/career/gd/setup"
              className="inline-flex items-center justify-center rounded-xl bg-white px-5 py-2.5 text-sm font-bold text-blue-700 ring-1 ring-blue-200 shadow-sm transition-colors hover:bg-blue-50"
            >
              AIと今すぐ練習する →
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

      <div className="mt-8">
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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-900">{GD_FORMAT_LABELS[room.format]}</p>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>
              参加人数:{' '}
              <span className="font-semibold text-slate-700">
                {room.currentHumanCount} / {room.plannedParticipantCount}
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
              自分のルームへ戻る →
            </Link>
          ) : room.isJoined ? (
            <Link
              href={roomHref}
              className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2 text-xs font-bold text-indigo-700 ring-1 ring-indigo-200 shadow-sm transition-colors hover:bg-indigo-50"
            >
              ルームへ戻る →
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

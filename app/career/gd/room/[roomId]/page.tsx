'use client';

// PASSAI 就活版 — GD Phase2 マルチGD ロビー画面（STEP-GD-13）。
// room 情報・参加者一覧を表示。host は「AIメンバーを補完して開始」で waiting→active にできる。
// AI メンバーは persona（役回り・要約）付きで表示。GD 進行（session）は STEP-GD-14 で実装予定。

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { useAuthStatus, useIsMember } from '@/app/components/AuthProvider';
import { GD_FORMAT_LABELS, GD_ROLE_LABELS } from '../../gdRoles';
import type { CareerGdRoomDetailResponse, GdRoomStatus } from '@/types/careerGd';

const STATUS_LABELS: Record<GdRoomStatus, string> = {
  waiting: '参加受付中',
  active: 'GD進行中',
  finished: '終了',
  cancelled: '中止',
};

export default function CareerGdRoomLobbyPage() {
  const params = useParams<{ roomId: string }>();
  const roomId = params?.roomId ?? '';
  const authStatus = useAuthStatus();
  const isMember = useIsMember();

  const [detail, setDetail] = useState<CareerGdRoomDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

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

  const start = useCallback(async () => {
    if (!roomId) return;
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch(`/api/career/gd/room/${encodeURIComponent(roomId)}/start`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => null)) as
        | (CareerGdRoomDetailResponse & { error?: string; detail?: string })
        | null;
      if (!res.ok || !data?.room) {
        // 既に開始済み（409）等は最新状態へ寄せるため refresh も行う。
        await refresh();
        throw new Error(data?.detail ?? 'ルームの開始に失敗しました。');
      }
      setDetail(data);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'ルームの開始に失敗しました。');
    } finally {
      setStarting(false);
    }
  }, [roomId, refresh]);

  useEffect(() => {
    // member のときだけ room を取得する（外部システム=API との同期。event handler と同じ役割）。
    // 非 member / loading は下の render 分岐で扱う。refresh 内の setState は外部同期のため許容。
    if (authStatus === 'loading' || !isMember) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- API fetch on mount（外部同期）
    void refresh();
  }, [authStatus, isMember, refresh]);

  if (authStatus === 'loading') {
    return (
      <Shell>
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      </Shell>
    );
  }

  if (!isMember) {
    return (
      <Shell>
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
      <Shell>
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      </Shell>
    );
  }

  if (error || !detail) {
    return (
      <Shell>
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

  const { room, members, isHost } = detail;
  const humanCount = members.filter((m) => !m.isAi && !m.leftAt).length;

  return (
    <Shell>
      <div className="flex items-center justify-between gap-3 mb-5">
        <span className="inline-flex items-center rounded-full bg-blue-100 px-3 py-1 text-xs font-bold text-blue-700">
          {STATUS_LABELS[room.status]}
        </span>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
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

      <Card variant="soft" padding="md" className="mb-5">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
          参加者（{humanCount} / {room.plannedParticipantCount}）
        </p>
        <ul className="flex flex-col gap-2.5">
          {members.map((m) => (
            <li key={m.id} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-800">{m.displayName}</span>
                {m.isHost && (
                  <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">ホスト</span>
                )}
                {m.isAi && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">AI</span>
                )}
                {m.persona?.personaRole && (
                  <span className="text-[11px] text-slate-400">{m.persona.personaRole}</span>
                )}
                <span className="text-[11px] text-slate-400">{GD_ROLE_LABELS[m.role]}</span>
              </div>
              {m.isAi && m.persona?.personaSummary && (
                <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">{m.persona.personaSummary}</p>
              )}
            </li>
          ))}
        </ul>
        {room.status === 'waiting' && (
          <p className="mt-3 text-xs text-slate-500 leading-relaxed">
            予定人数に満たない場合、開始時に不足分をAIが補完します。
          </p>
        )}
      </Card>

      {room.status === 'active' ? (
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm font-bold text-emerald-700 mb-1">開始済み</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            AIメンバーの補完が完了し、GDが開始されました。ディスカッション画面は STEP-GD-14 で実装予定です。
          </p>
        </Card>
      ) : room.status === 'waiting' ? (
        <Card variant="soft" padding="md" className="mb-5">
          {isHost ? (
            <>
              <p className="text-sm font-bold text-slate-800 mb-1">GDを開始する</p>
              <p className="text-xs text-slate-500 leading-relaxed mb-3">
                予定人数（{room.plannedParticipantCount}人）に不足する分をAIメンバーが補完してGDを開始します。開始後は参加受付を締め切ります。
              </p>
              {startError && (
                <p className="text-xs text-red-600 leading-relaxed mb-3" role="alert">
                  {startError}
                </p>
              )}
              <Button variant="primary" size="md" onClick={start} disabled={starting} className="w-full sm:w-auto">
                {starting ? '開始中…' : 'AIメンバーを補完して開始'}
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm font-bold text-slate-800 mb-1">ホストの開始を待っています</p>
              <p className="text-xs text-slate-500 leading-relaxed">
                ホストがGDを開始すると、この画面に反映されます。「更新」を押して最新状態を確認できます。
              </p>
            </>
          )}
        </Card>
      ) : (
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm font-bold text-slate-800 mb-1">このルームは終了しています</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            {STATUS_LABELS[room.status]}の状態です。新しくGDを行うには、合言葉で別のルームに参加してください。
          </p>
        </Card>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <BackLink />
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="マルチGD ロビー" description="参加者の入室を待っています。" />
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

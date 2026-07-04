'use client';

// PASSAI 就活版 — GD Phase2 マルチGD ルーム作成画面（STEP-GD-11）。
// ホストが形式・予定人数・制限時間を選び、6桁参加コードを発行・表示する。
// join / ロビー / 進行は後続 STEP（GD-12〜）。本画面はコード発行まで。

import { useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { useAuthStatus, useIsMember } from '@/app/components/AuthProvider';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { GD_FORMAT_LABELS, GD_FORMAT_DESCRIPTIONS } from '../../gdRoles';
import type { CareerGdRoomCreateResponse, GdFormat } from '@/types/careerGd';
import {
  CAREER_GD_ALLOWED_PARTICIPANT_COUNTS,
  DEFAULT_CAREER_GD_PARTICIPANT_COUNT,
} from '@/lib/careerGd/participantCount';

const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

const FORMATS: GdFormat[] = ['free', 'case', 'abstract'];
// 参加人数は 4/6/8 の 3 択（正本: lib/careerGd/participantCount.ts）。
const COUNT_OPTIONS = CAREER_GD_ALLOWED_PARTICIPANT_COUNTS;
const TIME_OPTIONS = [
  { sec: 600, label: '10分' },
  { sec: 900, label: '15分' },
  { sec: 1200, label: '20分' },
];

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

export default function CareerGdRoomCreatePage() {
  const authStatus = useAuthStatus();
  const isMember = useIsMember();

  const [format, setFormat] = useState<GdFormat>('free');
  const [participantCount, setParticipantCount] = useState<number>(
    DEFAULT_CAREER_GD_PARTICIPANT_COUNT,
  );
  const [timeLimitSec, setTimeLimitSec] = useState(900);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CareerGdRoomCreateResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const displayName = useMemo(
    () => (isMounted ? loadBasicInfo()?.name?.trim() || 'ホスト' : 'ホスト'),
    [isMounted],
  );

  async function handleCreate() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/career/gd/room/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, plannedParticipantCount: participantCount, timeLimitSec, displayName }),
      });
      const data = (await res.json().catch(() => null)) as
        | (CareerGdRoomCreateResponse & { error?: string; detail?: string })
        | null;
      if (!res.ok || !data?.roomId) {
        throw new Error(data?.detail ?? 'ルームの作成に失敗しました。');
      }
      setCreated(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ルームの作成に失敗しました。');
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  // ── 認証ゲート ──
  if (!isMounted || authStatus === 'loading') {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <PageHeader title="マルチGDルームを作成" description="" />
        <Card variant="soft" padding="md">
          <p className="text-sm text-slate-500">読み込み中…</p>
        </Card>
      </div>
    );
  }

  if (!isMember) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <PageHeader
          title="マルチGDルームを作成"
          description="友達・知人と合言葉でグループディスカッションを練習します。"
        />
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm font-bold text-slate-800 mb-2">ログインが必要です</p>
          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            マルチGDは、参加者を識別するためにログイン（メール登録）が必要です。
            1人で練習するソロGDはログインなしで利用できます。
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              href="/login"
              className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              ログインする →
            </Link>
            <Link
              href="/career/gd/setup"
              className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
            >
              ソロGDを始める
            </Link>
          </div>
        </Card>
        <BackLink />
      </div>
    );
  }

  // ── 作成後：参加コード表示 ──
  if (created) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <PageHeader title="ルームを作成しました" description="参加コードを友達に共有してください。" />

        <Card variant="soft" padding="lg" className="mb-5 text-center">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">参加コード（合言葉）</p>
          <p className="text-4xl sm:text-5xl font-black tracking-[0.3em] text-slate-900 mb-3 select-all">
            {created.joinCode}
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button variant="outline" size="sm" onClick={handleCopy}>
              {copied ? 'コピーしました' : 'コードをコピー'}
            </Button>
          </div>
          <p className="mt-4 text-xs text-slate-500 leading-relaxed">
            この6桁コードを友達に伝えてください。参加者は「合言葉で参加」から入力して参加します。
          </p>
          <p className="mt-1 text-xs text-amber-700">
            有効期限：{formatExpiry(created.codeExpiresAt)} まで（作成から30分）
          </p>
        </Card>

        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-2">ルーム設定</p>
          <div className="grid grid-cols-3 gap-y-2 gap-x-4 text-sm">
            <Info label="形式" value={GD_FORMAT_LABELS[created.format]} />
            <Info label="予定人数" value={`${created.plannedParticipantCount}人`} />
            <Info label="制限時間" value={`${Math.round(created.timeLimitSec / 60)}分`} />
          </div>
        </Card>

        {/* ルーム（ロビー）へ入り、参加者を待って手動で開始する（STEP-GD-28: 導線を実ルームへ接続）。 */}
        <Card variant="soft" padding="md" className="mb-5">
          <p className="text-sm font-bold text-slate-800 mb-1">ルームで参加者を待ちましょう</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            「ルームに入る」を押すとロビー（待機画面）に移動します。参加者が合言葉で入室したら、
            ホストのあなたが「開始」を押してGDを始めます（不足分はAIメンバーが補完されます）。
          </p>
        </Card>

        <div className="flex flex-col sm:flex-row gap-3">
          <Link
            href={`/career/gd/room/${created.roomId}`}
            className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700"
          >
            ルームに入る →
          </Link>
          <BackLink />
        </div>
      </div>
    );
  }

  // ── 作成フォーム ──
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="マルチGDルームを作成"
        description="友達・知人と合言葉でグループディスカッションを練習します。不足人数はAIが補完します。"
      />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">GDの形式</p>
        <div className="grid grid-cols-1 gap-3">
          {FORMATS.map((f) => (
            <Option
              key={f}
              label={GD_FORMAT_LABELS[f]}
              description={GD_FORMAT_DESCRIPTIONS[f]}
              active={format === f}
              onClick={() => setFormat(f)}
            />
          ))}
        </div>
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">参加人数（自分を含む）</p>
        <div className="grid grid-cols-3 gap-3">
          {COUNT_OPTIONS.map((c) => (
            <Chip key={c} label={`${c}人`} active={participantCount === c} onClick={() => setParticipantCount(c)} />
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500 leading-relaxed">
          実際の参加者が足りない場合は、開始時にAIメンバーが自動で補完します。
        </p>
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">制限時間（目安）</p>
        <div className="grid grid-cols-3 gap-3">
          {TIME_OPTIONS.map((t) => (
            <Chip key={t.sec} label={t.label} active={timeLimitSec === t.sec} onClick={() => setTimeLimitSec(t.sec)} />
          ))}
        </div>
      </Card>

      {error && (
        <p className="mb-4 text-sm text-red-600 leading-relaxed" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <Button variant="primary" size="md" onClick={handleCreate} disabled={loading} className="w-full sm:w-auto">
          {loading ? '作成中…' : 'ルームを作成 →'}
        </Button>
        <BackLink />
      </div>
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

function Option({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  const base = 'w-full text-left rounded-xl ring-1 p-4 transition-colors';
  const cls = active
    ? `${base} ring-blue-500 bg-blue-50`
    : `${base} ring-slate-200 bg-white hover:bg-slate-50`;
  return (
    <button type="button" onClick={onClick} className={cls}>
      <p className="text-sm font-bold text-slate-900 mb-1">{label}</p>
      <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
    </button>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const base = 'w-full rounded-xl ring-1 py-2.5 text-sm font-semibold transition-colors';
  const cls = active
    ? `${base} ring-blue-500 bg-blue-50 text-blue-700`
    : `${base} ring-slate-200 bg-white text-slate-700 hover:bg-slate-50`;
  return (
    <button type="button" onClick={onClick} className={cls}>
      {label}
    </button>
  );
}

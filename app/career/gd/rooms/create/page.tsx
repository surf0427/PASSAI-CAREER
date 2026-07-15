'use client';

// PASSAI 就活版 — GD部屋を作る（公開GD部屋 作成）画面（STEP-GD-30）。
//
// 公開GD部屋を作成して他の就活生を募集する。作成後は既存の
// /career/gd/room/[roomId]（ロビー）へ遷移し、参加者を待って手動開始する。
//
// 既存 API を流用（新規 API・DB 追加なし）：POST /api/career/gd/lobby/create。
// 合言葉（友達）ルームとは別物：こちらは公開一覧に載る room_type='public_lobby'。
//
// 秘密（join_code_hash / user_id 等）は扱わない。

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { GD_FORMAT_LABELS, GD_FORMAT_DESCRIPTIONS } from '../../gdRoles';
import { ThemeSetupStep } from '../../components/ThemeSetupStep';
import type { GdFormat, GdTheme } from '@/types/careerGd';
import type { LobbyCreateResponse } from '@/lib/careerGd/publicLobbyTypes';
import {
  CAREER_GD_ALLOWED_PARTICIPANT_COUNTS,
  DEFAULT_CAREER_GD_PARTICIPANT_COUNT,
} from '@/lib/careerGd/participantCount';

const FORMATS: GdFormat[] = ['free', 'case', 'abstract'];
// 参加人数は 4/6/8 の 3 択（正本: lib/careerGd/participantCount.ts）。
const COUNT_OPTIONS = CAREER_GD_ALLOWED_PARTICIPANT_COUNTS;
const TIME_OPTIONS = [
  { sec: 600, label: '10分' },
  { sec: 900, label: '15分' },
  { sec: 1200, label: '20分' },
  { sec: 1800, label: '30分' },
];

const DB_NOT_APPLIED_MESSAGE =
  '公開GD部屋のDB設定がまだ適用されていません。管理者に確認してください。';

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

export default function CareerGdPublicRoomCreatePage() {
  const router = useRouter();

  const [step, setStep] = useState<'settings' | 'theme'>('settings');
  const [format, setFormat] = useState<GdFormat>('free');
  const [plannedParticipantCount, setPlannedParticipantCount] = useState<number>(
    DEFAULT_CAREER_GD_PARTICIPANT_COUNT,
  );
  const [timeLimitSec, setTimeLimitSec] = useState(900);
  const [displayName, setDisplayName] = useState('');
  const [theme, setTheme] = useState<GdTheme | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 既定の表示名を localStorage の基本情報から補完（SSR 安全）。
  useEffect(() => {
    const t = setTimeout(() => {
      const name = loadBasicInfo()?.name?.trim();
      if (name) setDisplayName(name);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    if (!theme) {
      setError('GDテーマを確定してください。');
      return;
    }
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/career/gd/lobby/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          plannedParticipantCount,
          timeLimitSec,
          displayName: displayName.trim() || undefined,
          theme,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | (LobbyCreateResponse & { error?: string; detail?: string })
        | null;
      if (!res.ok || !data?.ok || !data.redirectTo) {
        setError(friendlyError(res.status, data, 'GD部屋の作成に失敗しました。'));
        return;
      }
      if (data.reused) {
        setNotice('すでに募集中の公開GD部屋があります。そちらへ移動します…');
      }
      router.push(data.redirectTo);
    } catch {
      setError('GD部屋の作成に失敗しました。通信環境をご確認ください。');
    } finally {
      setCreating(false);
    }
  }, [creating, format, plannedParticipantCount, timeLimitSec, displayName, theme, router]);

  // ── ウィザード step2: GDテーマの設定 ──
  if (step === 'theme') {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <PageHeader
          title="GDテーマの設定"
          description="公開GD部屋を募集する前に、このルームで話し合うGDテーマを決めます。"
        />

        <Card variant="soft" padding="md" className="mb-5">
          <div className="flex items-start justify-between gap-3">
            <div className="grid grid-cols-3 gap-y-2 gap-x-4 text-sm flex-1">
              <SummaryItem label="形式" value={GD_FORMAT_LABELS[format]} />
              <SummaryItem label="募集人数" value={`${plannedParticipantCount}人`} />
              <SummaryItem label="制限時間" value={`${Math.round(timeLimitSec / 60)}分`} />
            </div>
            <button
              type="button"
              onClick={() => setStep('settings')}
              className="shrink-0 text-xs text-slate-500 hover:text-slate-800 underline"
            >
              部屋設定を変更
            </button>
          </div>
        </Card>

        <Card variant="soft" padding="md" className="mb-5">
          <ThemeSetupStep
            format={format}
            participantCount={plannedParticipantCount}
            timeLimitSec={timeLimitSec}
            accent="teal"
            onThemeChange={setTheme}
          />
        </Card>

        {error && (
          <p className="mb-4 text-sm text-rose-600 leading-relaxed" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="mb-4 text-sm font-semibold text-teal-700">{notice}</p>}

        <div className="flex flex-col sm:flex-row gap-3">
          <Button
            variant="primary"
            size="md"
            onClick={handleCreate}
            disabled={creating || !theme}
            className="w-full sm:w-auto"
          >
            {creating ? '作成中…' : 'このテーマでGD部屋を作成 →'}
          </Button>
          <button
            type="button"
            onClick={() => setStep('settings')}
            className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
          >
            ← 部屋設定に戻る
          </button>
        </div>
        {!theme && (
          <p className="mt-2 text-[11px] text-slate-400">
            テーマを確定すると「GD部屋を作成」に進めます。
          </p>
        )}
      </div>
    );
  }

  // ── ウィザード step1: 部屋の設定 ──
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader
        title="GD部屋を作る"
        description="公開GD部屋を作成して参加者を募集します。人数が足りない場合は開始時にAIメンバーが自動で補完します（ログインが必要）。"
      />

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-teal-700 tracking-widest mb-3">GDの形式</p>
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
        <p className="text-[11px] font-bold text-teal-700 tracking-widest mb-3">募集人数（自分を含む）</p>
        <div className="grid grid-cols-3 gap-3">
          {COUNT_OPTIONS.map((c) => (
            <Chip
              key={c}
              label={`${c}人`}
              active={plannedParticipantCount === c}
              onClick={() => setPlannedParticipantCount(c)}
            />
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500 leading-relaxed">
          募集人数に実際の参加者が届かない場合は、開始時にAIメンバーが自動で補完します。
        </p>
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <p className="text-[11px] font-bold text-teal-700 tracking-widest mb-3">制限時間（目安）</p>
        <div className="grid grid-cols-4 gap-2">
          {TIME_OPTIONS.map((t) => (
            <Chip
              key={t.sec}
              label={t.label}
              active={timeLimitSec === t.sec}
              onClick={() => setTimeLimitSec(t.sec)}
            />
          ))}
        </div>
      </Card>

      <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
        <label htmlFor="gd-public-name" className="block text-[11px] font-bold text-teal-700 tracking-widest mb-2">
          表示名（任意）
        </label>
        <input
          id="gd-public-name"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={40}
          placeholder="ホスト"
          className="w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-800 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-400"
        />
        <p className="mt-2 text-xs text-slate-400 leading-relaxed">
          一覧に「作成者」として表示されます。メールアドレスなどの個人情報は公開されません。
        </p>
      </Card>

      <div className="flex flex-col sm:flex-row gap-3">
        <Button
          variant="primary"
          size="md"
          onClick={() => setStep('theme')}
          className="w-full sm:w-auto"
        >
          次へ（GDテーマの設定）→
        </Button>
        <Link
          href="/career/gd/rooms"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          募集中の部屋を見る
        </Link>
        <Link
          href="/career/gd"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← GD練習トップに戻る
        </Link>
      </div>
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
    ? `${base} ring-teal-500 bg-teal-50`
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
    ? `${base} ring-teal-500 bg-teal-50 text-teal-700`
    : `${base} ring-slate-200 bg-white text-slate-700 hover:bg-slate-50`;
  return (
    <button type="button" onClick={onClick} className={cls}>
      {label}
    </button>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500 mb-0.5">{label}</p>
      <p className="text-sm font-semibold text-slate-800">{value}</p>
    </div>
  );
}

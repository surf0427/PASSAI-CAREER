'use client';

// PASSAI 就活版 — GD setup 画面。
// 形式・参加人数・制限時間を選び、テーマ生成 API → 役割ランダム割当 →
// CareerGdSession 生成 → session へ遷移する。Phase1 はソロGD（1人 + AI補完）のみ。

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { useCareerGdVoiceCapabilities } from '@/hooks/useCareerGdVoiceCapabilities';
import { Button } from '@/components/ui/Button';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import type { CareerProfile } from '@/types/careerProfile';
import type { CareerGdSession, GdFormat, GdTheme } from '@/types/careerGd';
import {
  GD_FORMAT_LABELS,
  GD_FORMAT_DESCRIPTIONS,
  GD_ROLE_LABELS,
  buildSoloParticipants,
} from '../gdRoles';
import { upsertGdSession } from '../gdStorage';
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

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cgd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export default function CareerGdSetupPage() {
  const router = useRouter();
  const [format, setFormat] = useState<GdFormat>('free');
  const [participantCount, setParticipantCount] = useState<number>(
    DEFAULT_CAREER_GD_PARTICIPANT_COUNT,
  );
  const [timeLimitSec, setTimeLimitSec] = useState(900);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const profile = useMemo<CareerProfile | null>(
    () => (isMounted ? loadBasicInfo() : null),
    [isMounted],
  );
  const selfName = profile?.name?.trim() || 'あなた';

  // ★ STEP-GD-VOICE: GD は音声でしか進行できないため、**開始前に**音声が使えるかを確かめる。
  //   ここで止めておかないと「テーマを生成し、セッションを作り、進行画面へ入ってから
  //   発言できないと分かる」という最悪の順序になる（AI コストも無駄に発生する）。
  const { readiness: voiceReadiness } = useCareerGdVoiceCapabilities();
  const voiceReady = voiceReadiness.state === 'ready';
  const voiceBlockMessage = voiceReadiness.state === 'ready' || voiceReadiness.state === 'checking'
    ? null
    : voiceReadiness.message;

  async function handleStart() {
    if (loading) return;
    // 音声が使えないなら、テーマ生成（AI コスト）より前で止める。
    if (!voiceReady) return;
    setLoading(true);
    setError(null);
    try {
      // 1) テーマ生成
      const res = await fetch('/api/career/gd/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, participantCount, timeLimitSec }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        throw new Error(data?.detail ?? 'テーマの生成に失敗しました。');
      }
      const data = (await res.json()) as { theme: GdTheme };

      // 2) 役割ランダム割当つきの参加者一式（自分 + AI補完）
      const participants = buildSoloParticipants(selfName, participantCount, format);

      // 3) セッション生成 → 保存 → session へ
      const now = new Date().toISOString();
      const session: CareerGdSession = {
        id: newId(),
        createdAt: now,
        updatedAt: now,
        status: 'in_progress',
        participationMode: 'solo',
        format,
        theme: data.theme,
        timeLimitSec,
        plannedParticipantCount: participantCount,
        participants,
        transcript: [],
      };
      upsertGdSession(session);
      router.push('/career/gd/session');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'GDの開始に失敗しました。');
      setLoading(false);
    }
  }

  // 役割プレビュー（実際の割当は開始時に確定するが、使われる役割を提示する）。
  const previewParticipants = useMemo(
    () => (isMounted ? buildSoloParticipants(selfName, participantCount, format) : []),
    [isMounted, selfName, participantCount, format],
  );

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <PageHeader title="GDの準備" description="形式・人数・時間を選んでグループディスカッションを始めます。" />

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
          あなた1人 + AI参加者{Math.max(participantCount - 1, 1)}人で実施します。
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

      {previewParticipants.length > 0 && (
        <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest mb-3">
            役割の割り当て（開始時にランダムで確定します）
          </p>
          <ul className="flex flex-col gap-1.5">
            {previewParticipants.map((p) => (
              <li key={p.id} className="text-sm text-slate-700 flex items-center gap-2">
                <span className={`shrink-0 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ${p.isSelf ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                  {GD_ROLE_LABELS[p.role]}
                </span>
                <span className="font-semibold">{p.displayName}</span>
                {p.isSelf && <span className="text-[11px] text-blue-600">（あなた）</span>}
                {p.persona && <span className="text-[11px] text-slate-400">{p.persona.style}</span>}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-slate-400">※ 開始ボタンを押すと役割が確定します。</p>
        </Card>
      )}

      {error && (
        <p className="mb-4 text-sm text-red-600 leading-relaxed" role="alert">
          {error}
        </p>
      )}

      {/* 音声が使えない環境では、開始させずに理由を出す（無言で失敗させない）。 */}
      {voiceBlockMessage && (
        <p
          className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800 ring-1 ring-amber-100"
          role="alert"
          data-testid="gd-voice-unavailable"
        >
          {voiceBlockMessage}
        </p>
      )}

      <p className="mb-4 text-xs leading-relaxed text-slate-500">
        GDは音声で進行します。開始後にマイクの使用を許可してください。文字入力は不要です。
      </p>

      <div className="flex flex-col sm:flex-row gap-3">
        <Button
          variant="primary"
          size="md"
          onClick={handleStart}
          disabled={loading || !voiceReady}
          className="w-full sm:w-auto"
        >
          {loading
            ? 'テーマを準備中…'
            : voiceReadiness.state === 'checking'
              ? '音声の準備を確認中…'
              : 'GDを始める →'}
        </Button>
        <Link
          href="/career/gd"
          className="inline-flex items-center justify-center gap-1 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 hover:border-gray-400 rounded-lg px-4 py-2 transition-colors"
        >
          ← GDトップに戻る
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

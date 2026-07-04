'use client';

// PASSAI 就活版 — GD 完全ランダムマッチ パネル（STEP-GD-21 → UX 改善 STEP-GD-23）。
//
// できること：
//   1) 4/6/8 を選んで「ランダムマッチに参加」（POST /api/career/gd/match/enter）
//   2) 待機中は GET /api/career/gd/match/status を 5 秒 polling し、
//      同人数を選んだ他の就活生と room が成立したら room 詳細へ遷移する
//   3) 待機のキャンセル（POST /api/career/gd/match/cancel）／キャンセル後の再参加
//   4) 状態を明確に分ける: idle / entering / waiting / cancelling / cancelled / matched / expired / error
//   5) しばらく相手が来ない場合はソロGDへの導線を出す（1 人だけで即 room を作らない）
//   6) ページ再読み込みでも待機/成立状態を復元（マウント時に status を 1 回確認）
//
// ※ ランダムマッチは「公開ロビー（自分でルームを選ぶ）」「合言葉参加」とは別機能。混同しないよう明示する。
// 秘密（user_id / email / join_code_hash 等）は一切表示しない。API の公開項目のみ描画する。

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  CAREER_GD_ALLOWED_PARTICIPANT_COUNTS,
  DEFAULT_CAREER_GD_PARTICIPANT_COUNT,
  type CareerGdParticipantCount,
} from '@/lib/careerGd/participantCount';
import type {
  MatchEnterResponse,
  MatchStatusResponse,
} from '@/lib/careerGd/matchQueueTypes';

const COUNT_OPTIONS = CAREER_GD_ALLOWED_PARTICIPANT_COUNTS;
const POLL_INTERVAL_MS = 5_000;
// これ以上待っても相手が増えない（waitingCount<=1）なら、ソロGD導線を出す。
const SOLO_HINT_AFTER_SEC = 20;

// 各人数の目安説明（4/6/8 の違いを分かるように）。
const COUNT_HELP: Record<CareerGdParticipantCount, string> = {
  4: '少人数でしっかり発言（成立しやすい）',
  6: '標準的なGD人数',
  8: '大人数で本番に近い（成立に時間がかかることがあります）',
};

type Phase =
  | 'idle'
  | 'entering'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'matched'
  | 'expired'
  | 'error';

function friendlyError(
  status: number,
  data: { error?: string; detail?: string; message?: string } | null,
): string {
  if (data?.error === 'DB_NOT_APPLIED') {
    return 'ランダムマッチ機能のDB設定がまだ適用されていません。管理者に確認してください。';
  }
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
  return data?.detail ?? 'マッチングに失敗しました。時間をおいて再度お試しください。';
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

export function RandomMatchPanel() {
  const router = useRouter();

  const [plannedCount, setPlannedCount] = useState<CareerGdParticipantCount>(
    DEFAULT_CAREER_GD_PARTICIPANT_COUNT,
  );
  const [phase, setPhase] = useState<Phase>('idle');
  const [waitingCount, setWaitingCount] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pollNotice, setPollNotice] = useState<string | null>(null);

  // 遷移済みフラグ（matched で複数回 push しない）。
  const navigatedRef = useRef(false);

  const goToRoom = useCallback(
    (redirectTo: string) => {
      if (navigatedRef.current) return;
      navigatedRef.current = true;
      setPhase('matched');
      router.push(redirectTo);
    },
    [router],
  );

  // マウント時に 1 回だけ現在の状態を復元（再読み込み耐性）。deferred で effect 内同期 setState を避ける。
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/career/gd/match/status');
        const data = (await res.json().catch(() => null)) as MatchStatusResponse | null;
        if (!res.ok || !data) return;
        if (data.status === 'matched' && data.redirectTo) {
          goToRoom(data.redirectTo);
        } else if (data.status === 'waiting') {
          setPlannedCount(data.plannedCount);
          setWaitingCount(data.waitingCount);
          setElapsedSec(0);
          setPhase('waiting');
        }
      } catch {
        // 復元失敗は無視（idle のまま）。
      }
    }, 0);
    return () => clearTimeout(t);
  }, [goToRoom]);

  // 待機中の 5 秒 polling。matched で遷移、cancelled/expired/none で状態を切替。
  useEffect(() => {
    if (phase !== 'waiting') return;
    let active = true;

    async function poll() {
      try {
        const res = await fetch('/api/career/gd/match/status');
        const data = (await res.json().catch(() => null)) as
          | (MatchStatusResponse & { error?: string; detail?: string })
          | null;
        if (!active) return;
        if (!res.ok) {
          // 429 等は待機を壊さず、次の tick で再試行（軽い通知のみ）。
          setPollNotice(friendlyError(res.status, data));
          return;
        }
        setPollNotice(null);
        if (data?.status === 'matched' && data.redirectTo) {
          goToRoom(data.redirectTo);
          return;
        }
        if (data?.status === 'waiting') {
          setWaitingCount(data.waitingCount);
          return;
        }
        if (data?.status === 'expired') {
          setPhase('expired');
          return;
        }
        // cancelled / none → 待機終了（別タブでの取消等）。
        setPhase('cancelled');
      } catch {
        // ネットワーク一時障害は待機を維持し、再試行中であることを控えめに通知。
        if (active) setPollNotice('接続を確認しています…（自動で再試行します）');
      }
    }

    const id = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [phase, goToRoom]);

  // 待機の経過秒。リセットは待機開始時に行い、effect 本体での同期 setState を避ける。
  useEffect(() => {
    if (phase !== 'waiting') return;
    const id = setInterval(() => setElapsedSec((s) => s + 1), 1_000);
    return () => clearInterval(id);
  }, [phase]);

  const handleEnter = useCallback(async () => {
    setPhase('entering');
    setError(null);
    setPollNotice(null);
    setElapsedSec(0);
    navigatedRef.current = false;
    try {
      const res = await fetch('/api/career/gd/match/enter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plannedCount }),
      });
      const data = (await res.json().catch(() => null)) as
        | (MatchEnterResponse & { error?: string; detail?: string })
        | null;
      if (!res.ok || !data?.ok) {
        setError(friendlyError(res.status, data));
        setPhase('error');
        return;
      }
      if (data.status === 'matched') {
        goToRoom(data.redirectTo);
        return;
      }
      setWaitingCount(data.waitingCount);
      setPhase('waiting');
    } catch {
      setError('マッチングの受付に失敗しました。通信環境をご確認ください。');
      setPhase('error');
    }
  }, [plannedCount, goToRoom]);

  const handleCancel = useCallback(async () => {
    setPhase('cancelling');
    setError(null);
    setPollNotice(null);
    try {
      await fetch('/api/career/gd/match/cancel', { method: 'POST' });
    } catch {
      // 取消の通信失敗は致命ではない。UI は cancelled に落とす。
    } finally {
      setPhase('cancelled');
    }
  }, []);

  const isWaiting = phase === 'waiting' || phase === 'cancelling';
  const showSelection =
    phase === 'idle' || phase === 'entering' || phase === 'cancelled' || phase === 'expired' || phase === 'error';
  const showSoloHint = phase === 'waiting' && waitingCount <= 1 && elapsedSec >= SOLO_HINT_AFTER_SEC;

  return (
    <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
      <div
        // E2E test hooks（STEP-GD-21/23）: 非機能属性。挙動は変えない。
        data-testid="gd-random-match-panel"
        data-phase={phase}
        data-waiting-count={waitingCount}
        data-planned-count={plannedCount}
      >
        <h2 className="text-sm font-bold text-slate-800 mb-1">ランダムマッチ</h2>
        <p className="text-xs text-slate-500 leading-relaxed">
          人数を選んで「参加」すると、<span className="font-semibold text-slate-700">同じ人数を希望する他の就活生</span>と
          自動でマッチングします。相手が見つかると自動でGDルームへ移動します。
        </p>
        <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">
          ※ 公開ロビー（自分でルームを選ぶ）や合言葉参加とは別の機能です。足りない人数はAIメンバーが補完されます。
        </p>

        {showSelection && (
          <div className="mt-3 space-y-3">
            {/* 状態バナー（cancelled / expired / error）。idle/entering では出さない。 */}
            {phase === 'cancelled' && (
              <p className="text-xs font-semibold text-slate-600" role="status">
                マッチングをキャンセルしました。もう一度参加できます。
              </p>
            )}
            {phase === 'expired' && (
              <p className="text-xs font-semibold text-amber-700" role="status">
                しばらく相手が見つからず、受付を終了しました。もう一度参加できます。
              </p>
            )}
            {phase === 'error' && error && (
              <p className="text-xs font-semibold text-rose-600" role="alert">
                {error}
              </p>
            )}

            <div>
              <p className="text-[11px] font-bold text-slate-500 mb-1.5">人数を選ぶ</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="ランダムマッチの人数">
                {COUNT_OPTIONS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setPlannedCount(c)}
                    aria-pressed={plannedCount === c}
                    disabled={phase === 'entering'}
                    className={`rounded-lg px-4 py-1.5 text-xs font-bold ring-1 transition-colors disabled:opacity-60 ${
                      plannedCount === c
                        ? 'bg-blue-600 text-white ring-blue-600'
                        : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {c}人
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
                {plannedCount}人: {COUNT_HELP[plannedCount]}
              </p>
            </div>

            <Button
              variant="primary"
              onClick={handleEnter}
              disabled={phase === 'entering'}
              className="w-full sm:w-auto"
            >
              {phase === 'entering' ? '受付中…' : 'ランダムマッチに参加'}
            </Button>
          </div>
        )}

        {isWaiting && (
          <div className="mt-3 space-y-3">
            <div className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-3">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5" aria-hidden>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
                </span>
                <p className="text-sm font-bold text-slate-800">
                  自動マッチング中（{plannedCount}人）
                </p>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-y-1 text-xs">
                <dt className="text-slate-500">希望人数</dt>
                <dd className="font-semibold text-slate-700">{plannedCount}人</dd>
                <dt className="text-slate-500">同じ条件で待機中</dt>
                <dd className="font-semibold text-slate-700">
                  {waitingCount}人<span className="font-normal text-slate-400">（あなたを含む）</span>
                </dd>
                <dt className="text-slate-500">待機時間</dt>
                <dd className="font-semibold text-slate-700 tabular-nums">{formatElapsed(elapsedSec)}</dd>
              </dl>
              <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
                成立すると自動でルームへ移動します。しばらく相手が見つからない場合、受付は自動的に終了します（その場合はもう一度参加してください）。
              </p>
            </div>

            {showSoloHint && (
              <p className="text-xs text-slate-500 leading-relaxed">
                まだ他の参加者を待っています。すぐに始めたい場合は、
                <Link href="/career/gd/setup" className="font-semibold text-blue-700 hover:underline">
                  ソロGD
                </Link>
                も利用できます。
              </p>
            )}

            {pollNotice && (
              <p className="text-[11px] font-semibold text-amber-700" role="status">
                {pollNotice}
              </p>
            )}

            <Button
              variant="secondary"
              onClick={handleCancel}
              disabled={phase === 'cancelling'}
              className="w-full sm:w-auto"
            >
              {phase === 'cancelling' ? 'キャンセル中…' : 'マッチングをキャンセル'}
            </Button>
          </div>
        )}

        {phase === 'matched' && (
          <p className="mt-3 text-sm font-semibold text-blue-700" role="status">
            マッチングしました。ルームへ移動します…
          </p>
        )}
      </div>
    </Card>
  );
}

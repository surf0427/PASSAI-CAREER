'use client';

// PASSAI 就活版 — GD 完全ランダムマッチ パネル（STEP-GD-21 / UI 層）。
//
// できること：
//   1) 4/6/8 を選んで「ランダムマッチに参加」（POST /api/career/gd/match/enter）
//   2) 待機中は GET /api/career/gd/match/status を 5 秒 polling し、
//      同人数を選んだ他の就活生と room が成立したら room 詳細へ遷移する
//   3) 待機のキャンセル（POST /api/career/gd/match/cancel）
//   4) しばらく相手が来ない場合はソロGDへの導線を出す（1 人だけで即 room を作らない）
//
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
// これ以上待っても相手が増えない（waitingCount=1）なら、ソロGD導線を出す。
const SOLO_HINT_AFTER_SEC = 20;

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

type Phase = 'idle' | 'waiting';

export function RandomMatchPanel() {
  const router = useRouter();

  const [plannedCount, setPlannedCount] = useState<CareerGdParticipantCount>(
    DEFAULT_CAREER_GD_PARTICIPANT_COUNT,
  );
  const [phase, setPhase] = useState<Phase>('idle');
  const [waitingCount, setWaitingCount] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [entering, setEntering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 遷移済みフラグ（matched で複数回 push しない）。
  const navigatedRef = useRef(false);

  const goToRoom = useCallback(
    (redirectTo: string) => {
      if (navigatedRef.current) return;
      navigatedRef.current = true;
      setNotice('マッチングしました。ルームへ移動します。');
      router.push(redirectTo);
    },
    [router],
  );

  // 待機中の 5 秒 polling。matched で遷移、cancelled/expired/none で idle へ戻す。
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
          // 429 等は待機を壊さず、次の tick で再試行。
          setError(friendlyError(res.status, data));
          return;
        }
        setError(null);
        if (data?.status === 'matched' && data.redirectTo) {
          goToRoom(data.redirectTo);
          return;
        }
        if (data?.status === 'waiting') {
          setWaitingCount(data.waitingCount);
          return;
        }
        // cancelled / expired / none → 待機終了。
        if (data?.status === 'expired') {
          setNotice('時間切れになりました。もう一度お試しください。');
        }
        setPhase('idle');
      } catch {
        // ネットワーク一時障害は次 tick で回復。画面は壊さない。
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

  // 待機の経過秒（ソロ導線の判定用）。waiting の間だけカウントする。
  // リセットは待機開始時（handleEnter）に行い、effect 本体での同期 setState を避ける。
  useEffect(() => {
    if (phase !== 'waiting') return;
    const id = setInterval(() => setElapsedSec((s) => s + 1), 1_000);
    return () => clearInterval(id);
  }, [phase]);

  async function handleEnter() {
    if (entering) return;
    setEntering(true);
    setError(null);
    setNotice(null);
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
        return;
      }
      if (data.status === 'matched') {
        goToRoom(data.redirectTo);
        return;
      }
      // waiting。
      setWaitingCount(data.waitingCount);
      setPhase('waiting');
    } catch {
      setError('マッチングの受付に失敗しました。通信環境をご確認ください。');
    } finally {
      setEntering(false);
    }
  }

  async function handleCancel() {
    if (cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      await fetch('/api/career/gd/match/cancel', { method: 'POST' });
    } catch {
      // 取消の通信失敗は致命ではない。UI は idle に戻す。
    } finally {
      setCancelling(false);
      setPhase('idle');
      setNotice(null);
    }
  }

  const showSoloHint = phase === 'waiting' && waitingCount <= 1 && elapsedSec >= SOLO_HINT_AFTER_SEC;

  return (
    <Card variant="soft" padding="md" className="mb-5 sm:mb-6">
      <div
        // E2E test hooks（STEP-GD-21）: 非機能属性。挙動は変えない。
        data-testid="gd-random-match-panel"
        data-phase={phase}
        data-waiting-count={waitingCount}
      >
        <h2 className="text-sm font-bold text-slate-800 mb-1">ランダムマッチ</h2>
        <p className="text-xs text-slate-500 leading-relaxed mb-3">
          人数を選んで、同じ人数を希望する就活生と自動でマッチングします。足りない人数はAIメンバーが補完されます。
        </p>

        {phase === 'idle' ? (
          <div className="space-y-3">
            <div>
              <p className="text-[11px] font-bold text-slate-500 mb-1.5">人数</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="ランダムマッチの人数">
                {COUNT_OPTIONS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setPlannedCount(c)}
                    aria-pressed={plannedCount === c}
                    className={`rounded-lg px-4 py-1.5 text-xs font-bold ring-1 transition-colors ${
                      plannedCount === c
                        ? 'bg-blue-600 text-white ring-blue-600'
                        : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {c}人
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <p className="text-xs font-semibold text-rose-600" role="alert">
                {error}
              </p>
            )}
            {notice && <p className="text-xs font-semibold text-blue-700">{notice}</p>}

            <Button
              variant="primary"
              onClick={handleEnter}
              disabled={entering}
              className="w-full sm:w-auto"
            >
              {entering ? '受付中…' : 'ランダムマッチに参加'}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-white ring-1 ring-slate-200 px-3 py-3">
              <p className="text-sm font-bold text-slate-800">
                マッチング待機中です（{plannedCount}人）
              </p>
              <p className="mt-1 text-xs text-slate-500 leading-relaxed">
                現在、同じ条件で待機中の参加者が{' '}
                <span className="font-semibold text-slate-700">{waitingCount}</span> 人います。
                成立すると自動でルームへ移動します。
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

            {error && (
              <p className="text-xs font-semibold text-rose-600" role="alert">
                {error}
              </p>
            )}
            {notice && <p className="text-xs font-semibold text-blue-700">{notice}</p>}

            <Button
              variant="secondary"
              onClick={handleCancel}
              disabled={cancelling}
              className="w-full sm:w-auto"
            >
              {cancelling ? 'キャンセル中…' : 'マッチングをキャンセル'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

'use client';

// PASSAI CAREER — プレゼン発表中のセルフビュー（自分のカメラ映像）。
//
// 目的は「発表している自分の表情・姿勢・目線・身振り・カメラ映りを、発表中に自分で確認する」
// ことだけ。録画でも AI 評価でもない。したがってこの component は:
//   - 映像を server / DB / Storage / localStorage / AI へ一切送らない（MediaStream をそのまま
//     <video> に流すだけ。MediaRecorder / canvas / toDataURL / fetch は使わない）。
//   - 音声を取らない（audio: false）。発表の文字起こしは useVoice の Web Speech API が
//     独立してマイクを扱うため、ここで audio を掴むと競合しうる。video 専用にすることで
//     マイク・音声認識・transcript に一切触れない。
//
// 受験版 app/presentation/record/PresentationRecordClient.tsx のカメラ扱い
//   （getUserMedia → streamRef → video.srcObject → unmount で getTracks().stop()）を
//   踏襲しつつ、録画・Storage 系（MediaRecorder / upload）は持ち込まない。
//
// lifecycle 契約:
//   enabled → getUserMedia({ video: true, audio: false }) → video.srcObject = stream
//   disabled / unmount → stream.getTracks().forEach(t => t.stop())（カメラランプを残さない）
//   ★ React Strict Mode の二重 mount では、cleanup 後に解決した stream も必ず stop する
//     （cancelled フラグ）。stream の二重生成・track リークを起こさない。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

// 表示状態。'denied' / 'unsupported' / 'error' はいずれも「プレゼンは続行できる」扱い。
export type SelfViewStatus =
  | 'off'
  | 'starting'
  | 'on'
  | 'denied'
  | 'unsupported'
  | 'error';

// 権限拒否・カメラ無しでも発表を止めないことを明示する文言（QA で参照される）。
export const SELF_VIEW_MESSAGE: Record<Exclude<SelfViewStatus, 'on' | 'starting'>, string> = {
  off: 'セルフビューはオフです。発表はそのまま続けられます。',
  denied: 'カメラを利用できませんでした（ブラウザで許可されていません）。プレゼンはそのまま続けられます。',
  unsupported: 'このブラウザ・端末ではカメラを利用できませんでした。プレゼンはそのまま続けられます。',
  error: 'カメラを起動できませんでした。プレゼンはそのまま続けられます。',
};

// getUserMedia の失敗理由を表示状態へ落とす。無限に再要求しないよう、失敗しても自動再試行はしない
// （再試行はユーザーが「カメラをオンにする」を押したときだけ）。
function statusFromError(err: unknown): SelfViewStatus {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'unsupported';
  if (name === 'NotSupportedError') return 'unsupported';
  return 'error';
}

// secure context（HTTPS / localhost）以外や旧ブラウザでは navigator.mediaDevices 自体が生えない。
// その場合も「権限拒否と同じ非同期経路」に流すための番兵。こうすることで effect 本体から
// setState が消え（cascading render を作らない）、fallback 表示の分岐も 1 か所に集まる。
const MEDIA_DEVICES_UNAVAILABLE = Object.assign(
  new Error('navigator.mediaDevices.getUserMedia is unavailable'),
  { name: 'NotSupportedError' },
);

type Props = {
  /** mount 時に自動でカメラを取得するか（発表画面では true）。 */
  autoStart?: boolean;
  className?: string;
};

export function SelfViewCamera({ autoStart = true, className = '' }: Props) {
  const [enabled, setEnabled] = useState(autoStart);
  const [status, setStatus] = useState<SelfViewStatus>(autoStart ? 'starting' : 'off');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // track を止めてカメラを解放する。CSS で隠すだけにはしない（インジケータが残るため）。
  const stopStream = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      try {
        video.srcObject = null;
      } catch {
        // ignore（既に detach 済み）
      }
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    if (!enabled) {
      stopStream();
      return;
    }

    const mediaDevices =
      typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;

    let cancelled = false;
    // ★ audio は取らない。マイクは Web Speech API（useVoice）の管轄。
    const request = mediaDevices?.getUserMedia
      ? mediaDevices.getUserMedia({ video: true, audio: false })
      : Promise.reject(MEDIA_DEVICES_UNAVAILABLE);

    request
      .then((stream) => {
        // Strict Mode の再 mount 等で既に unmount 済みなら、その stream は即座に解放する。
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setStatus('on');
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus(statusFromError(err));
        // 失敗したら「オフ」状態に戻す。ボタンが「カメラをオンにする」に戻り、
        // ユーザーが押したときだけ 1 回だけ再取得する（自動での無限再要求をしない）。
        setEnabled(false);
      });

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [enabled, stopStream]);

  // video 要素が stream 取得より後に mount された場合の取りこぼしを防ぐ。
  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (status === 'on' && video && stream && video.srcObject !== stream) {
      video.srcObject = stream;
    }
  }, [status]);

  // 'starting' / 'off' への遷移は effect ではなくこのハンドラで行う
  // （effect 本体での setState を避け、cascading render を作らない）。
  const toggle = useCallback(() => {
    setEnabled(!enabled);
    setStatus(enabled ? 'off' : 'starting');
  }, [enabled]);

  const showingVideo = enabled && status !== 'unsupported';
  const message = status === 'on' || status === 'starting' ? null : SELF_VIEW_MESSAGE[status];

  return (
    <Card variant="soft" padding="md" className={className}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:flex-1">
          <p className="text-[11px] font-bold text-blue-700 tracking-widest">セルフビュー</p>
          <p className="mt-1 text-xs text-slate-600 leading-relaxed">
            発表中の表情・姿勢・目線を自分で確認できます。映像はこの画面に表示するだけで、
            保存も送信もされません（評価には使われません）。
          </p>
          {message && (
            <p className="mt-2 text-xs text-amber-700 leading-relaxed" role="status">
              {message}
            </p>
          )}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={toggle}>
              {enabled ? 'カメラをオフにする' : 'カメラをオンにする'}
            </Button>
          </div>
        </div>

        {showingVideo && (
          <div className="w-full max-w-[280px] shrink-0 self-center sm:w-60 sm:max-w-none sm:self-start">
            <div className="relative overflow-hidden rounded-xl bg-slate-900 aspect-[4/3] ring-1 ring-slate-300">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                // 自分を見る用途なので鏡像で表示する（録画データを加工するわけではない）。
                style={{ transform: 'scaleX(-1)' }}
                className="h-full w-full object-cover"
              />
              {status !== 'on' && (
                <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-slate-300">
                  {status === 'starting' ? 'カメラを起動しています…' : 'カメラは表示されていません'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

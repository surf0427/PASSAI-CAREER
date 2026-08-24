'use client';

// PASSAI 就活版 — GD「Forest Circle」共通ステージ。
//
// ソロ / フレンド / オンラインの **3 モードで同じこの component を使う**。
// モード差は呼び出し側の adapter（既存 state → GdStageParticipant[]）だけに閉じ、
// ここには GD ロジック・API・保存を一切持ち込まない。
//
// 構図:
//   森の背景（SVG）の中に、参加者が椅子に座って円（楕円）を描く。
//   index 0 = 自分が手前中央。中央には余白を残し、テーマ・残り時間・状況だけを置く。

import type { ReactNode } from 'react';
import { ForestBackdrop } from './ForestBackdrop';
import { ParticipantAvatar } from './ParticipantAvatar';
import { computeGdSeats, seatSizeFactor } from './seatLayout';
import type { GdStageParticipant, GdStageSeatTestHook } from './types';

export function GdCircleStage({
  participants,
  themeTitle,
  timer,
  statusLabel,
  headerLeft,
  headerRight,
  seatTestHook,
  className,
}: {
  /** 表示順がそのまま座席順になる。**index 0 を自分にする**こと（手前中央に座る）。 */
  participants: GdStageParticipant[];
  themeTitle: string;
  /** 残り時間の表示ノード（計算は既存 hook / 既存 state のまま渡す）。 */
  timer?: ReactNode;
  /** 「AIが考えています」等の進行状況（既存 state の写像）。 */
  statusLabel?: string | null;
  headerLeft?: ReactNode;
  headerRight?: ReactNode;
  /** 既存 E2E の data-testid を seat に引き継ぐためのフック。 */
  seatTestHook?: (participant: GdStageParticipant) => GdStageSeatTestHook | undefined;
  className?: string;
}) {
  const seats = computeGdSeats(participants.length);
  const sizeFactor = seatSizeFactor(participants.length);
  const speaking = participants.filter((p) => p.speech === 'speaking');
  const thinking = participants.filter((p) => p.speech === 'thinking');
  const liveMessage = speaking.length
    ? `${speaking.map((p) => p.displayName).join('、')} が発言中です。`
    : thinking.length
      ? `${thinking.map((p) => p.displayName).join('、')} が発言を準備しています。`
      : '発言している参加者はいません。';

  return (
    <>
    <section
      className={`gdf-stage${className ? ` ${className}` : ''}`}
      data-count={participants.length}
      aria-label="GD参加者ステージ（森の円卓）"
    >
      <ForestBackdrop />
      {/* 木々のあいだの小さな灯り（数個だけ・常時大量の particle は置かない）。 */}
      <span className="gdf-lamp gdf-lamp--a" aria-hidden="true" />
      <span className="gdf-lamp gdf-lamp--b" aria-hidden="true" />
      <span className="gdf-lamp gdf-lamp--c" aria-hidden="true" />

      {(headerLeft || headerRight) && (
        <div className="gdf-stage__header">
          <div className="gdf-stage__headerSlot">{headerLeft}</div>
          <div className="gdf-stage__headerSlot gdf-stage__headerSlot--end">{headerRight}</div>
        </div>
      )}

      {/* 円の中央（テーマ・残り時間）。主役はあくまで参加者なので小さく保つ。 */}
      <div className="gdf-center">
        <p className="gdf-center__theme" title={themeTitle}>
          {themeTitle}
        </p>
        {timer && <div className="gdf-center__timer">{timer}</div>}
      </div>

      <div className="gdf-ring">
        {participants.map((p, i) => (
          <ParticipantAvatar
            key={p.key}
            participant={p}
            seat={seats[i]}
            sizeFactor={sizeFactor}
            testHook={seatTestHook?.(p)}
          />
        ))}
      </div>

      {/* 発話状態を色・アニメーションだけに頼らず読み上げにも届ける。 */}
      <p className="gdf-sr" aria-live="polite">
        {liveMessage}
      </p>
    </section>
    {/* 進行状況（AI生成中 / 時間切れ など）。
        ★ ステージ内ではなく直下に置く: 状況テキストは実行中に出たり消えたりするため、
          円の中や上部に入れると人数によって参加者の名前札・人物と衝突しうる。
          誰とも重ならない位置に固定し、常に読めるようにする。 */}
    {statusLabel && <p className="gdf-stage__status">{statusLabel}</p>}
    </>
  );
}

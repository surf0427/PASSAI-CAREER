"use client";

// PASSAI 就活版 — 面接官ステージ（オンライン面接の「相手側の画面」）。
//
// Zoom / Meet で面接官と向き合っている感覚を出すための横長ステージ。
//   - 中央: 2D 面接官（InterviewerAvatar / SVG）
//   - 左下: 面接官の役割名 + モード badge
//   - 右上: 現在の状態ピル（🎙 質問中 / 👂 回答を聞いています / …）
//
// ★ 状態は session 画面の既存 state（phase / listening / speaking）から算出した
//   AvatarState をそのまま受け取る。ここで新しい状態管理は作らない。

import {
  InterviewerAvatar,
  AVATAR_STATUS,
  type AvatarState,
} from "./InterviewerAvatar";

export function InterviewerStage({
  role,
  modeLabel,
  state,
}: {
  role: string;
  modeLabel: string;
  state: AvatarState;
}) {
  const status = AVATAR_STATUS[state];
  // 音声波形は「面接官が話している」「回答を聞いている」ときだけ出す。
  const showWave = state === "speaking" || state === "listening";

  return (
    <div
      className="civ-stage"
      data-state={state}
      role="img"
      aria-label={`${role}（${modeLabel}）。${status.label}`}
    >
      <div className="civ-stage__avatar">
        <InterviewerAvatar />
      </div>

      {/* 左下: 面接官名 + モード badge（Zoom の名前タグ相当） */}
      <div className="civ-stage__name">
        <span className="font-semibold text-white">{role}</span>
        <span className="civ-stage__mode">{modeLabel}</span>
      </div>

      {/* 右上: 状態ピル */}
      <div className="civ-stage__status">
        <span aria-hidden>{status.icon}</span>
        <span>{status.label}</span>
        {showWave && (
          <span className="civ-wave" aria-hidden>
            <span className="civ-wave__bar" />
            <span className="civ-wave__bar" />
            <span className="civ-wave__bar" />
          </span>
        )}
      </div>
    </div>
  );
}

// PASSAI 就活版 — GD 公開ロビー（STEP-GD-20）の API 入出力型。
//
// このファイルは client / server 双方から import される想定なので server-only を付けない。
// 秘密情報（join_code_hash / pepper / user_id / email）は一切含めないこと。

import type { GdFormat } from '@/types/careerGd';

// ── POST /api/career/gd/lobby/create ──────────────────────────
export type LobbyCreateRequest = {
  format?: GdFormat;
  plannedParticipantCount?: number;
  timeLimitSec?: number;
  displayName?: string;
};

export type LobbyCreateResponse = {
  ok: true;
  roomId: string;
  redirectTo: string;
  /** 既存の自分の公開待機 room を再利用した場合 true（新規作成しなかった）。 */
  reused?: boolean;
};

// ── GET /api/career/gd/lobby/rooms ────────────────────────────
export type LobbyRoomSummary = {
  roomId: string;
  format: GdFormat;
  timeLimitSec: number;
  plannedParticipantCount: number;
  currentHumanCount: number;
  isFull: boolean;
  isMine: boolean;
  isJoined: boolean;
  hostDisplayName: string;
  createdAt: string;
  updatedAt: string;
};

export type LobbyRoomsResponse = {
  ok: true;
  rooms: LobbyRoomSummary[];
};

// ── POST /api/career/gd/lobby/join ────────────────────────────
export type LobbyJoinRequest = {
  roomId: string;
  displayName?: string;
};

export type LobbyJoinResponse = {
  ok: true;
  roomId: string;
  redirectTo: string;
};

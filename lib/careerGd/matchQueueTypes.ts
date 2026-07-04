// PASSAI 就活版 — GD 完全ランダムマッチ（STEP-GD-21）の API 入出力型。
//
// このファイルは client / server 双方から import される想定なので server-only を付けない。
// 秘密情報（user_id / email / join_code_hash / queue の内部 id 以外の生値）は一切含めないこと。

import type { CareerGdParticipantCount } from '@/lib/careerGd/participantCount';

// ── POST /api/career/gd/match/enter ────────────────────────────
export type MatchEnterRequest = {
  plannedCount: CareerGdParticipantCount; // 4 | 6 | 8
};

// マッチ成立（room が作られた／既に成立済み）。
export type MatchMatchedResult = {
  ok: true;
  status: 'matched';
  roomId: string;
  redirectTo: string;
};

// 待機中（同人数で待っている他の就活生を待つ）。
export type MatchWaitingResult = {
  ok: true;
  status: 'waiting';
  queueId: string;
  plannedCount: CareerGdParticipantCount;
  waitingCount: number;
};

export type MatchEnterResponse = MatchMatchedResult | MatchWaitingResult;

// ── GET /api/career/gd/match/status ────────────────────────────
// waiting/matched に加え、cancelled / expired / none（キュー行が無い）も返す。
export type MatchStatusResponse =
  | MatchMatchedResult
  | MatchWaitingResult
  | { ok: true; status: 'cancelled' }
  | { ok: true; status: 'expired' }
  | { ok: true; status: 'none' };

// ── POST /api/career/gd/match/cancel ───────────────────────────
export type MatchCancelResponse = {
  ok: true;
  cancelled: number;
};

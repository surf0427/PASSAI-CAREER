// PASSAI 就活版 — GD「Forest Circle」ステージの表示用型（presentation layer only）。
//
// ★ この層は GD のロジックを一切持たない。
//   solo（localStorage canonical）/ friend・online（Supabase 正本）の **既存 state を
//   そのまま写す** ための共通 view model だけを定義する。
//   participant identity は必ず既存 metadata（GdParticipant / CareerGdRoomMember）が source of truth。

import type { GdConnectionState } from '@/lib/careerGd/presence';

/**
 * 発話状態（表示専用）。
 *   speaking … 今この人が発言している（＝直近の発言者 / 自分が入力中）
 *   thinking … 発言を生成中（solo の AI ターン）
 *   idle     … 何もしていない
 * ★ 新しい進行 state を作るものではなく、既存 state（phase / 直近 message / 入力欄）の写像。
 */
export type GdStageSpeech = 'speaking' | 'thinking' | 'idle';

/** 円卓に座る参加者 1 人ぶんの表示情報。 */
export type GdStageParticipant = {
  /** React key（room は member.id、solo は participant.id）。 */
  key: string;
  /** 既存の participantId（speaker 判定・test hook で使う）。 */
  participantId: string;
  /** 既存 metadata の表示名。UI 側で別名を作らない。 */
  displayName: string;
  /** 役割ラベル（GD_ROLE_LABELS 済みの文字列）。 */
  roleLabel: string;
  isSelf: boolean;
  isAi: boolean;
  isHost: boolean;
  /** AI persona の役回り（既存 persona.personaRole）。 */
  personaRole?: string | null;
  speech: GdStageSpeech;
  /**
   * 人間参加者の接続状態（multi のみ）。null / undefined なら接続表示しない（solo）。
   * 値の導出は既存 lib/careerGd/presence.ts に委ねる（ここでは表示するだけ）。
   */
  connection?: GdConnectionState | null;
  /** 退室済み（room の leftAt）。 */
  left?: boolean;
};

/** 各 seat の DOM に付ける test hook（既存 E2E の data-testid を維持するために使う）。 */
export type GdStageSeatTestHook = {
  testId?: string;
  /** data-* 属性（data-ai / data-connection など）。 */
  attrs?: Record<string, string>;
};

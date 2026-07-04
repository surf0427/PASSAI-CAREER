// PASSAI 就活版 — GD 完全ランダムマッチ（STEP-GD-21）の server 側共通ヘルパー。
//
// 方針：
//   - member ログイン必須・DB 操作は service-role（API ゲートウェイ方式）。既存 room / 公開ロビーと同じ。
//   - 競合制御（満員・二重 room・二重参加）は Supabase RPC（career_gd_match_enter/poll/cancel）に委譲。
//     API は session.user.id を強制して p_user_id として渡す（body の userId は受け取らない）。
//   - 秘密（user_id / email / join_code_hash）はレスポンス・ログに出さない。
//   - random_match room は room_type='random_match' / join_policy='matched_only' で作られ、
//     公開ロビー一覧（public_lobby 限定）にも合言葉 join にも乗らない。
//
// DB 未適用（career_gd_match_queue_apply.sql 未実行）は isDbNotReady で 503 に安全縮退する。

import 'server-only';
import { isDbNotReady } from '@/lib/careerGd/publicLobby';

export { isDbNotReady };

export const RANDOM_ROOM_TYPE = 'random_match' as const;
export const RANDOM_JOIN_POLICY = 'matched_only' as const;

export function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

export const dbNotReadyResponse = (): Response =>
  jsonError(
    'DB_NOT_APPLIED',
    'ランダムマッチの準備が完了していません（DB 未適用）。しばらくお待ちください。',
    503,
  );

export function matchRedirectTo(roomId: string): string {
  return `/career/gd/room/${roomId}`;
}

function message(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const m = (err as { message?: unknown }).message;
  return typeof m === 'string' ? m : '';
}

// RPC が RAISE した業務例外（人数不正）を判別する。
export function isInvalidCountError(err: unknown): boolean {
  return /INVALID_COUNT/.test(message(err));
}

// テスト/ローカル用の待機時間 override（秒）。本番では未設定＝人数別の 30/45/60 を使う。
// 数値でなければ null（＝RPC 側デフォルト）。負値や NaN は無視する。
export function matchWaitOverrideSec(): number | null {
  const raw = process.env.CAREER_GD_MATCH_WAIT_OVERRIDE_SEC;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

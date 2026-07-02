// PASSAI 就活版 — GD 公開ロビー（STEP-GD-20-B）の server 側共通ヘルパー。
//
// 方針：
//   - member ログイン必須・DB 操作は service-role（API ゲートウェイ方式）。既存 room 系と同じ。
//   - 既存 room/create・room/join・room/start の挙動は変更しない（本モジュールは公開ロビー専用）。
//   - 秘密（join_code_hash / pepper / user_id / email）はレスポンス・ログに出さない。
//   - 公開 room は career_gd_rooms を room_type='public_lobby' / join_policy='public' で使う。
//     join_code_hash は NOT NULL のため 'pub_' + roomId（非 hex）を 1 回の INSERT で入れる。

import 'server-only';
import type { GdFormat } from '@/types/careerGd';
import { isUndefinedTable } from '@/app/api/career/gd/room/roomAuth';

// ── 定数（MVP 固定値） ────────────────────────────────────────
export const PUBLIC_ROOM_TYPE = 'public_lobby' as const;
export const PUBLIC_JOIN_POLICY = 'public' as const;
export const DEFAULT_FORMAT: GdFormat = 'free';
export const DEFAULT_PLANNED_COUNT = 4;
export const DEFAULT_TIME_LIMIT_SEC = 900;
export const MIN_PLANNED_COUNT = 2;
export const MAX_PLANNED_COUNT = 8;
export const MIN_TIME_LIMIT_SEC = 300;
export const MAX_TIME_LIMIT_SEC = 1800;
export const LOBBY_LIST_LIMIT = 50;

const FORMATS: readonly GdFormat[] = ['free', 'case', 'abstract'];

// ── 共通ユーティリティ ────────────────────────────────────────
export function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

// 表示名を安全化（40 文字・trim）。空なら fallback。
export function sanitizeDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const t = value.trim().slice(0, 40);
  return t || fallback;
}

// 公開 room の合言葉ハッシュ。'pub_' 始まりは HMAC(64桁hex) と構造上一致しないため、
// 既存の合言葉 join 検索（.eq('join_code_hash', <hex>)）には決して乗らない。
export function buildPublicJoinCodeHash(roomId: string): string {
  return `pub_${roomId}`;
}

export function lobbyRedirectTo(roomId: string): string {
  return `/career/gd/room/${roomId}`;
}

// ── DB 未適用（STEP-GD-20-A 未実行など）の検出 ────────────────
// テーブル未作成(42P01) だけでなく、room_type/join_policy 列未追加(42703)、
// career_gd_lobby_join 未作成(42883 / PGRST202) も「DB 未適用」として扱う。
function code(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const c = (err as { code?: unknown }).code;
  return typeof c === 'string' ? c : '';
}
function message(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const m = (err as { message?: unknown }).message;
  return typeof m === 'string' ? m : '';
}

export function isMissingColumn(err: unknown): boolean {
  return code(err) === '42703' || /column .* does not exist/i.test(message(err));
}

export function isMissingFunction(err: unknown): boolean {
  return (
    code(err) === '42883' ||
    code(err) === 'PGRST202' ||
    /could not find the function|function .* does not exist/i.test(message(err))
  );
}

export function isDbNotReady(err: unknown): boolean {
  return isUndefinedTable(err) || isMissingColumn(err) || isMissingFunction(err);
}

export const dbNotReadyResponse = (): Response =>
  jsonError(
    'DB_NOT_APPLIED',
    '公開ロビーの準備が完了していません（DB 未適用）。しばらくお待ちください。',
    503,
  );

// RPC career_gd_lobby_join が RAISE した業務例外を判別する。
export function isRoomFullError(err: unknown): boolean {
  return /ROOM_FULL/.test(message(err));
}
export function isRoomNotJoinableError(err: unknown): boolean {
  return /ROOM_NOT_JOINABLE/.test(message(err));
}

// ── create 入力の検証（MVP 固定値で補完） ────────────────────
export type ParsedCreateInput =
  | { ok: true; format: GdFormat; plannedParticipantCount: number; timeLimitSec: number; displayName: string }
  | { ok: false; response: Response };

export function parseCreateInput(body: unknown): ParsedCreateInput {
  const b = (body && typeof body === 'object' ? body : {}) as {
    format?: unknown;
    plannedParticipantCount?: unknown;
    timeLimitSec?: unknown;
    displayName?: unknown;
  };

  const format = FORMATS.includes(b.format as GdFormat) ? (b.format as GdFormat) : DEFAULT_FORMAT;

  let plannedParticipantCount = DEFAULT_PLANNED_COUNT;
  if (b.plannedParticipantCount !== undefined) {
    const n = Number(b.plannedParticipantCount);
    if (!Number.isInteger(n) || n < MIN_PLANNED_COUNT || n > MAX_PLANNED_COUNT) {
      return {
        ok: false,
        response: jsonError('INVALID_COUNT', '予定人数は 2〜8 人にしてください。', 400),
      };
    }
    plannedParticipantCount = n;
  }

  let timeLimitSec = DEFAULT_TIME_LIMIT_SEC;
  if (b.timeLimitSec !== undefined) {
    const n = Number(b.timeLimitSec);
    if (!Number.isFinite(n) || n < MIN_TIME_LIMIT_SEC || n > MAX_TIME_LIMIT_SEC) {
      return {
        ok: false,
        response: jsonError('INVALID_TIME', '制限時間は 300〜1800 秒にしてください。', 400),
      };
    }
    timeLimitSec = Math.round(n);
  }

  return {
    ok: true,
    format,
    plannedParticipantCount,
    timeLimitSec,
    displayName: sanitizeDisplayName(b.displayName, 'ホスト'),
  };
}

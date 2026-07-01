// PASSAI 就活版 — GD Phase2 マルチGD 参加コード（合言葉）ユーティリティ（server-only）。
//
// - 6 桁数字コードを生成・正規化し、room_salt 込みで sha256 ハッシュ化する。
// - 平文コードは DB に保存しない（create API 応答で 1 回だけ返す）。DB には hash と salt を保存。
// - hash / salt の秘密ロジックをクライアントへ出さないため、本ファイルは server-only とする。
//   （node:crypto を使うためどのみち client では動かないが、多段防御で 'server-only' を付ける）

import 'server-only';

import { randomInt, randomBytes, createHash } from 'node:crypto';

// 6 桁数字コードを生成する（"000000"〜"999999"）。暗号学的乱数を使う。
export function generateSixDigitJoinCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// 入力コードを正規化する（全角→半角は呼び出し側で済ませる前提。ここでは数字のみ抽出）。
// 空白・ハイフン等を除去し、数字だけを連結して返す。join（STEP-GD-12）でも再利用する。
export function normalizeJoinCode(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[^0-9]/g, '');
}

// room ごとの salt（hex 32 文字）。行ごとに異なる値を生成する。
export function createRoomSalt(): string {
  return randomBytes(16).toString('hex');
}

// join_code_hash = sha256(normalizedCode + room_salt)。DB に保存するのはこの値。
export function hashJoinCode(code: string, salt: string): string {
  const normalized = normalizeJoinCode(code);
  return createHash('sha256').update(`${normalized}${salt}`).digest('hex');
}

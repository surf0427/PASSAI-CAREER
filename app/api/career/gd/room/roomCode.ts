// PASSAI 就活版 — GD Phase2 マルチGD 参加コード（合言葉）ユーティリティ（server-only）。
//
// STEP-GD-12 で hash 方式を修正:
//   - 旧: sha256(code + room_salt)。room_salt が部屋ごとに異なると、同じ 6 桁コードでも
//     hash が変わり `UNIQUE(join_code_hash) WHERE status='waiting'` が平文重複を防げなかった。
//   - 新: HMAC-SHA256(normalizedCode, serverSidePepper)。**deterministic**（同じコード＝同じ hash）。
//     → waiting 中の一意制約が平文 6 桁コードの重複を正しく防ぎ、join でも hash 一致検索できる。
//   - room_salt は廃止（DDL からも削除）。DB には平文コードを保存しない（hash のみ）。
//
// pepper（server-side secret）:
//   - CAREER_GD_JOIN_CODE_PEPPER を **明示設定するのが正**（env contract の必須項目）。
//   - 未設定時の fallback は **CAREER（Project B）の service-role key のみ**。受験版
//     （Project A / SUPABASE_SERVICE_ROLE_KEY）は絶対に参照しない。Project A の鍵に依存すると
//     career の join code が受験版プロジェクトの secret に結び付き、分離が崩れる。
//   - どちらも未設定なら hashJoinCode は null を返す（呼び出し側で 503 にする）。
//   - pepper 実値はログ出力・クライアント露出しない（本ファイルは server-only）。

import 'server-only';

import { randomInt, createHmac } from 'node:crypto';
import { getCareerSupabaseServiceRoleKey } from '@/lib/careerSupabase/env';

// 6 桁数字コードを生成する（"000000"〜"999999"）。暗号学的乱数を使う。
export function generateSixDigitJoinCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// 入力コードを正規化する（数字だけを抽出。空白・ハイフン・全角等の非数字を除去）。
export function normalizeJoinCode(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[^0-9]/g, '');
}

// 6 桁数字として妥当か（normalize 済みの前提で長さ 6）。
export function isValidJoinCode(normalized: string): boolean {
  return /^[0-9]{6}$/.test(normalized);
}

// server-side pepper を取得（実値は絶対にログ/レスポンスへ出さない）。
function getJoinCodePepper(): string | null {
  const explicit = process.env.CAREER_GD_JOIN_CODE_PEPPER;
  if (explicit && explicit.trim() !== '') return explicit;
  // fallback: CAREER（Project B）service-role key（career env boundary 経由でのみ読む）。
  const fallback = getCareerSupabaseServiceRoleKey();
  if (fallback && fallback.trim() !== '') return fallback;
  return null;
}

// join_code_hash = HMAC-SHA256(normalizedCode, pepper)。deterministic。
// pepper 未設定なら null（呼び出し側で 503 を返すこと）。DB に保存するのはこの値のみ。
export function hashJoinCode(code: string): string | null {
  const pepper = getJoinCodePepper();
  if (!pepper) return null;
  const normalized = normalizeJoinCode(code);
  return createHmac('sha256', pepper).update(normalized).digest('hex');
}

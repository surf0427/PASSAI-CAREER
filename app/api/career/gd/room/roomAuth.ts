// PASSAI 就活版 — GD Phase2 room 系 API の共通認証ヘルパー（server 側）。
//
// マルチGD は member ログイン必須（guest / 匿名は不可）。DB 操作は service-role で行う
// （API ゲートウェイ方式）。本ヘルパーは各 room API の先頭で使う。

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabaseClient } from '@/lib/supabase/serverClient';
import { getServiceRoleSupabaseClient } from '@/lib/supabase/serviceRoleClient';

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

export type MemberAuth = { kind: 'ok'; userId: string } | { kind: 'reject'; response: Response };

// member（メール登録済み）を確認する。guest / 匿名 / env 未設定は分かりやすく拒否。
export async function authenticateGdMember(): Promise<MemberAuth> {
  const authClient = await getServerSupabaseClient();
  if (!authClient) {
    return {
      kind: 'reject',
      response: jsonError('SUPABASE_UNAVAILABLE', 'サーバのデータベース設定が未完了です。時間をおいて再度お試しください。', 503),
    };
  }
  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) {
    return { kind: 'reject', response: jsonError('LOGIN_REQUIRED', 'この操作にはログインが必要です。', 401) };
  }
  if (data.user.is_anonymous) {
    return {
      kind: 'reject',
      response: jsonError('MEMBER_REQUIRED', 'マルチGDはログイン（メール登録）済みのユーザーのみ利用できます。', 403),
    };
  }
  return { kind: 'ok', userId: data.user.id };
}

export type AdminResult = { kind: 'ok'; admin: SupabaseClient } | { kind: 'reject'; response: Response };

// service-role クライアントを取得（未設定なら実値を出さずに 503）。
export function getGdAdmin(): AdminResult {
  try {
    return { kind: 'ok', admin: getServiceRoleSupabaseClient() };
  } catch {
    return {
      kind: 'reject',
      response: jsonError('SERVER_DB_UNCONFIGURED', 'サーバのデータベース設定が未完了です。管理者にお問い合わせください。', 503),
    };
  }
}

// Postgres の「テーブル未作成」を検出（career_gd_multi_apply.sql 未適用）。
export function isUndefinedTable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === '42P01' ||
    (typeof e.message === 'string' && /relation .* does not exist/i.test(e.message))
  );
}

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: unknown }).code === '23505';
}

export const dbNotAppliedResponse = (): Response =>
  jsonError('DB_NOT_APPLIED', 'マルチGDの準備が完了していません（DB 未適用）。しばらくお待ちください。', 503);

/**
 * Company Identity — route 共通の gate（server-only）。
 *
 * 3 条件をすべて満たしたときだけ Company Identity を使う:
 *   1. feature flag ON（code default OFF）
 *   2. Supabase env が設定済み
 *   3. 認証済み（匿名ユーザーを含まない）
 *
 * ★ どれか欠けても **エラーにしない**。`available:false` を返し、UI は free-text へ倒す。
 *   Company Spine の不調で ES / 面接 / プレゼン / 企業研究が使えなくなってはいけない。
 */

import 'server-only';

import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { isCompanyIdentityEnabled } from '@/lib/careerCompanySpine/flags.server';
import type { CompanyIdentityDisabledReason } from '@/types/careerCompanyIdentity';

export type CompanyIdentityGate =
  | { ok: true; userId: string }
  | { ok: false; reason: CompanyIdentityDisabledReason };

export async function evaluateCompanyIdentityGate(): Promise<CompanyIdentityGate> {
  if (!isCompanyIdentityEnabled()) return { ok: false, reason: 'flag_off' };

  try {
    const client = await getCareerServerSupabaseClient();
    if (!client) return { ok: false, reason: 'not_configured' };
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user || data.user.is_anonymous) {
      return { ok: false, reason: 'unauthenticated' };
    }
    return { ok: true, userId: data.user.id };
  } catch {
    return { ok: false, reason: 'lookup_error' };
  }
}

/** gate 不成立 / 取得失敗を統一の envelope で返す（HTTP は常に 200）。 */
export function unavailableResponse(reason: CompanyIdentityDisabledReason): Response {
  return Response.json({ available: false, reason }, { status: 200 });
}

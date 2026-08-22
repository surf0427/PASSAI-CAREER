/**
 * PASSAI CAREER — ユーザー状態の **server 権威** 解決（server-only）。
 *
 * 「認証済みか / 有効な契約があるか / 基本情報が完了しているか」を server session と
 * Project B の実データだけから確定し、lib/careerRouting/destination.ts の純関数へ渡す。
 *
 * ★ 権利判定は必ず既存の central resolver（lib/careerBilling/entitlement.ts）に委譲する。
 *   career_subscriptions をここから直接 SELECT しない（AGENTS §17）。
 * ★ client の主張（query / body / localStorage / session_id）は一切参照しない。
 * ★ fail-closed: 判定不能（DDL 未適用 / service_role 未設定 / DB エラー）は 'unavailable'
 *   として **契約なし側**へ倒す。「確認できないから通す」は課金の穴になる。
 */

import 'server-only';

import { devWarn } from '@/lib/devLog';
import { resolveCareerEntitlement } from '@/lib/careerBilling/entitlement';
import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { CAREER_SOURCE_TABLES } from '@/lib/careerSourceData/types';
import {
  rowToCareerProfile,
  type CareerJsonDataRow,
} from '@/lib/careerSourceData/rowMappers';
import {
  isCareerBasicInfoComplete,
  type CareerAccessState,
} from './destination';

/**
 * 基本情報の durable mirror（career_profiles）を owner-scoped で読む。
 *
 * canonical は localStorage（app/career/profile/profileStorage.ts）で、本 table はその
 * mirror。server からは mirror しか見えないため、**mirror が無い＝未完了**として扱う。
 * これは常に「基本情報入力へ送る」方向に倒れる安全な誤りで、権利を与える側には倒れない
 * （送られた先の ProfileClient が mirror / localStorage から復元して prefill する）。
 *
 * service_role は使わない。anon client + cookie session で RLS（auth.uid()=user_id）に守らせる。
 */
async function readCareerBasicInfoComplete(userId: string): Promise<boolean> {
  const client = await getCareerServerSupabaseClient();
  if (!client) return false;
  try {
    const { data, error } = await client
      .from(CAREER_SOURCE_TABLES.profile)
      .select('data')
      .eq('user_id', userId)
      .maybeSingle<CareerJsonDataRow>();
    if (error) {
      // table 未作成 / RLS / network。UUID や raw error 本文は出さない。
      devWarn('[careerRouting] profile mirror read failed');
      return false;
    }
    return isCareerBasicInfoComplete(rowToCareerProfile(data));
  } catch {
    devWarn('[careerRouting] profile mirror read threw');
    return false;
  }
}

/**
 * 現在の request のユーザー状態を確定する。
 *
 * entitlement resolver の reject を status code で読み替える:
 *   401 LOGIN_REQUIRED / 403 MEMBER_REQUIRED → guest
 *   それ以外（503 = DDL 未適用 / service_role 未設定 / DB エラー）→ unavailable
 */
export async function resolveCareerAccessState(): Promise<CareerAccessState> {
  const result = await resolveCareerEntitlement();

  if (result.kind === 'reject') {
    const status = result.response.status;
    if (status === 401 || status === 403) return { kind: 'guest' };
    return { kind: 'unavailable' };
  }

  const { entitlement } = result;
  if (!entitlement.paid) return { kind: 'unpaid' };

  return {
    kind: 'paid',
    basicInfoComplete: await readCareerBasicInfoComplete(entitlement.userId),
  };
}

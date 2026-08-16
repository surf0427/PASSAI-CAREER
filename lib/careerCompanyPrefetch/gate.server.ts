/**
 * Company Prefetch — route 共通の gate（server-only・never-throw）。
 *
 * 既存 `lib/careerCompanyIdentity/gate.server.ts` と同形だが **別 gate**。
 * 理由: Identity gate は `CAREER_COMPANY_IDENTITY_ENABLED`（= `/career/company` UI と
 *   3 本の public Identity API の露出）を守るものであり、それを ON にすると
 *   Phase 1 で意図的に伏せた Identity UI 導線まで開いてしまう。
 *   prefetch は **UI を一切開かずに server 内部だけで**動く必要があるため、
 *   権限判定を独立させる。
 *
 * 全条件（AND）を満たしたときだけ prefetch を実行する:
 *   1. `CAREER_COMPANY_PREFETCH_ENABLED` が ON（code default OFF）
 *   2. Supabase env が設定済み（Project B）
 *   3. 認証済み member（匿名ユーザーを含まない）
 *   4. canary allowlist に掲載（fail-closed。未設定なら誰も通らない）
 *   5. rate limit 内
 *
 * ★ どれか欠けても **エラーにしない**。`accepted:false` を返し、
 *   ユーザーの free-text 保存フローは一切影響を受けない。
 */

import 'server-only';

import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { checkServerRateLimit } from '@/lib/serverRateLimit';
import {
  INTENT_RATE_LIMIT_MAX_REQUESTS,
  INTENT_RATE_LIMIT_WINDOW_MS,
} from './constants';
import {
  isCompanyPrefetchEnabled,
  isCompanyPrefetchEnabledForUser,
} from './flags.server';

/** gate 不成立の理由（固定 enum。ログ・レスポンスに出せる値だけ）。 */
export type CompanyPrefetchDisabledReason =
  | 'flag_off'
  | 'not_configured'
  | 'unauthenticated'
  | 'not_targeted'
  | 'rate_limited'
  | 'lookup_error';

export type CompanyPrefetchGate =
  | { ok: true; userId: string }
  | { ok: false; reason: CompanyPrefetchDisabledReason };

/**
 * prefetch を実行してよいかを判定する。
 *
 * ★ 判定順が重要: flag → env/auth → targeting → rate limit。
 *   flag OFF のときは **auth すら引かない**（I/O ゼロを構造的に保証する）。
 */
export async function evaluateCompanyPrefetchGate(
  req?: Request,
): Promise<CompanyPrefetchGate> {
  // (1) flag。ここで落ちる限り Supabase にも外部にも一切触れない。
  if (!isCompanyPrefetchEnabled()) return { ok: false, reason: 'flag_off' };

  // (2)(3) env + 認証済み member。
  let userId: string;
  try {
    const client = await getCareerServerSupabaseClient();
    if (!client) return { ok: false, reason: 'not_configured' };
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user || data.user.is_anonymous) {
      return { ok: false, reason: 'unauthenticated' };
    }
    userId = data.user.id;
  } catch {
    return { ok: false, reason: 'lookup_error' };
  }

  // (4) canary targeting（fail-closed。allowlist 未設定なら誰も通らない）。
  if (!isCompanyPrefetchEnabledForUser(userId)) {
    return { ok: false, reason: 'not_targeted' };
  }

  // (5) rate limit（cost 保護）。req が無い呼び出し（内部 trigger）は IP を持たないため skip。
  if (req) {
    const limit = checkServerRateLimit(req, {
      keyPrefix: 'career-company-intent',
      windowMs: INTENT_RATE_LIMIT_WINDOW_MS,
      maxRequests: INTENT_RATE_LIMIT_MAX_REQUESTS,
    });
    if (!limit.allowed) return { ok: false, reason: 'rate_limited' };
  }

  return { ok: true, userId };
}

/**
 * gate 不成立 / 受付できなかったときの統一 envelope。
 *
 * ★ HTTP は常に 200。prefetch の不調で client 側の保存フローを失敗させない
 *   （client は結果を見ずに投げっぱなしにする）。
 */
export function notAcceptedResponse(reason: CompanyPrefetchDisabledReason): Response {
  return Response.json({ accepted: false, reason }, { status: 200 });
}

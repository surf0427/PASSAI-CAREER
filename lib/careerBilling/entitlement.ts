/**
 * PASSAI CAREER — entitlement resolver（server-only / CAREER 全体の唯一の判定入口）。
 *
 * AGENTS §17: 「CAREER 全体で subscription 判定をバラバラに書かない」。
 * paywall を実装するときは **必ず本 module の関数だけ**を使うこと。
 * route ごとに career_subscriptions を直接 SELECT したり、status 文字列を
 * 手書き比較したりしてはいけない（policy の分岐は entitlementPolicy.ts に一本化）。
 *
 * 正本の連鎖:
 *   Stripe（billing truth）
 *     → signed webhook（同期）
 *       → career_subscriptions（Project B / authenticated は書き込み不可）
 *         → deriveCareerEffectivePlan（純粋関数）
 *           → 本 module（server 判定）
 *
 * 明示的に禁止していること:
 *   - Checkout success ページへの到達を根拠に権利を与えない。
 *   - client から送られた plan / userId / customerId / premium フラグを信用しない。
 *   - env 不足・DB 未適用・DB エラーを "free 以上" に倒さない（fail-closed）。
 */

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { devWarn } from '@/lib/devLog';
import { getCareerServerSupabaseClient } from '@/lib/careerSupabase/serverClient';
import { getCareerServiceRoleSupabaseClient } from '@/lib/careerSupabase/serviceRoleClient';
import { CAREER_SUBSCRIPTIONS_TABLE } from './subscription';
import { isUndefinedTable } from './customer';
import {
  careerPlanSatisfies,
  deriveCareerEffectivePlan,
  hasCareerPaidAccess,
  type CareerSubscriptionRow,
} from './entitlementPolicy';
import type { CareerEffectivePlan, CareerPaidPlanId } from './plans';

const SUBSCRIPTION_COLUMNS =
  'plan, status, current_period_end, cancel_at_period_end';

// ── 認証（Project B / cookie session）─────────────────────────────────────

export type CareerBillingAuth =
  | { kind: 'ok'; userId: string; email: string | null }
  | { kind: 'reject'; response: Response };

function jsonError(error: string, detail: string, status: number): Response {
  return Response.json({ error, detail }, { status });
}

/**
 * CAREER member（メール登録済み）を server session から確定する。
 * client が body / header で名乗った identity は一切参照しない。
 */
export async function authenticateCareerMember(): Promise<CareerBillingAuth> {
  const authClient = await getCareerServerSupabaseClient();
  if (!authClient) {
    return {
      kind: 'reject',
      response: jsonError(
        'SUPABASE_UNAVAILABLE',
        'サーバのデータベース設定が未完了です。時間をおいて再度お試しください。',
        503,
      ),
    };
  }

  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) {
    return {
      kind: 'reject',
      response: jsonError('LOGIN_REQUIRED', 'この操作にはログインが必要です。', 401),
    };
  }
  if (data.user.is_anonymous === true) {
    return {
      kind: 'reject',
      response: jsonError(
        'MEMBER_REQUIRED',
        'この操作にはメールログインが必要です。',
        403,
      ),
    };
  }
  return { kind: 'ok', userId: data.user.id, email: data.user.email ?? null };
}

/** service_role client（未設定なら実値を出さずに 503）。 */
export type CareerBillingAdmin =
  | { kind: 'ok'; admin: SupabaseClient }
  | { kind: 'reject'; response: Response };

export function getCareerBillingAdmin(): CareerBillingAdmin {
  try {
    return { kind: 'ok', admin: getCareerServiceRoleSupabaseClient() };
  } catch {
    return {
      kind: 'reject',
      response: jsonError(
        'SERVER_DB_UNCONFIGURED',
        'サーバのデータベース設定が未完了です。管理者にお問い合わせください。',
        503,
      ),
    };
  }
}

// ── subscription state の取得 ────────────────────────────────────────────

export type CareerSubscriptionSnapshot = {
  plan: CareerEffectivePlan;
  /** UI 表示用。最新（current_period_end 降順）の 1 行。行が無ければ null。 */
  latest: CareerSubscriptionRow | null;
  rows: CareerSubscriptionRow[];
};

export type CareerSubscriptionStateResult =
  | { kind: 'ok'; snapshot: CareerSubscriptionSnapshot }
  /** career_billing_apply.sql が未適用。課金機能そのものが未配線。 */
  | { kind: 'not-provisioned' }
  | { kind: 'db-error'; message: string };

/**
 * userId の subscription 行をすべて読み、実効プランを導出する。
 * 読み取りは service_role（RLS を通さない安定パス）。userId は **必ず server session 由来**。
 */
export async function getCareerSubscriptionState(input: {
  admin: SupabaseClient;
  userId: string;
}): Promise<CareerSubscriptionStateResult> {
  const { data, error } = await input.admin
    .from(CAREER_SUBSCRIPTIONS_TABLE)
    .select(SUBSCRIPTION_COLUMNS)
    .eq('user_id', input.userId);

  if (error) {
    if (isUndefinedTable(error)) return { kind: 'not-provisioned' };
    devWarn('[careerBilling/entitlement] subscription select failed', error);
    return { kind: 'db-error', message: error.message ?? 'subscription select failed' };
  }

  const rows = (data ?? []) as CareerSubscriptionRow[];
  const plan = deriveCareerEffectivePlan(rows);

  // 表示用の代表行: 権利のある行を優先し、その中で period_end が最も未来のもの。
  const latest =
    [...rows]
      .sort(
        (a, b) =>
          new Date(b.current_period_end ?? 0).getTime() -
          new Date(a.current_period_end ?? 0).getTime(),
      )
      .at(0) ?? null;

  return { kind: 'ok', snapshot: { plan, latest, rows } };
}

// ── 統合 resolver ────────────────────────────────────────────────────────

export type CareerEntitlement = {
  userId: string;
  email: string | null;
  plan: CareerEffectivePlan;
  paid: boolean;
  snapshot: CareerSubscriptionSnapshot;
};

export type CareerEntitlementResult =
  | { kind: 'ok'; entitlement: CareerEntitlement }
  | { kind: 'reject'; response: Response };

/**
 * 「ログイン中の CAREER ユーザーの実効プラン」を 1 呼び出しで解決する。
 * 未ログイン / DB 未設定 / DB エラーはすべて reject（= 権利を与えない）。
 */
export async function resolveCareerEntitlement(): Promise<CareerEntitlementResult> {
  const auth = await authenticateCareerMember();
  if (auth.kind === 'reject') return auth;

  const adminResult = getCareerBillingAdmin();
  if (adminResult.kind === 'reject') return adminResult;

  const state = await getCareerSubscriptionState({
    admin: adminResult.admin,
    userId: auth.userId,
  });

  if (state.kind === 'not-provisioned') {
    return {
      kind: 'reject',
      response: jsonError(
        'BILLING_NOT_PROVISIONED',
        '課金機能がまだ利用できません。管理者にお問い合わせください。',
        503,
      ),
    };
  }
  if (state.kind === 'db-error') {
    // fail-closed: 判定不能を「無料で通す」にも「有料として通す」にも倒さない。
    return {
      kind: 'reject',
      response: jsonError(
        'ENTITLEMENT_CHECK_FAILED',
        '契約状態を確認できませんでした。時間をおいて再度お試しください。',
        503,
      ),
    };
  }

  return {
    kind: 'ok',
    entitlement: {
      userId: auth.userId,
      email: auth.email,
      plan: state.snapshot.plan,
      paid: hasCareerPaidAccess(state.snapshot.plan),
      snapshot: state.snapshot,
    },
  };
}

/**
 * 有料機能の server 側ゲート。**paywall を張る route はこれだけを呼ぶ。**
 *
 * ⚠️ 現時点で CAREER のどの機能が Free / Paid かは repo 上に根拠が無いため
 *    （AGENTS §19: 根拠なしに gate しない）、既存の CAREER AI route には
 *    本 guard を**適用していない**。料金仕様が確定したら、対象 route の先頭で
 *      const gate = await requireCareerPaidAccess();
 *      if (gate.kind === 'reject') return gate.response;
 *    を呼ぶだけで server 強制が効く。UI 側の出し分けと二重防御になる。
 *
 * @param required 'basic'（有料であればよい）/ 'premium'（premium 限定機能）。
 */
export type CareerPaidGate =
  | { kind: 'ok'; entitlement: CareerEntitlement }
  | { kind: 'reject'; response: Response };

export async function requireCareerPaidAccess(
  required: CareerPaidPlanId = 'basic',
): Promise<CareerPaidGate> {
  const result = await resolveCareerEntitlement();
  if (result.kind === 'reject') return result;

  const { entitlement } = result;
  if (!careerPlanSatisfies(entitlement.plan, required)) {
    return {
      kind: 'reject',
      response: Response.json(
        {
          error: 'PAYMENT_REQUIRED',
          detail: 'この機能のご利用にはプランのご契約が必要です。',
          plan: entitlement.plan,
          requiredPlan: required,
        },
        { status: 402 },
      ),
    };
  }
  return { kind: 'ok', entitlement };
}

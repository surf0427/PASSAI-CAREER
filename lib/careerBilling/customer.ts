/**
 * PASSAI CAREER — CAREER アカウント ⇄ Stripe Customer の canonical mapping（server-only）。
 *
 * なぜ受験版と構造を変えたか（ADAPTED_FOR_CAREER）:
 *   受験版 `app/api/billing/checkout/route.ts` は「subscriptions 行があればその
 *   stripe_customer_id を再利用、無ければ customer_email を渡して Stripe に自動生成させる」
 *   方式で、コード内コメント自身が
 *     「重複 Customer リスク（checkout 中断を繰り返した場合）は test mode で許容。
 *       恒久的解決は profiles.stripe_customer_id 追加で BILLING-05 以降に検討」
 *   と未解決の課題として記録している。
 *   CAREER は本番前提のため、この既知ギャップを **専用 mapping table** で閉じる:
 *
 *     1 CAREER account (auth.users.id)  ⇄  1 canonical Stripe Customer (cus_...)
 *
 *   career_billing_customers.user_id は PK、stripe_customer_id は UNIQUE。
 *   DB 制約が 1:1 を保証するので、checkout を何度中断しても Customer は増えない。
 *
 * 権限境界:
 *   - service_role でのみ読み書きする（authenticated には GRANT を与えない）。
 *   - customerId を client request から受け取ることは絶対にしない。常に
 *     「server session の userId → この table」で解決する。
 */

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { devWarn } from '@/lib/devLog';
import { getStripeClient } from '@/lib/stripe/server';

const TABLE = 'career_billing_customers';

export type CareerCustomerResult =
  | { kind: 'ok'; customerId: string }
  | { kind: 'db-error'; message: string }
  | { kind: 'stripe-error'; message: string };

/** Postgres「テーブル未作成」（career_billing_apply.sql 未適用）検出。 */
export function isUndefinedTable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === '42P01' ||
    (typeof e.message === 'string' && /relation .* does not exist/i.test(e.message))
  );
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: unknown }).code === '23505';
}

/** mapping を読むだけ（作らない）。Portal など「既存契約者だけ通す」経路で使う。 */
export async function loadCareerStripeCustomerId(
  admin: SupabaseClient,
  userId: string,
): Promise<{ kind: 'ok'; customerId: string | null } | { kind: 'db-error'; message: string }> {
  const { data, error } = await admin
    .from(TABLE)
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    devWarn('[careerBilling/customer] load failed', error);
    return { kind: 'db-error', message: error.message ?? 'customer lookup failed' };
  }
  return {
    kind: 'ok',
    customerId: (data?.stripe_customer_id as string | undefined) ?? null,
  };
}

/**
 * userId に対する canonical Stripe Customer を返す。無ければ作って mapping を保存。
 *
 * 並行 checkout の race:
 *   2 タブが同時に来ると Stripe Customer が 2 個生成され得るが、INSERT は
 *   user_id PK で片方だけが勝つ。負けた側は 23505 を受けて **勝者の customerId を
 *   再読込して使う**ため、以後 CAREER が参照する Customer は常に 1 つに収束する
 *   （負け側の Customer は subscription を持たない孤児として Stripe 側に残るだけ）。
 */
export async function getOrCreateCareerStripeCustomer(input: {
  admin: SupabaseClient;
  userId: string;
  email: string;
}): Promise<CareerCustomerResult> {
  const { admin, userId, email } = input;

  const existing = await loadCareerStripeCustomerId(admin, userId);
  if (existing.kind === 'db-error') return existing;
  if (existing.customerId) return { kind: 'ok', customerId: existing.customerId };

  let customerId: string;
  try {
    const customer = await getStripeClient().customers.create({
      email,
      // Stripe Dashboard から CAREER の顧客だと判別できるようにする。
      // PII は email 以外入れない。
      metadata: { app: 'passai-career', app_user_id: userId },
    });
    customerId = customer.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'customer create failed';
    devWarn('[careerBilling/customer] stripe create failed', message);
    return { kind: 'stripe-error', message };
  }

  const { error: insertErr } = await admin
    .from(TABLE)
    .insert({ user_id: userId, stripe_customer_id: customerId });

  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      // 並行 request が先に勝った → 勝者を正として採用する。
      const winner = await loadCareerStripeCustomerId(admin, userId);
      if (winner.kind === 'ok' && winner.customerId) {
        return { kind: 'ok', customerId: winner.customerId };
      }
    }
    devWarn('[careerBilling/customer] mapping insert failed', insertErr);
    return {
      kind: 'db-error',
      message: insertErr.message ?? 'customer mapping insert failed',
    };
  }

  return { kind: 'ok', customerId };
}

/**
 * webhook 経由で観測した customer を mapping に反映する（後付け・冪等）。
 * Dashboard 手動作成など checkout を通らずに Customer が生まれた場合の保険。
 * 既に mapping があれば **上書きしない**（canonical を勝手に付け替えない）。
 */
export async function rememberCareerStripeCustomer(input: {
  admin: SupabaseClient;
  userId: string;
  customerId: string;
}): Promise<void> {
  const { admin, userId, customerId } = input;
  const { error } = await admin
    .from(TABLE)
    .insert({ user_id: userId, stripe_customer_id: customerId });
  // 23505 = 既に mapping 済み（user_id PK か customer UNIQUE）。冪等なので無視。
  if (error && !isUniqueViolation(error)) {
    devWarn('[careerBilling/customer] remember failed', error);
  }
}

/**
 * PASSAI CAREER — Stripe Subscription → Supabase (Project B) 同期（server-only）。
 *
 * 受験版 `lib/billing/syncSubscription.ts` の構造移植。差分は 2 点だけ:
 *
 *   1. **Project B に閉じる**。career service_role client / career_subscriptions を使い、
 *      受験版の profiles / subscriptions（Project A）には一切触れない。
 *      CAREER の identity は auth.users（Project B）なので、billing state も同じ
 *      auth.uid() 空間に無いと split-brain になる。
 *
 *   2. **denormalized な plan cache を持たない**（ADAPTED_FOR_CAREER）。
 *      受験版は profiles.plan に実効プランを書き戻し、planGate がそれを読む。
 *      CAREER で同じことをすると career_accounts に plan 列を足すことになるが、
 *      career_accounts は member privileges 上 authenticated に UPDATE を GRANT 済み
 *      （supabase/career_member_privileges_apply.sql）なので、**ブラウザから
 *      plan='premium' に書き換えられる**。受験版はこれを trigger
 *      （enforce_profile_plan_protection）で塞いでいるが、CAREER は
 *      そもそも cache を作らず career_subscriptions（authenticated に書き込み権限なし）
 *      から毎回導出する方が単純かつ安全なのでそちらを選ぶ。
 *      → 判定は lib/careerBilling/entitlementPolicy.ts に一本化。
 *
 * Stripe API 2026-05-27.dahlia の仕様:
 *   `current_period_start` / `current_period_end` は Subscription root から削除され、
 *   `subscription.items.data[].current_period_*` に移動している。1 plan = 1 item 前提。
 *
 * Checkout との契約:
 *   Checkout Session 作成時に
 *     subscription_data.metadata = { app_user_id: <auth.uid()> }
 *   を必ず設定する。webhook はまずここから user_id を読む。
 */

import 'server-only';

import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveCareerPlanValueFromPriceId } from './stripe';
import { rememberCareerStripeCustomer } from './customer';
import type { CareerSubscriptionPlanValue } from './plans';

export const CAREER_SUBSCRIPTIONS_TABLE = 'career_subscriptions';
export const CAREER_METADATA_USER_ID_KEY = 'app_user_id';

/** webhook 側で結果を観測 / ログに残せるよう discriminated union を返す。 */
export type CareerSyncResult =
  | { kind: 'ok'; userId: string; plan: CareerSubscriptionPlanValue }
  | { kind: 'no-user-id'; customerId: string; subscriptionId: string }
  | { kind: 'unknown-plan'; subscriptionId: string; priceId: string }
  | { kind: 'no-items'; subscriptionId: string }
  | { kind: 'db-error'; message: string };

export async function syncCareerSubscriptionFromStripe(input: {
  admin: SupabaseClient;
  sub: Stripe.Subscription;
}): Promise<CareerSyncResult> {
  const { admin, sub } = input;

  const subscriptionId = sub.id;
  const customerId =
    typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  // 1 plan = 1 item 前提（CAREER は単一 Price の subscription しか作らない）。
  const item = sub.items.data[0];
  if (!item) return { kind: 'no-items', subscriptionId };

  const priceId = typeof item.price === 'string' ? item.price : item.price.id;

  // ★ CAREER の Price env にしかマッチしない。受験版 subscription が誤って
  //   CAREER webhook に届いた場合はここで null になり、DB を一切変更しない。
  // ★ 単一プラン化後も plan 列には既存 CHECK が許す値を書く（DB migration を足さない）。
  //   値そのものに意味は無く、権利判定は status だけで行う（entitlementPolicy）。
  //   過去に basic / premium で作られた行もそのまま有効な契約として読める。
  const plan = resolveCareerPlanValueFromPriceId(priceId);
  if (!plan) return { kind: 'unknown-plan', subscriptionId, priceId };

  const userId = await resolveCareerUserId({ admin, sub, customerId });
  if (!userId) return { kind: 'no-user-id', customerId, subscriptionId };

  const { error: upsertErr } = await admin
    .from(CAREER_SUBSCRIPTIONS_TABLE)
    .upsert(
      {
        user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        plan,
        status: sub.status,
        current_period_start: unixSecondsToIso(item.current_period_start),
        current_period_end: unixSecondsToIso(item.current_period_end),
        cancel_at_period_end: sub.cancel_at_period_end === true,
      },
      // stripe_subscription_id UNIQUE を conflict target にすることで、
      // 同一 event の再配送でも行が増えない（冪等）。
      { onConflict: 'stripe_subscription_id' },
    );
  if (upsertErr) {
    return {
      kind: 'db-error',
      message: `career_subscriptions upsert failed: ${upsertErr.message}`,
    };
  }

  // Checkout を通らず Dashboard 側で作られた契約でも mapping を追従させる（冪等・非上書き）。
  await rememberCareerStripeCustomer({ admin, userId, customerId });

  return { kind: 'ok', userId, plan };
}

function unixSecondsToIso(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
  return new Date(seconds * 1000).toISOString();
}

async function resolveCareerUserId(input: {
  admin: SupabaseClient;
  sub: Stripe.Subscription;
  customerId: string;
}): Promise<string | null> {
  // 1. subscription.metadata.app_user_id（checkout route が必ず設定する正規経路）
  const meta = input.sub.metadata?.[CAREER_METADATA_USER_ID_KEY];
  if (typeof meta === 'string' && meta.length > 0) return meta;

  // 2. customer mapping 経由（Dashboard 手動操作 / metadata 落ち時の保険）
  const { data: mapped } = await input.admin
    .from('career_billing_customers')
    .select('user_id')
    .eq('stripe_customer_id', input.customerId)
    .maybeSingle();
  const mappedUserId = (mapped?.user_id as string | undefined) ?? null;
  if (mappedUserId) return mappedUserId;

  // 3. 既存 subscription 行の customer_id 経由（最後の保険）
  const { data } = await input.admin
    .from(CAREER_SUBSCRIPTIONS_TABLE)
    .select('user_id')
    .eq('stripe_customer_id', input.customerId)
    .limit(1)
    .maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}

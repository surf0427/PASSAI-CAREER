/**
 * PASSAI CAREER — Stripe Webhook handler（CAREER 専用 endpoint）。
 *
 * POST /api/career/billing/webhook
 *
 * 受験版 `app/api/billing/webhook/route.ts` の構造移植。責務:
 *   1. **署名検証を最初に行う**。検証を通らないリクエストは DB に一切触れず 400。
 *   2. career_stripe_events で event_id 単位に冪等化する:
 *        - 既存 row があり processed_at が non-null → 重複配送。何もせず 200。
 *        - 既存 row があり processed_at が null    → 前回失敗。再処理する。
 *        - 行なし                                  → INSERT してから処理。
 *   3. event を dispatch し、結果で processed_at / error を確定させる。
 *
 * ── 受験版と別 endpoint / 別 secret にする理由 ────────────────────────────
 *   受験版と CAREER は Stripe 上で別 Product / 別 Price を持つ別プロダクト。
 *   endpoint を分けることで webhook secret も分かれ、
 *     - CAREER endpoint に受験版の subscription が届いても Price が一致せず
 *       `unknown-plan`（= permanent error / DB 無変更）で弾かれる
 *     - 片方の secret 漏洩がもう片方の billing state に波及しない
 *   という二重の隔離になる。env は **CAREER_STRIPE_WEBHOOK_SECRET**（受験版の
 *   STRIPE_WEBHOOK_SECRET とは別名）。
 *
 * ── エラー応答方針（受験版と同一）────────────────────────────────────────
 *   - 署名検証失敗            → 400（永続失敗。Stripe は retry しない）
 *   - DB の transient failure → 500（Stripe が retry する）
 *   - permanent failure       → 200 + error 記録（retry しても直らないため）
 *
 * ── 性能（AGENTS §25）─────────────────────────────────────────────────
 *   billing state の同期だけを行う。AI 生成・外部クロール・再生成などは呼ばない。
 *
 * 必要 env:
 *   STRIPE_SECRET_KEY / CAREER_STRIPE_WEBHOOK_SECRET /
 *   CAREER Price env（STRIPE_CAREER_PRICE_ID）/
 *   NEXT_PUBLIC_CAREER_SUPABASE_URL / CAREER_SUPABASE_SERVICE_ROLE_KEY
 */

import 'server-only';

import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';

import { devWarn } from '@/lib/devLog';
import { getCareerServiceRoleSupabaseClient } from '@/lib/careerSupabase/serviceRoleClient';
import { getStripeClient } from '@/lib/careerBilling/stripe';
import {
  currentExpectedStripeLivemode,
  currentStripeRuntimeEnv,
} from '@/lib/stripe/environment';
import { syncCareerSubscriptionById } from '@/lib/careerBilling/subscription';
import { isUndefinedTable } from '@/lib/careerBilling/customer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EVENTS_TABLE = 'career_stripe_events';

/**
 * 実際に state を動かすのは customer.subscription.* の 3 種だけ。
 * checkout.session.completed / invoice.payment_failed は観測用に受けるが、
 * 権利の変化は必ず subscription.* 経由で同期する（受験版と同じ役割分担）。
 */
const HANDLED_EVENT_TYPES = new Set<string>([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'checkout.session.completed',
  'invoice.payment_failed',
]);

function readCareerWebhookSecret(): string {
  const v = process.env.CAREER_STRIPE_WEBHOOK_SECRET;
  if (!v) throw new Error('CAREER_STRIPE_WEBHOOK_SECRET is not set');
  return v;
}

export async function POST(req: Request) {
  // ── 1) raw body & signature ──
  //    Next.js の Request.text() は body を加工しないため署名検証に使える。
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return Response.json(
      { error: 'missing stripe-signature header' },
      { status: 400 },
    );
  }

  // ── 2) 署名検証（★ これを通るまで DB へは一切書かない）──
  let event: Stripe.Event;
  try {
    event = getStripeClient().webhooks.constructEvent(
      body,
      sig,
      readCareerWebhookSecret(),
    );
  } catch (err) {
    // secret / 署名の中身はログにも応答にも出さない。
    devWarn(
      '[career/billing/webhook] signature verification failed',
      err instanceof Error ? err.message : 'unknown',
    );
    return Response.json({ error: 'invalid signature' }, { status: 400 });
  }

  // ── 2.5) test ⇄ live 混線ガード ──
  //    署名が通っている＝ endpoint に対応する Stripe 環境からの event ではあるが、
  //    「Preview（test 期待）に live の webhook secret を貼ってしまった」ような
  //    設定ミスでは live の event が test 想定の DB に同期されてしまう。
  //    event.livemode は Stripe が付ける真の所属モードなので、実行環境の期待と
  //    突き合わせて弾く。永続的な設定ミスなので 400（retry させない）。
  const expectedLivemode = currentExpectedStripeLivemode();
  if (event.livemode !== expectedLivemode) {
    devWarn('[career/billing/webhook] livemode mismatch — event rejected', {
      id: event.id,
      type: event.type,
      runtimeEnv: currentStripeRuntimeEnv(),
      expectedLivemode,
      actualLivemode: event.livemode,
    });
    return Response.json({ error: 'livemode mismatch' }, { status: 400 });
  }

  let supabase: SupabaseClient;
  try {
    supabase = getCareerServiceRoleSupabaseClient();
  } catch {
    // service role 未設定。Stripe に retry させる（設定後に自然回復する）。
    return Response.json({ error: 'service role unavailable' }, { status: 500 });
  }

  // ── 3) 冪等化: 既存 row 状態を確認 → 未処理ならクレーム ──
  const { data: existing, error: selectErr } = await supabase
    .from(EVENTS_TABLE)
    .select('processed_at')
    .eq('event_id', event.id)
    .maybeSingle();

  if (selectErr) {
    if (isUndefinedTable(selectErr)) {
      devWarn('[career/billing/webhook] career_billing_apply.sql not applied');
      return Response.json({ error: 'billing tables not provisioned' }, { status: 500 });
    }
    devWarn('[career/billing/webhook] events select failed', selectErr);
    return Response.json({ error: 'db error' }, { status: 500 });
  }

  if (existing?.processed_at) {
    // 既に処理済み → 何もせず idempotent に 200。
    return Response.json({ received: true, duplicate: true }, { status: 200 });
  }

  if (!existing) {
    const { error: insertErr } = await supabase.from(EVENTS_TABLE).insert({
      event_id: event.id,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
    });
    // 23505 = 同時配送の race。既に別 request が行を作っただけなので続行してよい。
    if (insertErr && (insertErr as { code?: string }).code !== '23505') {
      devWarn('[career/billing/webhook] events insert failed', insertErr);
      return Response.json({ error: 'event log insert failed' }, { status: 500 });
    }
  }

  // ── 4) dispatch ──
  const result = await dispatch({ supabase, event });

  // ── 5) event row の確定 ──
  if (result.kind === 'transient-error') {
    await supabase
      .from(EVENTS_TABLE)
      .update({ error: result.message })
      .eq('event_id', event.id);
    // processed_at は立てない → Stripe の retry で再処理される。
    return Response.json({ error: result.message }, { status: 500 });
  }

  const processedAt = new Date().toISOString();
  const { error: updErr } = await supabase
    .from(EVENTS_TABLE)
    .update({
      processed_at: processedAt,
      error: result.kind === 'permanent-error' ? result.message : null,
    })
    .eq('event_id', event.id);
  if (updErr) {
    devWarn('[career/billing/webhook] events finalize failed', updErr);
  }

  // 観測用ログ（secret / card / PII は出さない）。
  console.info('[career/billing/webhook] handled', {
    id: event.id,
    type: event.type,
    result: result.kind,
  });

  return Response.json(
    {
      received: true,
      type: event.type,
      handled: result.kind === 'handled',
      ...(result.kind === 'permanent-error' ? { reason: result.message } : {}),
      ...(result.kind === 'ignored' ? { ignored: true } : {}),
    },
    { status: 200 },
  );
}

type DispatchResult =
  | { kind: 'handled' }
  | { kind: 'ignored' }
  | { kind: 'permanent-error'; message: string }
  | { kind: 'transient-error'; message: string };

async function dispatch(input: {
  supabase: SupabaseClient;
  event: Stripe.Event;
}): Promise<DispatchResult> {
  const { supabase, event } = input;
  if (!HANDLED_EVENT_TYPES.has(event.type)) return { kind: 'ignored' };

  try {
    switch (event.type) {
      // 権利の変化はすべてここに集約する。
      //   created  : 契約成立
      //   updated  : plan 変更 / status 遷移 / cancel_at_period_end の予約・解除 /
      //              期間更新（invoice.paid 後もここで period が進む）
      //   deleted  : 契約終了（status=canceled として同期され、grace 判定は
      //              current_period_end に委ねる）
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        // ★ 順序保証（STEP-CAREER-SUBSCRIPTION-SYNC-HARDENING）:
        //   event.data.object は「その event が作られた瞬間」の snapshot。Stripe は
        //   webhook の配送順序を保証しないため、これをそのまま保存すると
        //   遅れて届いた古い event が新しい状態を巻き戻す（active → incomplete）。
        //   そこで event からは **subscription id だけ**を取り、値は Stripe から
        //   取り直した現在の snapshot を保存する。到着順に依存しなくなる。
        //   （deleted も同様。retrieve は canceled を返すので復活しない。）
        const sub = event.data.object as Stripe.Subscription;
        return mapSyncResult(
          await syncCareerSubscriptionById({ admin: supabase, subscriptionId: sub.id }),
        );
      }

      // 決済完了そのものでは権利を与えない（state は subscription.created で同期）。
      // ここでの責務は観測ログのみ。
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        console.info('[career/billing/webhook] checkout.session.completed', {
          id: session.id,
          mode: session.mode,
          subscription:
            typeof session.subscription === 'string' ? session.subscription : null,
        });
        return { kind: 'handled' };
      }

      // 支払い失敗。status の変化（past_due / unpaid）は customer.subscription.updated
      // 経由で同期されるため、ここでは観測ログのみ（受験版と同じ policy）。
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        console.info('[career/billing/webhook] invoice.payment_failed', {
          id: invoice.id,
        });
        return { kind: 'handled' };
      }

      default:
        return { kind: 'ignored' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'handler threw';
    return { kind: 'transient-error', message };
  }
}

function mapSyncResult(
  result: Awaited<ReturnType<typeof syncCareerSubscriptionById>>,
): DispatchResult {
  switch (result.kind) {
    case 'ok':
      return { kind: 'handled' };
    // Stripe 上に無い。**DB 行は消さない**（破壊的処理をしない）。retry しても直らないので
    // 200 で受け切り、error 列と log に残して運用で気付けるようにする。
    case 'stripe-missing':
      return {
        kind: 'permanent-error',
        message: `stripe_missing: subscription ${result.subscriptionId} not found on Stripe`,
      };
    // Stripe API の一時障害。DB は無変更なので Stripe に retry させる。
    case 'stripe-error':
      return {
        kind: 'transient-error',
        message: `stripe_error: could not retrieve subscription ${result.subscriptionId}`,
      };
    // retry しても直らない（設定 / データ側の問題）。200 で受け切り error に記録する。
    case 'no-user-id':
      return {
        kind: 'permanent-error',
        message: `no user_id resolved for customer=${result.customerId} sub=${result.subscriptionId}`,
      };
    case 'unknown-plan':
      // ★ 受験版 Price / 未設定 env の subscription がここに来る。DB は変更されていない。
      return {
        kind: 'permanent-error',
        message: `price ${result.priceId} is not a CAREER plan (sub=${result.subscriptionId})`,
      };
    case 'no-items':
      return {
        kind: 'permanent-error',
        message: `subscription ${result.subscriptionId} has no items`,
      };
    case 'db-error':
      return { kind: 'transient-error', message: result.message };
    default: {
      const _exhaustive: never = result;
      return {
        kind: 'transient-error',
        message: `unhandled sync result: ${String(_exhaustive)}`,
      };
    }
  }
}

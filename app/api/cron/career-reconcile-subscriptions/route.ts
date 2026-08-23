/**
 * PASSAI CAREER — career_subscriptions の日次 reconciliation cron。
 *
 * STEP-CAREER-SUBSCRIPTION-SYNC-HARDENING。
 *
 * 目的:
 *   webhook の取りこぼし（endpoint 障害が Stripe の retry 期間を超えた / DB 一時障害 /
 *   Dashboard 直接操作 / secret 差し替え中の欠落）で
 *   `Stripe truth != career_subscriptions` が残った場合に、それを毎日 1 回検知して修復する。
 *   Stripe を常に「正」とし、career_subscriptions を Stripe に合わせて寄せる。
 *
 * ★ 受験版 `/api/cron/reconcile-subscriptions` とは **完全に別 route**。
 *   あちらは Project A（subscriptions / profiles / lib/supabase/*）を扱う。
 *   本 route は Project B（career_subscriptions / getCareerServiceRoleSupabaseClient）だけを
 *   扱い、Project A の table / client / helper を一切流用しない。
 *
 * 設計方針（既存資産の再利用）:
 *   - 修復の本体は webhook と同じ `syncCareerSubscriptionById` を呼ぶ。
 *     これにより career_subscriptions への書き込み形が webhook と完全に一致し、
 *     二重実装による乖離を避ける（判定は lib/careerBilling/reconcile.ts に集約）。
 *   - status / grace の意味論（entitlementPolicy）は一切変更しない。本 cron が直すのは
 *     entitlement の **入力**（subscription state）だけで、判定ロジックには触れない。
 *
 * 認証:
 *   - `Authorization: Bearer ${CRON_SECRET}` のみ許可。それ以外は 401。
 *   - CRON_SECRET 未設定なら fail-closed で 401（誰も叩けない）。
 *   - Vercel Cron は CRON_SECRET 設定時に自動でこの header を付与する（他 cron と同方式）。
 *   - guest が叩いて subscription status を書き換える経路は存在しない。
 *
 * dry-run:
 *   - `?dryRun=true`（`?dry=1`）で書き込みを一切行わず、検知のみ。
 * 件数上限:
 *   - `?limit=`（既定 200 / 最大 500）。無制限 scan はしない。
 *     上限に達した場合は応答と log に `truncated: true` を出す（silent truncation を作らない）。
 *
 * 非破壊原則:
 *   - career_subscriptions の行を DELETE しない。
 *   - Stripe に存在しない subscription（stripe_missing）でも行を消さず、件数として観測に出す。
 *   - DB → Stripe の push は行わない（方向は Stripe → DB の一方通行）。
 *
 * 必要 env: CRON_SECRET / STRIPE_SECRET_KEY /
 *           NEXT_PUBLIC_CAREER_SUPABASE_URL / CAREER_SUPABASE_SERVICE_ROLE_KEY
 * （新規 env は不要。すべて既存のものを再利用する。）
 */

import 'server-only';

import { NextResponse } from 'next/server';

import { devWarn } from '@/lib/devLog';
import { captureRouteException } from '@/lib/sentry/capture';
import { getCareerServiceRoleSupabaseClient } from '@/lib/careerSupabase/serviceRoleClient';
import {
  buildCareerReconcileDeps,
  reconcileCareerSubscriptions,
  CAREER_RECONCILE_DEFAULT_LIMIT,
} from '@/lib/careerBilling/reconcile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Stripe API を candidate 件数ぶん順に叩くため、cleanup 系より長めに取る。
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail-closed
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

function intParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryParam = url.searchParams.get('dryRun') ?? url.searchParams.get('dry');
  const dryRun = dryParam === 'true' || dryParam === '1';
  const limit = intParam(url, 'limit', CAREER_RECONCILE_DEFAULT_LIMIT);

  try {
    const admin = getCareerServiceRoleSupabaseClient();
    const { summary, error } = await reconcileCareerSubscriptions({
      deps: buildCareerReconcileDeps(admin),
      limit,
      dryRun,
    });

    if (error) {
      // 候補が 1 件も読めない = systemic failure。Stripe / DB の実 message は返さない。
      devWarn('[cron/career-reconcile-subscriptions] candidate select failed');
      return NextResponse.json(
        { ok: false, error: 'reconcile_unavailable' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    captureRouteException(err, {
      route: 'cron/career-reconcile-subscriptions',
      feature: 'billing',
      status: 500,
    });
    devWarn('[cron/career-reconcile-subscriptions] failed');
    return NextResponse.json({ ok: false, error: 'reconcile_failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}

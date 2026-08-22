/*
 * scripts/career-stripe-webhook-endpoint-check.ts
 *
 * PASSAI CAREER — Stripe に登録された webhook endpoint URL の **read-only** 点検。
 *
 * ── なぜ必要か（実際に起きた事故）──────────────────────────────────────
 *   本番の LIVE 決済が成功したにも関わらず、Stripe 側の CAREER webhook endpoint が
 *
 *       https://passai-career.vercel.app/          ← サイトのルート
 *
 *   に登録されており、正しい handler
 *
 *       https://passai-career.vercel.app/api/career/billing/webhook
 *
 *   が **一度も呼ばれていなかった**。結果:
 *     - career_stripe_events / career_subscriptions が 0 行のまま
 *     - entitlement が永久に paid=false
 *     - success ページは 30 秒ポーリングして「反映に時間がかかっています」で終わる
 *   コードは全て正常で、設定だけが誤っているため **コードの QA では検知できない**。
 *   この種の設定ミスを 1 コマンドで可視化するのが本 script の役割。
 *
 * ── 安全性 ──────────────────────────────────────────────────────────────
 *   - 呼ぶのは GET /v1/webhook_endpoints だけ。**write API を一切呼ばない**。
 *   - secret（API key / webhook signing secret）は表示しない。
 *   - 修正は Stripe Dashboard で運用者が行う（本 script は直さない）。
 *
 * 使い方:
 *   STRIPE_SECRET_KEY=... npx tsx scripts/career-stripe-webhook-endpoint-check.ts
 *   （.env.local に STRIPE_SECRET_KEY があればそれを読む）
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** CAREER webhook handler の canonical path（app/api/career/billing/webhook/route.ts）。 */
const CAREER_WEBHOOK_PATH = '/api/career/billing/webhook';

/** handler が実際に扱う event 種別（route.ts の HANDLED_EVENT_TYPES と一致させる）。 */
const EXPECTED_EVENTS = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'checkout.session.completed',
  'invoice.payment_failed',
] as const;

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};

function readSecretKey(): string | null {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY;
  const envPath = join(ROOT, '.env.local');
  if (!existsSync(envPath)) return null;
  const m = readFileSync(envPath, 'utf8').match(
    /^\s*STRIPE_SECRET_KEY\s*=\s*['"]?([^'"\s]+)/m,
  );
  return m?.[1] ?? null;
}

type StripeWebhookEndpoint = {
  url: string;
  status: string;
  livemode: boolean;
  enabled_events: string[];
};

async function main() {
  const key = readSecretKey();
  if (!key) {
    console.log('SKIP — STRIPE_SECRET_KEY が無いため点検できません（設定してから再実行してください）。');
    process.exit(0);
  }

  const res = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=100', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.log(`FAIL — Stripe API 呼び出しに失敗しました（HTTP ${res.status}）。`);
    process.exit(1);
  }
  const body = (await res.json()) as { data?: StripeWebhookEndpoint[] };
  const endpoints = body.data ?? [];

  console.log(`PASSAI CAREER — Stripe webhook endpoint check（登録数: ${endpoints.length}）`);
  console.log('');

  // CAREER 用 endpoint = path が canonical path と一致するもの。
  const career = endpoints.filter((e) => {
    try {
      return new URL(e.url).pathname === CAREER_WEBHOOK_PATH;
    } catch {
      return false;
    }
  });

  check(
    career.length >= 1,
    `CAREER handler（${CAREER_WEBHOOK_PATH}）を指す endpoint が登録されている`,
  );

  if (career.length === 0) {
    console.log('');
    console.log('  → 登録済み endpoint の path 一覧（host は表示、secret は非表示）:');
    for (const e of endpoints) {
      let shown = '(unparsable)';
      try {
        const u = new URL(e.url);
        shown = `${u.host}${u.pathname}`;
      } catch {
        /* ignore */
      }
      console.log(`      ${shown}  [status=${e.status} livemode=${e.livemode}]`);
    }
    console.log('');
    console.log(`  → 対処: Stripe Dashboard → Developers → Webhooks で URL を`);
    console.log(`         https://<本番ホスト>${CAREER_WEBHOOK_PATH} に修正してください。`);
    console.log('         ルート（/）宛のままだと handler が呼ばれず、決済しても');
    console.log('         career_subscriptions が同期されません（paid が永久に false）。');
  }

  for (const e of career) {
    let host = '(unknown)';
    try {
      host = new URL(e.url).host;
    } catch {
      /* ignore */
    }
    check(e.status === 'enabled', `${host}: endpoint が enabled`);
    for (const type of EXPECTED_EVENTS) {
      check(
        e.enabled_events.includes(type) || e.enabled_events.includes('*'),
        `${host}: ${type} を購読している`,
      );
    }
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-stripe-webhook-endpoint-check: ALL PASS'
      : `career-stripe-webhook-endpoint-check: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();

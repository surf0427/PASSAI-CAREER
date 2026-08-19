/*
 * scripts/career-stripe-environment-qa.ts
 *
 * PASSAI CAREER — Stripe の test / live 環境分離ガード（dev-only / 実 Stripe 非接続）。
 *
 * 背景:
 *   旧実装は NODE_ENV だけで key モードを決めていたため、**Vercel Preview
 *   （NODE_ENV=production）に Stripe Test key を入れられなかった**。その結果
 *   「本番へ実課金する前に Preview で E2E を通す」経路が構造的に存在せず、
 *   検証したければ live key を Preview に置くしかない = 事故る設計だった。
 *   VERCEL_ENV を一次情報にする方式へ変更したので、その matrix を固定する。
 *
 * 検証:
 *   [1] 環境 × key モードの許可 matrix（VERCEL_ENV 優先 / NODE_ENV fallback）
 *   [2] エラーメッセージに secret の実値が混ざらないこと
 *   [3] livemode 期待値（Price / webhook event の突き合わせに使う）
 *   [4] 実装側が本 policy を使っていること（静的）
 *   [5] Price / webhook secret の env 分離（受験版と共有しない）
 *
 * ★ 実 Stripe / 実 Supabase 非接続。env 実値を読まない・出力しない。
 * 使い方: npx tsx scripts/career-stripe-environment-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  checkStripeSecretKeyMode,
  expectedStripeLivemode,
  expectedStripeMode,
  resolveStripeRuntimeEnv,
  STRIPE_SECRET_KEY_PREFIX,
  type StripeEnvInput,
} from '../lib/stripe/environment';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

// 形だけの偽 key（実 secret ではない。prefix 判定のみに使う）。
const FAKE_LIVE_KEY = 'sk_live_QAFAKE0000000000';
const FAKE_TEST_KEY = 'sk_test_QAFAKE0000000000';

console.log('PASSAI CAREER — Stripe test/live environment separation QA');
console.log('');

// ═══════════════════════════════════════════════════════════════
// [1] 環境 × key モード matrix
// ═══════════════════════════════════════════════════════════════
console.log('[1] environment x key-mode matrix');
{
  type Row = {
    label: string;
    env: StripeEnvInput;
    expectRuntime: 'production' | 'preview' | 'development';
    liveOk: boolean;
    testOk: boolean;
  };

  const MATRIX: Row[] = [
    // ── Vercel（VERCEL_ENV が一次情報）─────────────────────────
    // Preview / development は NODE_ENV=production でも **test のみ**。これが今回の修正点。
    {
      label: 'Vercel Production (NODE_ENV=production)',
      env: { VERCEL_ENV: 'production', NODE_ENV: 'production' },
      expectRuntime: 'production',
      liveOk: true,
      testOk: false,
    },
    {
      label: 'Vercel Preview (NODE_ENV=production)',
      env: { VERCEL_ENV: 'preview', NODE_ENV: 'production' },
      expectRuntime: 'preview',
      liveOk: false,
      testOk: true,
    },
    {
      label: 'Vercel development / vercel dev',
      env: { VERCEL_ENV: 'development', NODE_ENV: 'development' },
      expectRuntime: 'development',
      liveOk: false,
      testOk: true,
    },
    // ── 非 Vercel（NODE_ENV へ fallback）───────────────────────
    {
      label: 'local dev (no VERCEL_ENV, NODE_ENV=development)',
      env: { VERCEL_ENV: undefined, NODE_ENV: 'development' },
      expectRuntime: 'development',
      liveOk: false,
      testOk: true,
    },
    {
      label: 'local test runner (NODE_ENV=test)',
      env: { VERCEL_ENV: undefined, NODE_ENV: 'test' },
      expectRuntime: 'development',
      liveOk: false,
      testOk: true,
    },
    {
      label: 'non-Vercel production build (NODE_ENV=production)',
      env: { VERCEL_ENV: undefined, NODE_ENV: 'production' },
      expectRuntime: 'production',
      liveOk: true,
      testOk: false,
    },
    // ── 異常値は Vercel 由来として信用せず NODE_ENV へ倒す ────────
    {
      label: 'bogus VERCEL_ENV + NODE_ENV=production',
      env: { VERCEL_ENV: 'staging', NODE_ENV: 'production' },
      expectRuntime: 'production',
      liveOk: true,
      testOk: false,
    },
    {
      label: 'bogus VERCEL_ENV + NODE_ENV=development',
      env: { VERCEL_ENV: 'staging', NODE_ENV: 'development' },
      expectRuntime: 'development',
      liveOk: false,
      testOk: true,
    },
  ];

  for (const row of MATRIX) {
    check(
      resolveStripeRuntimeEnv(row.env) === row.expectRuntime,
      `${row.label} → runtimeEnv=${row.expectRuntime}`,
    );
    const live = checkStripeSecretKeyMode(FAKE_LIVE_KEY, row.env);
    const test = checkStripeSecretKeyMode(FAKE_TEST_KEY, row.env);
    check(live.ok === row.liveOk, `${row.label} + sk_live_ → ${row.liveOk ? 'PASS' : 'reject'}`);
    check(test.ok === row.testOk, `${row.label} + sk_test_ → ${row.testOk ? 'PASS' : 'reject'}`);
    // ★ どの環境でも「両方通る」ことは無い（必ず一方だけ）。
    check(
      live.ok !== test.ok,
      `${row.label}: live と test が同時に許可されない（fail-closed）`,
    );
  }

  // 未設定 / 形式不正はすべて拒否。
  for (const row of MATRIX) {
    check(!checkStripeSecretKeyMode(undefined, row.env).ok, `${row.label}: key 未設定 → reject`);
    check(!checkStripeSecretKeyMode('', row.env).ok, `${row.label}: 空 key → reject`);
    check(
      !checkStripeSecretKeyMode('pk_test_xxx', row.env).ok,
      `${row.label}: publishable key 誤設定 → reject`,
    );
    check(
      !checkStripeSecretKeyMode('rk_live_xxx', row.env).ok,
      `${row.label}: restricted key → reject`,
    );
  }
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [2] エラーメッセージに secret を混ぜない
// ═══════════════════════════════════════════════════════════════
console.log('[2] no secret material leaks into error messages');
{
  const wrongKey = 'sk_live_SUPERSECRETVALUE123';
  const r = checkStripeSecretKeyMode(wrongKey, {
    VERCEL_ENV: 'preview',
    NODE_ENV: 'production',
  });
  check(!r.ok, 'preview + sk_live_ は拒否される');
  if (!r.ok) {
    check(!r.message.includes('SUPERSECRETVALUE123'), 'メッセージに key 実値が含まれない');
    check(!r.message.includes(wrongKey), 'メッセージに key 全体が含まれない');
    check(r.message.includes('sk_test_'), '期待 prefix は示す（運用者が直せる情報は出す）');
    check(r.message.includes('preview'), '実行環境名は示す');
  }
  // 環境判定モジュールは secret を読まない。
  const envSrc = stripComments(read('lib/stripe/environment.ts'));
  check(
    !/process\.env\.STRIPE_SECRET_KEY/.test(envSrc),
    'environment.ts は STRIPE_SECRET_KEY を読まない（key は引数で受け取る）',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [3] livemode 期待値
// ═══════════════════════════════════════════════════════════════
console.log('[3] expected livemode (Price / webhook event の突き合わせ用)');
{
  check(expectedStripeMode('production') === 'live', 'production → live');
  check(expectedStripeMode('preview') === 'test', 'preview → test');
  check(expectedStripeMode('development') === 'test', 'development → test');
  check(expectedStripeLivemode('production') === true, 'production → livemode=true');
  check(expectedStripeLivemode('preview') === false, 'preview → livemode=false');
  check(expectedStripeLivemode('development') === false, 'development → livemode=false');
  check(STRIPE_SECRET_KEY_PREFIX.live === 'sk_live_', 'live prefix = sk_live_');
  check(STRIPE_SECRET_KEY_PREFIX.test === 'sk_test_', 'test prefix = sk_test_');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [4] 実装側が本 policy を使っている（静的）
// ═══════════════════════════════════════════════════════════════
console.log('[4] implementation uses the single policy');
{
  const serverSrc = stripComments(read('lib/stripe/server.ts'));
  check(
    /checkStripeSecretKeyMode\(/.test(serverSrc),
    'lib/stripe/server.ts が checkStripeSecretKeyMode を使う',
  );
  // 旧 NODE_ENV 直判定が残っていないこと（これが Preview を塞いでいた原因）。
  check(
    !/process\.env\.NODE_ENV === 'production'/.test(serverSrc),
    'lib/stripe/server.ts に NODE_ENV の直判定が残っていない',
  );
  check(
    !/sk_live_|sk_test_/.test(serverSrc),
    'lib/stripe/server.ts に prefix リテラルが残っていない（policy へ集約済み）',
  );

  // Price の livemode 突き合わせ。
  const careerStripe = stripComments(read('lib/careerBilling/stripe.ts'));
  check(
    /retrieveCareerPlanPrice/.test(careerStripe),
    'CAREER の Price 取得が livemode 検証つきの関数に集約されている',
  );
  check(
    /price\.livemode !== expectedLivemode/.test(careerStripe),
    'Price の livemode を実行環境の期待値と突き合わせる',
  );
  check(/mode-mismatch/.test(careerStripe), 'モード混線を専用の失敗種別で返す');

  // checkout は livemode 検証済み Price だけを使う。
  const checkout = stripComments(read('app/api/career/billing/checkout/route.ts'));
  check(
    /retrieveCareerPlanPrice\(plan\)/.test(checkout),
    'checkout が livemode 検証つきの Price 取得を使う',
  );
  check(
    !/getCareerStripePriceId\(/.test(checkout),
    'checkout が env の Price ID を直接使わない（検証を迂回しない）',
  );
  check(
    /priceCheck\.kind !== 'ok'/.test(checkout),
    'Price 検証に失敗したら Checkout Session を作らない',
  );
  check(/!priceCheck\.price\.active/.test(checkout), 'アーカイブ済み Price では売らない');

  // webhook は event.livemode を突き合わせる。
  const webhook = stripComments(read('app/api/career/billing/webhook/route.ts'));
  check(
    /event\.livemode !== expectedLivemode/.test(webhook),
    'webhook が event.livemode を実行環境の期待値と突き合わせる',
  );
  const livemodeIdx = webhook.indexOf('event.livemode !== expectedLivemode');
  const dbIdx = webhook.indexOf(".from('career_stripe_events')");
  check(
    livemodeIdx > -1 && (dbIdx === -1 || livemodeIdx < dbIdx),
    'livemode 検証が DB アクセスより前にある（混線 event で DB を汚さない）',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [5] env 分離（受験版と共有しない / 新 env を増やさない）
// ═══════════════════════════════════════════════════════════════
console.log('[5] env separation (CAREER vs exam app)');
{
  const careerStripe = stripComments(read('lib/careerBilling/stripe.ts'));
  const webhook = stripComments(read('app/api/career/billing/webhook/route.ts'));

  // Price env は CAREER 専用名のまま（環境差は Vercel の environment scope で入れ分ける）。
  check(
    /STRIPE_PRICE_ID_CAREER_BASIC/.test(read('lib/careerBilling/plans.ts')),
    'basic の Price env は STRIPE_PRICE_ID_CAREER_BASIC',
  );
  check(
    /STRIPE_PRICE_ID_CAREER_PREMIUM/.test(read('lib/careerBilling/plans.ts')),
    'premium の Price env は STRIPE_PRICE_ID_CAREER_PREMIUM',
  );
  // 環境別の新 env を増やしていないこと（_TEST / _LIVE / _PREVIEW 等）。
  const allBilling = [
    read('lib/careerBilling/plans.ts'),
    read('lib/careerBilling/stripe.ts'),
    read('app/api/career/billing/checkout/route.ts'),
    read('app/api/career/billing/webhook/route.ts'),
  ].join('\n');
  for (const bad of [
    'STRIPE_PRICE_ID_CAREER_BASIC_TEST',
    'STRIPE_PRICE_ID_CAREER_BASIC_LIVE',
    'STRIPE_PRICE_ID_CAREER_PREMIUM_TEST',
    'STRIPE_PRICE_ID_CAREER_PREMIUM_LIVE',
    'STRIPE_SECRET_KEY_TEST',
    'STRIPE_SECRET_KEY_LIVE',
    'CAREER_STRIPE_WEBHOOK_SECRET_TEST',
    'CAREER_STRIPE_WEBHOOK_SECRET_LIVE',
  ]) {
    check(!allBilling.includes(bad), `環境別の重複 env ${bad} を作っていない`);
  }

  // webhook secret は CAREER 専用。受験版と共有しない。
  check(
    /CAREER_STRIPE_WEBHOOK_SECRET/.test(webhook),
    'CAREER webhook は CAREER_STRIPE_WEBHOOK_SECRET を使う',
  );
  check(
    !/(?<!CAREER_)\bSTRIPE_WEBHOOK_SECRET\b/.test(webhook),
    'CAREER webhook が受験版の STRIPE_WEBHOOK_SECRET を参照しない',
  );
  const examWebhook = stripComments(read('app/api/billing/webhook/route.ts'));
  check(
    !/CAREER_STRIPE_WEBHOOK_SECRET/.test(examWebhook),
    '受験版 webhook が CAREER の secret を参照しない',
  );
  // 受験版 Price との取り違え検知が残っていること。
  check(/EXAM_PRICE_ENV_NAMES/.test(careerStripe), '受験版 Price ID の誤設定検知が残っている');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
if (failures === 0) {
  console.log('ALL PASS — Stripe test/live separation is environment-correct.');
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S) — Stripe environment separation broken.`);
  process.exit(1);
}

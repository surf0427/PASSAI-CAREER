/*
 * scripts/career-stripe-observability-qa.ts
 *
 * PASSAI CAREER — Stripe 失敗診断ログの契約 QA（dev-only 常設・決定的）。
 *
 * 背景:
 *   課金経路の Stripe 失敗は `devWarn` で記録されていたが、devWarn は
 *   `NODE_ENV !== 'production'` guard のため **Vercel Preview / Production では
 *   dead code として除去**され、Runtime Logs に何も残らなかった。
 *   その結果 Checkout の 502 を運用側から診断できなかった。
 *
 * 本 QA が固定する 2 点（回帰ガード）:
 *   1. Stripe 失敗 logger が production-like NODE_ENV でも **dead-code されない**
 *      （= devWarn / devLog ではなく console.error を使う）。
 *   2. secret / PII を logger へ渡していない
 *      （message / stack / raw / email / app_user_id / token 等を読まない）。
 *
 *   加えて、課金 chain 上の 4 つの Stripe API 呼び出しがすべて配線されていること。
 *
 * 使い方: npx tsx scripts/career-stripe-observability-qa.ts
 * 終了コード: 全 assert 成功 → 0 / 1 件でも失敗 → 1。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  toSafeStripeFailure,
  type CareerStripeOperation,
} from '@/lib/careerBilling/stripeLog';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fails++;
};
const section = (t: string) => console.log(`\n── ${t} ──`);

console.log('PASSAI CAREER — Stripe failure observability QA');

const LOGGER = 'lib/careerBilling/stripeLog.ts';
const loggerSrc = stripComments(read(LOGGER));

// ════════════════════════════════════════════════════════════════════
section('A. logger は production build で消えない');

check(
  loggerSrc.includes('console.error('),
  'console.error を使う（Runtime Logs に残る）',
);
check(
  !loggerSrc.includes('devWarn') && !loggerSrc.includes('devLog'),
  'devWarn / devLog を使わない（NODE_ENV guard で DCE されない）',
);
check(
  !/process\.env\.NODE_ENV/.test(loggerSrc),
  'logger 自身が NODE_ENV で出力を分岐しない',
);

// ════════════════════════════════════════════════════════════════════
section('B. secret / PII を読まない');

// ★ err から読み出してよいのは allowlist されたフィールドのみ。
for (const banned of [
  'message',
  'stack',
  '.raw',
  'headers',
  'email',
  'app_user_id',
  'access_token',
  'cookie',
  'STRIPE_SECRET_KEY',
  'CAREER_STRIPE_WEBHOOK_SECRET',
]) {
  check(!loggerSrc.includes(banned), `logger が "${banned}" を参照しない`);
}

// console へ渡すのは組み立て済みの安全オブジェクトだけ（err 自体を渡さない）。
check(
  !/console\.error\([^)]*\berr\b/.test(loggerSrc),
  'console.error に err 実体を渡さない（allowlist 済みオブジェクトのみ）',
);

// ════════════════════════════════════════════════════════════════════
section('C. 抽出結果が allowlist に一致する（実挙動）');

const ALLOWED = new Set([
  'operation',
  'name',
  'type',
  'code',
  'statusCode',
  'requestId',
  'param',
]);

// Stripe error を模した、PII と secret を含むオブジェクト。
const fake = {
  name: 'StripeInvalidRequestError',
  type: 'invalid_request_error',
  code: 'parameter_invalid_empty',
  statusCode: 403,
  requestId: 'req_TESTONLY',
  param: 'email',
  // ↓ 以下は絶対に出てはいけない
  message: 'No such customer: user@example.com (sk_test_SECRET)',
  stack: 'Error: at foo (/x.ts:1:1)',
  raw: { secret: 'sk_test_SECRET', email: 'user@example.com' },
  headers: { authorization: 'Bearer sk_test_SECRET' },
};

const safe = toSafeStripeFailure('customers.create', fake);
const keys = Object.keys(safe);

check(
  keys.every((k) => ALLOWED.has(k)),
  `抽出キーが allowlist 内のみ（実際: ${keys.join(', ')}）`,
);

const serialized = JSON.stringify(safe);
for (const leak of [
  'user@example.com',
  'sk_test_SECRET',
  'No such customer',
  '/x.ts',
]) {
  check(!serialized.includes(leak), `出力に "${leak}" が含まれない`);
}

check(safe.statusCode === 403, 'statusCode を保持する（診断に必要）');
check(safe.requestId === 'req_TESTONLY', 'requestId を保持する（Stripe Logs 照合キー）');
check(safe.type === 'invalid_request_error', 'error.type を保持する');
check(safe.code === 'parameter_invalid_empty', 'error.code を保持する');

// never throw（任意の throw 値でも壊れない）。
for (const weird of [null, undefined, 'boom', 42, {}]) {
  const r = toSafeStripeFailure('prices.retrieve', weird);
  check(r.operation === 'prices.retrieve', `異常な throw 値でも壊れない: ${String(weird)}`);
}

// ════════════════════════════════════════════════════════════════════
section('D. 課金 chain の Stripe 呼び出しが全て配線されている');

const SITES: Array<{ file: string; op: CareerStripeOperation; call: string }> = [
  { file: 'lib/careerBilling/stripe.ts', op: 'prices.retrieve', call: 'prices.retrieve(' },
  { file: 'lib/careerBilling/customer.ts', op: 'customers.create', call: 'customers.create(' },
  {
    file: 'app/api/career/billing/checkout/route.ts',
    op: 'checkout.sessions.create',
    call: 'checkout.sessions.create(',
  },
  {
    file: 'app/api/career/billing/portal/route.ts',
    op: 'billingPortal.sessions.create',
    call: 'billingPortal.sessions.create(',
  },
];

for (const s of SITES) {
  const src = stripComments(read(s.file));
  check(src.includes(s.call), `${s.file}: ${s.call} を呼んでいる`);
  check(
    src.includes(`logCareerStripeFailure('${s.op}'`),
    `${s.file}: 失敗時に logCareerStripeFailure('${s.op}') を呼ぶ`,
  );
}

// ★ 空 catch（診断不能）が Stripe 呼び出しに残っていないこと。
check(
  !/\}\s*catch\s*\{\s*return\s*\{\s*kind:\s*'not-found'/.test(
    stripComments(read('lib/careerBilling/stripe.ts')),
  ),
  'prices.retrieve の catch が空でない（権限エラーを not-found に潰さない）',
);

// ════════════════════════════════════════════════════════════════════
section('E. client への response contract は不変');

const checkoutSrc = read('app/api/career/billing/checkout/route.ts');
const portalSrc = read('app/api/career/billing/portal/route.ts');

check(
  checkoutSrc.includes("jsonError(\n      'STRIPE_ERROR'") ||
    checkoutSrc.includes("'STRIPE_ERROR'"),
  'checkout: STRIPE_ERROR の汎用文言を維持',
);
check(
  !/Response\.json\([^)]*err\b/.test(stripComments(checkoutSrc)),
  'checkout: Stripe の生エラーを client に返さない',
);
check(
  !/Response\.json\([^)]*err\b/.test(stripComments(portalSrc)),
  'portal: Stripe の生エラーを client に返さない',
);
check(
  portalSrc.includes("'NO_CUSTOMER'") && portalSrc.includes("'STRIPE_ERROR'"),
  'portal: 既存のエラーコード（NO_CUSTOMER / STRIPE_ERROR）を維持',
);

// ════════════════════════════════════════════════════════════════════
console.log(
  fails === 0
    ? '\nALL PASS — Stripe failures are diagnosable in production without leaking secrets or PII.'
    : `\n${fails} FAIL`,
);
process.exit(fails === 0 ? 0 : 1);

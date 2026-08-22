/*
 * scripts/career-e2e-discount-qa.ts
 *
 * PASSAI CAREER — LIVE E2E 専用割引の QA（dev-only / 実 Stripe・実 DB 非接続）。
 *
 * 検証:
 *   [1] 適用判定（純粋関数）: E2E user のみ適用 / 非 E2E は不適用 / env 未設定は完全 no-op
 *   [2] fail-closed: E2E user なのに coupon env が無い → misconfigured（通常価格へ倒さない）
 *   [3] Coupon 検証: livemode / valid / duration / amount / currency / 割引超過
 *   [4] checkout route の security 契約: client から coupon / price / plan を受け取らない
 *   [5] 通常ユーザーの価格が不変であること（discounts は E2E 分岐でしか付かない）
 *   [6] server-only / NEXT_PUBLIC_* に漏れていないこと
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-e2e-discount-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  checkCareerE2eCoupon,
  resolveCareerE2eDiscount,
} from '../lib/careerBilling/e2eDiscount';

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

const E2E_ID = 'e2e-user-id-0000';
const E2E_MAIL = 'surf6589+career-e2e@gmail.com';
const FULL_ENV = {
  CAREER_E2E_USER_ID: E2E_ID,
  CAREER_E2E_USER_EMAIL: E2E_MAIL,
  CAREER_E2E_COUPON_ID: 'PyroKVMM',
};

console.log('[1] 適用判定');
{
  const d = resolveCareerE2eDiscount({ userId: E2E_ID, email: E2E_MAIL }, FULL_ENV);
  check(d.kind === 'apply' && d.couponId === 'PyroKVMM', '1. E2E user → coupon 適用');

  // 大文字小文字は無視する（Supabase の email は小文字化されうる）。
  const dUp = resolveCareerE2eDiscount({ userId: E2E_ID, email: E2E_MAIL.toUpperCase() }, FULL_ENV);
  check(dUp.kind === 'apply', '   email の大小文字差は許容');

  check(
    resolveCareerE2eDiscount({ userId: 'other-user', email: E2E_MAIL }, FULL_ENV).kind === 'none',
    '2. 非 E2E user（id 不一致・email 一致）→ 不適用',
  );
  check(
    resolveCareerE2eDiscount({ userId: E2E_ID, email: 'attacker@example.com' }, FULL_ENV).kind === 'none',
    '   id 一致・email 不一致 → 不適用（両方一致が必須）',
  );
  check(
    resolveCareerE2eDiscount({ userId: E2E_ID, email: null }, FULL_ENV).kind === 'none',
    '   email 不明 → 不適用',
  );
  // env 未設定 = 通常運用。誰も E2E にならない。
  check(
    resolveCareerE2eDiscount({ userId: E2E_ID, email: E2E_MAIL }, {}).kind === 'none',
    '   env 未設定の環境では完全に no-op（通常ユーザーの価格に影響しない）',
  );
  check(
    resolveCareerE2eDiscount({ userId: E2E_ID, email: E2E_MAIL }, { CAREER_E2E_USER_ID: E2E_ID }).kind === 'none',
    '   identity env が片方だけなら no-op',
  );
}
console.log('');

console.log('[2] fail-closed（7. coupon 設定欠落）');
{
  const d = resolveCareerE2eDiscount(
    { userId: E2E_ID, email: E2E_MAIL },
    { CAREER_E2E_USER_ID: E2E_ID, CAREER_E2E_USER_EMAIL: E2E_MAIL },
  );
  check(d.kind === 'misconfigured', '7. E2E user + coupon env 欠落 → misconfigured');
  check(d.kind === 'misconfigured' && d.reason === 'coupon-env-missing', '   理由が特定できる');
  const route = stripComments(read('app/api/career/billing/checkout/route.ts'));
  check(
    /e2e\.kind === 'misconfigured'[\s\S]{0,220}return jsonError\(/.test(route),
    '   route は misconfigured で Checkout を作らず失敗する（通常価格へ倒さない）',
  );
}
console.log('');

console.log('[3] Coupon 検証');
{
  const price = { currency: 'jpy', unit_amount: 3000 } as never;
  const base = {
    livemode: true, valid: true, duration: 'once', amount_off: 2800, currency: 'jpy',
  } as never;
  const okRes = checkCareerE2eCoupon(base, price, true);
  check(okRes.kind === 'ok', '正常な coupon は ok');
  check(okRes.kind === 'ok' && okRes.amountOff === 2800, '9. coupon amount 2800');
  check(okRes.kind === 'ok' && okRes.expectedInitialAmount === 200, '10. 初回請求予定額 = 200');

  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ livemode: false }, 'livemode-mismatch', 'test mode の coupon を拒否'],
    [{ valid: false }, 'not-valid', '無効 coupon を拒否'],
    [{ duration: 'forever' }, 'duration-not-once', 'once 以外の duration を拒否'],
    [{ amount_off: null }, 'amount-off-missing', 'percent_off 型を拒否'],
    [{ currency: 'usd' }, 'currency-mismatch', '通貨不一致を拒否'],
    [{ amount_off: 3000 }, 'discount-exceeds-price', '割引が価格以上（0 円）を拒否'],
    [{ amount_off: 4000 }, 'discount-exceeds-price', '割引が価格超過を拒否'],
  ];
  for (const [over, reason, label] of cases) {
    const r = checkCareerE2eCoupon({ ...(base as object), ...over } as never, price, true);
    check(r.kind === 'invalid' && r.reason === reason, `   ${label}`);
  }
}
console.log('');

console.log('[4] checkout route の security 契約');
{
  const route = stripComments(read('app/api/career/billing/checkout/route.ts'));
  check(!/req\.json\(\)/.test(route), '3/4/5/6. body を読まない（coupon / price / plan を client から受け取れない）');
  for (const forbidden of ['coupon', 'couponId', 'discount', 'price', 'priceId', 'plan']) {
    check(
      !new RegExp(`body[^\\n]*\\b${forbidden}\\b`, 'i').test(route),
      `   body.${forbidden} を参照しない`,
    );
  }
  check(
    /resolveCareerE2eDiscountFromEnv\(\{ userId, email \}\)/.test(route),
    '   適用判定には server session の userId / email のみを渡す',
  );
  check(
    /coupons\.retrieve\(e2e\.couponId\)/.test(route) && /checkCareerE2eCoupon\(/.test(route),
    '   coupon は Stripe から取得して検証してから使う',
  );
  check(
    /total !== e2eApplied\.expectedInitialAmount/.test(route),
    '   期待額と違う Session の URL は返さない',
  );
}
console.log('');

console.log('[5] 通常ユーザーの非退行');
{
  const route = stripComments(read('app/api/career/billing/checkout/route.ts'));
  check(
    /e2eApplied\s*\n?\s*\?\s*\{ discounts:/.test(route.replace(/\s+/g, ' ')) ||
      /e2eApplied[\s\S]{0,80}discounts:/.test(route),
    '8. discounts は E2E 分岐でしか付かない',
  );
  check(
    /allow_promotion_codes: true/.test(route),
    '   通常ユーザーの Checkout 設定（allow_promotion_codes）は従来どおり',
  );
  check(
    /retrieveCareerPrice\(\)/.test(route) && !/STRIPE_PRICE_ID_CAREER_(BASIC|PREMIUM)/.test(route),
    '   canonical Price の解決経路は不変（単一 Price のまま）',
  );
  const limits = read('lib/careerQuota/limits.ts');
  check(/self_analysis: 10/.test(limits) && /interview: 8/.test(limits), '   quota 上限は不変');
}
console.log('');

console.log('[5b] 診断フィールド（Session を作らず env 有効性を確認）');
{
  const status = stripComments(read('app/api/career/billing/status/route.ts'));
  check(/resolveCareerE2eDiscountFromEnv\(/.test(status), 'status は E2E 判定の種別を返す');
  check(/\)\.kind,/.test(status), '返すのは kind のみ');
  check(
    !/couponId|amountOff|expectedInitialAmount|CAREER_E2E_COUPON_ID/.test(status),
    'coupon ID / 金額など値は返さない',
  );
  check(/entitlement\.userId/.test(status) && /entitlement\.email/.test(status), '判定材料は server 解決の identity');
}
console.log('');

console.log('[6] server-only / client 露出なし');
{
  const mod = read('lib/careerBilling/e2eDiscount.ts');
  check(/import 'server-only';/.test(mod), 'e2eDiscount は server-only');
  // 実コード（コメントを除く）に NEXT_PUBLIC_ が無いこと。doc で言及するのは可。
  check(!/NEXT_PUBLIC_/.test(stripComments(mod)), 'NEXT_PUBLIC_* を実コードで使わない');
  check(
    !/PyroKVMM/.test(stripComments(mod)) &&
      !/PyroKVMM/.test(stripComments(read('app/api/career/billing/checkout/route.ts'))),
    'coupon ID を実コードへ hard-code していない（env 経由）',
  );
  // client bundle から参照されないこと。
  const clientFiles = ['app/career/components/CareerCheckoutButton.tsx', 'app/career/billing/page.tsx'];
  for (const f of clientFiles) {
    check(!/e2eDiscount|CAREER_E2E_/.test(read(f)), `${f} は E2E 割引を参照しない`);
  }
}
console.log('');

if (failures === 0) {
  console.log('ALL PASS — CAREER E2E discount contracts hold.');
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S) — CAREER E2E discount contracts violated.`);
  process.exit(1);
}

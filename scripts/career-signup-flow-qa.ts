/*
 * scripts/career-signup-flow-qa.ts
 *
 * PASSAI CAREER — 新規登録 / ログイン / 決済 / 基本情報 の導線 QA（dev-only / 静的 + unit）。
 *
 * 守りたい不変条件:
 *   [1] 状態 → 遷移先の判定が 1 箇所（lib/careerRouting/destination.ts）に閉じている。
 *   [2] 「始める」= 新規獲得導線（料金が先）、「ログイン」= 既存復帰導線。混ぜない。
 *   [3] 料金の権威は server（Stripe Price）。client hard-code を billing の正本にしない。
 *   [4] 基本情報 / Home は server-side guard を持ち、未認証・未契約では突破できない。
 *   [5] 判定不能（DB 未適用 / service_role 未設定 / DB エラー）は fail-closed。
 *   [6] Checkout の入力は server だけが決める（price / plan / coupon / amount を client から取らない）。
 *   [7] success_url への到達・session_id・localStorage は権利の根拠にならない（webhook race 含む）。
 *   [8] 既存資産を重複させていない（料金ページ / checkout API / 基本情報 / profile DB は 1 つ）。
 *
 * ★ 実 Supabase / 実 Stripe に接続しない。ネットワーク不使用。secret 非表示。
 * 使い方: npx tsx scripts/career-signup-flow-qa.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAREER_ROUTES,
  isCareerBasicInfoComplete,
  resolveCareerGuardRedirect,
  resolveCareerStartDestination,
  type CareerAccessState,
} from '../lib/careerRouting/destination';
import { CAREER_LOGIN_PATH, CAREER_START_PATH } from '../lib/careerLandingRoutes';
import {
  DEFAULT_CAREER_REDIRECT,
  sanitizeCareerRedirect,
} from '../app/career/login/careerLoginRedirect';
import type { CareerProfile } from '../types/careerProfile';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** 行コメント / ブロックコメントを除いた実コードだけを検査対象にする。 */
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

console.log('PASSAI CAREER — signup / login / checkout / onboarding flow QA');
console.log('');

// ═══════════════════════════════════════════════════════════════
// [1] state → destination の判定（純関数・単一の出所）
// ═══════════════════════════════════════════════════════════════
console.log('[1] state resolver（優先順位: 未認証 → 未契約 → 基本情報 → Home）');
{
  const GUEST: CareerAccessState = { kind: 'guest' };
  const UNPAID: CareerAccessState = { kind: 'unpaid' };
  const UNAVAILABLE: CareerAccessState = { kind: 'unavailable' };
  const PAID_NEW: CareerAccessState = { kind: 'paid', basicInfoComplete: false };
  const PAID_DONE: CareerAccessState = { kind: 'paid', basicInfoComplete: true };

  // 「始める」/ ログイン直後の着地。
  check(resolveCareerStartDestination(GUEST) === CAREER_ROUTES.pricing, '未認証 → 料金');
  check(resolveCareerStartDestination(UNPAID) === CAREER_ROUTES.pricing, '未契約 → 料金');
  check(resolveCareerStartDestination(UNAVAILABLE) === CAREER_ROUTES.pricing, '判定不能 → 料金（fail-closed）');
  check(resolveCareerStartDestination(PAID_NEW) === CAREER_ROUTES.basicInfo, '契約あり + 基本情報未完 → 基本情報');
  check(resolveCareerStartDestination(PAID_DONE) === CAREER_ROUTES.home, '契約あり + 基本情報完了 → Home');
  // 新規ユーザーをいきなりログイン画面へ送らない（料金が先）。
  check(
    resolveCareerStartDestination(GUEST) !== CAREER_ROUTES.login,
    '未認証の「始める」がログイン画面へ直行しない',
  );

  // 有料ページの guard。null = 描画可。
  check(
    resolveCareerGuardRedirect(GUEST, CAREER_ROUTES.basicInfo) ===
      `${CAREER_ROUTES.login}?redirect=${encodeURIComponent(CAREER_ROUTES.basicInfo)}`,
    'guard: 未認証 → login（戻り先を encodeURIComponent 済みで引き継ぐ）',
  );
  check(resolveCareerGuardRedirect(UNPAID, CAREER_ROUTES.basicInfo) === CAREER_ROUTES.pricing, 'guard: 未契約 → 料金');
  check(
    resolveCareerGuardRedirect(UNAVAILABLE, CAREER_ROUTES.basicInfo) === CAREER_ROUTES.pricing,
    'guard: 判定不能 → 料金（fail-closed。通さない）',
  );
  check(resolveCareerGuardRedirect(PAID_NEW, CAREER_ROUTES.basicInfo) === null, 'guard: 契約あり → 基本情報を許可');
  check(resolveCareerGuardRedirect(PAID_DONE, CAREER_ROUTES.home) === null, 'guard: 契約あり → Home を許可');
  // paid 以外は例外なく追い出される（新しい state を足したときの取りこぼし防止）。
  for (const state of [GUEST, UNPAID, UNAVAILABLE]) {
    check(
      resolveCareerGuardRedirect(state, CAREER_ROUTES.home) !== null,
      `guard: ${state.kind} は Home を描画できない`,
    );
  }

  // 基本情報の完了判定（ProfileClient の必須項目と同一）。
  const full = {
    name: 'ニックネーム',
    grade: '3年',
    graduationYear: '2027年卒',
    preferences: [{ university: 'A大学', faculty: 'B学部', department: '' }],
  } as unknown as CareerProfile;
  check(isCareerBasicInfoComplete(full), '必須 5 項目が揃っていれば完了');
  check(!isCareerBasicInfoComplete(null), '未保存は未完了');
  for (const missing of ['name', 'grade', 'graduationYear'] as const) {
    const partial = { ...full, [missing]: '' } as CareerProfile;
    check(!isCareerBasicInfoComplete(partial), `${missing} が空なら未完了`);
  }
  const noUniv = {
    ...full,
    preferences: [{ university: '', faculty: 'B学部', department: '' }],
  } as unknown as CareerProfile;
  check(!isCareerBasicInfoComplete(noUniv), '大学が空なら未完了');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [2] 新規導線と既存導線の分離
// ═══════════════════════════════════════════════════════════════
console.log('[2] 「始める」= 新規獲得 / 「ログイン」= 既存復帰');
{
  // literal 型どうしの比較を型レベルで潰さないよう string へ widen して見る。
  const startPath: string = CAREER_START_PATH;
  const loginPath: string = CAREER_LOGIN_PATH;
  check(startPath !== loginPath, 'LP の 2 ボタンが同じ画面へ飛ばない');
  check(CAREER_START_PATH === CAREER_ROUTES.start, '「始める」は状態解決 dispatcher');
  check(CAREER_LOGIN_PATH === CAREER_ROUTES.login, '「ログイン」は既存ログイン画面');
  check(DEFAULT_CAREER_REDIRECT === CAREER_ROUTES.start, 'ログイン既定着地も dispatcher（状態で分岐）');

  // 認証画面は redirect の戻り先になれない（self-redirect ループ源）。
  for (const p of [CAREER_ROUTES.login, CAREER_ROUTES.register]) {
    check(sanitizeCareerRedirect(p) === DEFAULT_CAREER_REDIRECT, `${p} は redirect 先にならない`);
  }
  // 新規導線で使う戻り先は素通しされる（checkout 自動再開）。
  check(
    sanitizeCareerRedirect('/career/billing?checkout=1') === '/career/billing?checkout=1',
    'checkout 再開の戻り先は CAREER 相対 path として通る',
  );
  // 外部 URL は構造上入り込めない。
  check(
    sanitizeCareerRedirect('https://evil.example/career/billing') === DEFAULT_CAREER_REDIRECT,
    '外部 URL の戻り先は拒否（open redirect 防止）',
  );

  // 認証実装は 1 つだけ（パスワード認証 / 別 auth system を作らない）。
  const OTP_FORM = 'app/career/components/CareerEmailOtpForm.tsx';
  check(existsSync(join(ROOT, OTP_FORM)), 'OTP フォームの共有実装が存在する');
  const form = codeOf(read(OTP_FORM));
  check(/sendCareerEmailOtp/.test(form) && /verifyCareerEmailOtp/.test(form), '既存の email OTP を再利用している');
  check(!/password|signInWithPassword/i.test(form), 'パスワード認証を新設していない');
  const register = codeOf(read('app/career/register/page.tsx'));
  check(/CareerEmailOtpForm/.test(register) && /mode="register"/.test(register), '登録ページは共有フォームの mode 違い');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [3] 料金画面（Stripe が価格の正本 / fail-closed）
// ═══════════════════════════════════════════════════════════════
console.log('[3] pricing page: Stripe が価格の正本・失敗時は売らない');
{
  const src = codeOf(read('app/career/billing/page.tsx'));
  check(/getCareerPlanOffer\(\)/.test(src), '金額は Stripe Price から取得する');
  check(/isCareerBillingConfigured\(\)/.test(src), 'Price env 未設定なら Stripe を呼ばない（fail-closed）');
  // 価格を実装側で創作しない（金額リテラルを持たない）。
  check(!/[¥￥]\s*\d/.test(src) && !/\b3000\b|\b3,000\b/.test(src), '金額の hard-code が無い');
  check(!/STRIPE_CAREER_PRICE_ID|price_[A-Za-z0-9]/.test(src), 'Price ID を client 描画側に持たない');
  // offer が取れない場合、CTA そのものが描画されない構造であること。
  check(/\{offer &&/.test(src), 'offer が無ければプランカード（CTA 含む）ごと描画しない');
  check(/このプランで始める/.test(src), 'CTA 文言「このプランで始める」');
  check(/利用できる主要機能/.test(src), '主要機能の提示がある');

  // 既契約者に申し込み CTA を出さない（二重 Subscription 防止の一次防御）。
  check(/resolveCareerAccessState\(\)/.test(src), '契約状態を server resolver で判定する');
  check(/subscribed \?/.test(src), '契約中は申し込み CTA を出さず別導線にする');
  check(/利用中/.test(src), '契約中は「利用中」を表示する');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [4] server-side route guard（URL 直打ちで突破できない）
// ═══════════════════════════════════════════════════════════════
console.log('[4] 基本情報 / Home の server guard');
{
  for (const rel of ['app/career/profile/page.tsx', 'app/career/home/page.tsx']) {
    const src = codeOf(read(rel));
    check(!/^\s*['"]use client['"]/m.test(src), `${rel} は server component（client で guard しない）`);
    check(/resolveCareerAccessState\(\)/.test(src), `${rel} は server の状態 resolver を使う`);
    check(/resolveCareerGuardRedirect\(/.test(src), `${rel} は共通 guard 判定を使う（条件式をコピペしない`);
    check(/redirect\(away\)/.test(src), `${rel} は許可されない状態で redirect する`);
    check(/dynamic = 'force-dynamic'/.test(src), `${rel} はキャッシュしない（session を必ず読む）`);
    // 権利の根拠に client 由来の材料を使わない。
    check(
      !/searchParams|session_id|localStorage|success/.test(src),
      `${rel} は query / session_id / localStorage を権利判定に使わない`,
    );
  }
  // 判定は必ず既存の central resolver 経由（career_subscriptions を直接読まない）。
  const serverState = codeOf(read('lib/careerRouting/serverState.ts'));
  check(/resolveCareerEntitlement\(\)/.test(serverState), 'entitlement は central resolver に委譲する');
  check(!/career_subscriptions/.test(serverState), 'career_subscriptions を直接 SELECT しない');
  check(/'server-only'/.test(serverState), 'server-only 境界を宣言している');
  check(!/ServiceRole|service_role/.test(serverState), '基本情報 mirror の読み出しに service_role を使わない（RLS に守らせる）');
  // 401/403 以外（=判定不能）を guest ではなく unavailable に倒す＝fail-closed。
  check(
    /status === 401 \|\| status === 403/.test(serverState) && /kind: 'unavailable'/.test(serverState),
    '判定不能を unavailable（契約なし側）に倒す',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [5] 支払いの security 境界（client の主張を受け取らない）
// ═══════════════════════════════════════════════════════════════
console.log('[5] payment security: canonical price は server 決定');
{
  const route = codeOf(read('app/api/career/billing/checkout/route.ts'));
  check(!/req\.json\(\)|await req\.text\(\)|body/.test(route.replace(/body: なし|body を一切読まない/g, '')),
    'checkout API は request body を読まない');
  check(/authenticateCareerMember\(\)/.test(route), 'identity は server session のみ');
  check(/retrieveCareerPrice\(\)/.test(route), 'Price は server が env から解決する');
  check(/ALREADY_SUBSCRIBED/.test(route), '既契約は 409（二重 Subscription を server が拒否）');
  check(/LOGIN_REQUIRED/.test(read('lib/careerBilling/entitlement.ts')), '未認証は LOGIN_REQUIRED（401）');

  const btn = codeOf(read('app/career/components/CareerCheckoutButton.tsx'));
  for (const forbidden of ['priceId', 'price_', 'plan:', 'coupon', 'discount', 'amount', 'currency']) {
    check(!btn.includes(forbidden), `CTA は ${forbidden} を送らない`);
  }
  check(!/JSON\.stringify/.test(btn) && !/\bbody:/.test(btn), 'CTA は checkout に body を送らない');
  check(
    new RegExp(`CAREER_ROUTES\\.register`).test(btn),
    '未ログインの申し込みは登録画面へ（canonical 定数経由）',
  );

  // E2E 割引ロジックを今回の変更で壊していない（削除禁止領域）。
  check(/resolveCareerE2eDiscountFromEnv/.test(route), 'E2E discount の適用判定が残っている');
  check(/checkCareerE2eCoupon/.test(route), 'E2E coupon の検証が残っている');
  const e2e = codeOf(read('lib/careerBilling/e2eDiscount.ts'));
  for (const env of ['CAREER_E2E_USER_ID', 'CAREER_E2E_USER_EMAIL', 'CAREER_E2E_COUPON_ID']) {
    check(e2e.includes(env), `${env} を参照する経路が残っている`);
  }
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [6] webhook race: success 到達 ≠ 権利
// ═══════════════════════════════════════════════════════════════
console.log('[6] webhook race（redirect と署名付き webhook の前後関係）');
{
  const src = codeOf(read('app/career/billing/success/page.tsx'));
  check(/\/api\/career\/billing\/status/.test(src), 'success は server 判定 API を読む');
  check(/data\.paid === true/.test(src), 'paid=true になって初めて先へ進める');
  check(/MAX_ATTEMPTS/.test(src) && /attemptsRef\.current >= MAX_ATTEMPTS/.test(src), 'ポーリングは有限（永久 poll 禁止）');
  check(/setPhase\('pending'\)/.test(src), 'timeout は「失敗」ではなく recoverable な状態にする');
  check(!/method:\s*'POST'/.test(src), 'success は書き込みを行わない');
  check(!/session_id/.test(src), 'session_id を判定に使わない');

  // paid=false の間は基本情報にも Home にも進めない（純関数側の保証）。
  for (const state of [
    { kind: 'unpaid' } as CareerAccessState,
    { kind: 'unavailable' } as CareerAccessState,
    { kind: 'guest' } as CareerAccessState,
  ]) {
    const dest = resolveCareerStartDestination(state);
    check(
      dest !== CAREER_ROUTES.basicInfo && dest !== CAREER_ROUTES.home,
      `paid 未確定（${state.kind}）では基本情報 / Home へ進めない`,
    );
  }
  // 反映後（paid=true）に初めて基本情報へ進む。webhook が遅れて届いた場合の遷移。
  const raceTimeline: CareerAccessState[] = [
    { kind: 'unpaid' },
    { kind: 'unpaid' },
    { kind: 'paid', basicInfoComplete: false },
  ];
  const path = raceTimeline.map(resolveCareerStartDestination);
  check(
    path[0] === CAREER_ROUTES.pricing &&
      path[1] === CAREER_ROUTES.pricing &&
      path[2] === CAREER_ROUTES.basicInfo,
    'paid=false → false → true の順で初めて基本情報へ到達する',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [7] 既存資産の重複が無い
// ═══════════════════════════════════════════════════════════════
console.log('[7] 重複作成が無い（料金 / checkout / 基本情報 / profile DB）');
{
  const walk = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
    }
    return out;
  };

  // Checkout Session を作るのは 1 route だけ。
  const careerFiles = walk(join(ROOT, 'app/api/career'));
  const creators = careerFiles.filter((f) => /checkout\.sessions\.create/.test(readFileSync(f, 'utf8')));
  check(creators.length === 1, `Checkout Session を作る route は 1 つだけ（実際: ${creators.length}）`);
  check(
    creators[0]?.endsWith(join('billing', 'checkout', 'route.ts')) === true,
    'canonical entry point は POST /api/career/billing/checkout',
  );

  // 基本情報入力フォームは既存の 1 実装だけ（同じ目的の onboarding 画面を重複作成しない）。
  const careerPages = walk(join(ROOT, 'app/career'));
  const storageOwners = careerPages.filter((f) =>
    /STORAGE_KEY = 'careerBasicFormData'/.test(codeOf(readFileSync(f, 'utf8'))),
  );
  check(
    storageOwners.length === 1 && storageOwners[0].endsWith(join('profile', 'profileStorage.ts')),
    `基本情報 canonical storage の所有者は 1 module だけ（実際: ${storageOwners.length}）`,
  );
  const basicFormPages = careerPages.filter((f) => /基本情報入力/.test(readFileSync(f, 'utf8')) && /<form/.test(readFileSync(f, 'utf8')));
  check(
    basicFormPages.length === 1 && /profile/.test(basicFormPages[0] ?? ''),
    `基本情報の入力フォームは 1 画面だけ（実際: ${basicFormPages.length}）`,
  );
  check(
    codeOf(read('app/career/profile/page.tsx')).includes('ProfileClient'),
    '既存の基本情報入力コンポーネントを再利用している',
  );

  // profile の保存先は既存 Data Spine のまま（新しい table を作らない）。
  const spine = read('lib/careerSourceData/types.ts');
  check(/profile: 'career_profiles'/.test(spine), '基本情報の mirror は既存 career_profiles のまま');
}
console.log('');

console.log(
  failures === 0
    ? 'career-signup-flow-qa: ALL PASS'
    : `career-signup-flow-qa: ${failures} FAIL`,
);
process.exit(failures === 0 ? 0 : 1);

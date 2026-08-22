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
/** dir 配下の .ts/.tsx を再帰収集する（複数ブロックで使う）。 */
const walkTs = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
};
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
  check(resolveCareerStartDestination(GUEST) === CAREER_ROUTES.pricing, '未認証 → 公開 Pricing');
  check(resolveCareerStartDestination(UNPAID) === CAREER_ROUTES.pricing, '未契約 → 公開 Pricing');
  check(resolveCareerStartDestination(UNAVAILABLE) === CAREER_ROUTES.pricing, '判定不能 → 公開 Pricing（fail-closed）');
  // ★ 受験版が「未課金は必ず /pricing」なのと同じ。契約管理ページへは送らない。
  check(CAREER_ROUTES.pricing === '/career/pricing', 'Pricing は /career/pricing');
  check(CAREER_ROUTES.billing === '/career/billing', 'Billing 管理は /career/billing（別 route）');
  for (const state of [GUEST, UNPAID, UNAVAILABLE]) {
    check(
      resolveCareerStartDestination(state) !== CAREER_ROUTES.billing,
      `${state.kind} を契約管理ページへ送らない`,
    );
  }
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
  check(resolveCareerGuardRedirect(UNPAID, CAREER_ROUTES.basicInfo) === CAREER_ROUTES.pricing, 'guard: 未契約 → Pricing');
  check(
    resolveCareerGuardRedirect(UNAVAILABLE, CAREER_ROUTES.basicInfo) === CAREER_ROUTES.pricing,
    'guard: 判定不能 → Pricing（fail-closed。通さない）',
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
  check(CAREER_START_PATH === CAREER_ROUTES.pricing, '「始める」は公開 Pricing（新規獲得）');
  check(startPath !== CAREER_ROUTES.billing, '「始める」は契約管理ページではない');
  check(CAREER_LOGIN_PATH === CAREER_ROUTES.login, '「ログイン」は既存ログイン画面');
  check(DEFAULT_CAREER_REDIRECT === CAREER_ROUTES.start, 'ログイン既定着地も dispatcher（状態で分岐）');

  // 認証画面は redirect の戻り先になれない（self-redirect ループ源）。
  for (const p of [CAREER_ROUTES.login, CAREER_ROUTES.register]) {
    check(sanitizeCareerRedirect(p) === DEFAULT_CAREER_REDIRECT, `${p} は redirect 先にならない`);
  }
  // 新規導線で使う戻り先は素通しされる（checkout 自動再開）。
  for (const resume of ['/career/pricing?checkout=1', '/career/billing?checkout=1']) {
    check(
      sanitizeCareerRedirect(resume) === resume,
      `checkout 再開の戻り先 ${resume} は CAREER 相対 path として通る`,
    );
  }
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
console.log('[3] 公開 Pricing（買う前）と契約管理（買った後）の分離');
{
  const pricing = codeOf(read('app/career/pricing/page.tsx'));
  const display = codeOf(read('app/career/pricing/pricingDisplay.ts'));

  // --- 新規ユーザーに必ず見せるもの（受験版 /pricing と同じ「購入前 UI」）---
  check(/料金プラン/.test(pricing), 'Pricing に見出し「料金プラン」がある');
  check(/CAREER_PRICING_PRODUCT_NAME/.test(pricing), '商品名を表示する');
  check(display.includes('PASSAI CAREER'), '商品名は PASSAI CAREER');
  check(display.includes("'¥3,000'"), '表示価格 ¥3,000 の定数がある');
  check(display.includes("'/ 月'"), '請求間隔「/ 月」の定数がある');
  check(/決済する/.test(pricing), 'CTA 文言は「決済する」');
  check(!/このプランで始める/.test(pricing), '旧 CTA 文言が残っていない');
  for (const feature of ['自己分析', '企業分析', 'ES', '面接', 'プレゼン', 'GD', '企業マッチング']) {
    check(display.includes(`'${feature}'`), `主要機能「${feature}」を表示する`);
  }

  // --- Pricing に出してはいけないもの（契約者向け UI）---
  check(!/マイページ/.test(pricing), 'Pricing に「マイページ」を出さない');
  // 契約者向けの「操作 UI / 導線」を出さないことを見る。
  // （「いつでも解約できます」のような購入前の安心材料は文言であって管理 UI ではない）
  check(
    !/契約を管理|請求履歴|お支払い方法の変更|career\/mypage/.test(pricing),
    'Pricing に契約管理 UI（Portal / 請求履歴 / マイページ導線）を出さない',
  );
  check(
    !/お申し込みを受け付けているプランはありません/.test(pricing),
    'Pricing に「お申し込みを受け付けているプランはありません」を出さない',
  );

  // --- Stripe env が無い環境でも Pricing UI を消さない（受験版と同じ挙動）---
  //   Stripe から読めればその実値、読めなければ表示用定数へフォールバックする構造。
  check(
    /CAREER_PRICING_DISPLAY_AMOUNT/.test(pricing) && /\?\?/.test(pricing),
    'Stripe Price が読めないときは表示用定数にフォールバックする',
  );
  check(
    !/\{offer &&/.test(pricing),
    'offer の有無で Pricing カードごと消す構造になっていない',
  );

  // --- 表示 ≠ 課金権威 ---
  //   表示用定数が server billing / checkout から参照されていないこと。
  const billingLibFiles = walkTs(join(ROOT, 'lib/careerBilling'));
  const checkoutRouteSrc = read('app/api/career/billing/checkout/route.ts');
  const displayImporters = [...billingLibFiles.map((f) => readFileSync(f, 'utf8')), checkoutRouteSrc]
    .filter((src) => /pricingDisplay|CAREER_PRICING_DISPLAY_AMOUNT/.test(src));
  check(displayImporters.length === 0, '表示用の価格定数が課金 server 側から参照されていない');
  check(
    !/[¥￥]\s*\d|\b3000\b/.test(codeOf(checkoutRouteSrc)),
    'checkout route に金額の hard-code が無い（Stripe Price が唯一の権威）',
  );

  // --- 契約中ユーザー（二重 Subscription の一次防御）---
  check(/resolveCareerAccessState\(\)/.test(pricing), 'Pricing は契約状態を server resolver で判定する');
  check(/subscribed \?/.test(pricing), '契約中は購入 CTA を出さず別導線にする');
  check(/すでにご利用中です/.test(pricing), '契約中は「すでにご利用中です」を表示する');

  // --- /career/billing は契約管理に徹する（購入 CTA を持たない）---
  const billing = codeOf(read('app/career/billing/page.tsx'));
  check(!/CareerCheckoutButton/.test(billing), '契約管理ページに購入 CTA を置かない');
  check(/CAREER_ROUTES\.pricing/.test(billing), '未契約者は公開 Pricing へ案内する');
  check(/契約を管理する/.test(billing), '契約管理ページは Portal 導線を持つ');
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

  // LIVE E2E 用の一時割引機構は撤去済み。server が割引を付ける経路は存在しない。
  // （詳細な不在検査は scripts/career-billing-qa.ts の [11] が担当する）
  check(!/discounts:/.test(route), 'server が discounts を付ける分岐が無い');
  check(!/coupon/i.test(route), 'checkout に coupon の概念が無い');
  check(
    /allow_promotion_codes: true/.test(route),
    '一般顧客の Promotion Code は従来どおり（Stripe の通常機能）',
  );
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

// ═══════════════════════════════════════════════════════════════
// [8] PASSAI 受験版（Project A）との architecture parity
// ═══════════════════════════════════════════════════════════════
//
// CAREER のログイン・課金導線は独自発明ではなく、既に本番運用されている受験版の
// 成功パターンを移植したものである。ここでは **両者が同じ構造を保っていること**と、
// **CAREER が Project A へ依存していないこと**の両方を固定する。
//   ★ 受験版のファイルは読み取り専用の参照。QA から書き換えない。
console.log('[8] 受験版（Project A）との parity と境界');
{
  const EXAM = {
    pricingPage: 'app/pricing/page.tsx',
    pricingSection: 'app/components/landing/PricingSection.tsx',
    pricingCta: 'app/components/landing/PricingCheckoutButton.tsx',
    login: 'app/login/page.tsx',
    checkout: 'app/api/billing/checkout/route.ts',
    webhook: 'app/api/billing/webhook/route.ts',
    success: 'app/billing/success/page.tsx',
  };
  for (const [label, rel] of Object.entries(EXAM)) {
    check(existsSync(join(ROOT, rel)), `受験版 ${label} を参照できる（${rel}）`);
  }

  const examPricing = codeOf(read(EXAM.pricingSection));
  const examCta = codeOf(read(EXAM.pricingCta));
  const examLogin = codeOf(read(EXAM.login));
  const examCheckout = codeOf(read(EXAM.checkout));
  const careerPricing = codeOf(read('app/career/pricing/page.tsx'));
  const careerCta = codeOf(read('app/career/components/CareerCheckoutButton.tsx'));
  const careerCheckout = codeOf(read('app/api/career/billing/checkout/route.ts'));
  const careerSuccess = codeOf(read('app/career/billing/success/page.tsx'));

  // (a) 購入前 UI は Stripe 設定に依存せず必ず描画される（受験版は pure constant を描画）。
  check(
    !/isCareerBillingConfigured\(\) \?/.test(careerPricing) && /CAREER_PRICING_DISPLAY_AMOUNT/.test(careerPricing),
    'parity: 購入前 UI は Stripe 設定の有無で消えない（受験版 PricingSection と同じ）',
  );
  check(
    !/process\.env/.test(examPricing) && !/process\.env/.test(careerPricing),
    'parity: 購入前 UI は client/server とも env を直接読まない',
  );

  // (b) guest は checkout を叩かず認証へ送り、認証後に **購入 intent** で自動再開する。
  check(/router\.push\(`\/login\?next=/.test(examCta), '受験版: guest は /login?next=… へ');
  check(/CAREER_ROUTES\.register/.test(careerCta), 'CAREER: guest は /career/register?redirect=… へ');
  for (const [label, src, marker] of [
    ['受験版', examCta, "params.get('plan')"],
    ['CAREER', careerCta, 'CHECKOUT_RESUME_PARAM'],
  ] as const) {
    check(src.includes(marker), `parity: ${label} は URL の購入 intent を読んで auto-resume する`);
  }
  for (const [label, src] of [['受験版', examCta], ['CAREER', careerCta]] as const) {
    check(
      /autoResume/i.test(src),
      `parity: ${label} は auto-resume を module スコープで 1 回に制限する（連打防止）`,
    );
  }

  // (c) 認証後の戻り先は同一 origin の相対 path のみ（open redirect 防止）。
  check(/function sanitizeNext/.test(examLogin), '受験版: next を sanitize する');
  check(
    /sanitizeCareerRedirect/.test(codeOf(read('app/career/components/CareerEmailOtpForm.tsx'))),
    'CAREER: redirect を sanitize する（namespace を /career に限定）',
  );

  // (d) Checkout の Price は必ず server 側 env から解決する（client は選べない）。
  check(/getStripePriceId\(plan\)/.test(examCheckout), '受験版: priceId は server が env から解決');
  check(/retrieveCareerPrice\(\)/.test(careerCheckout), 'CAREER: priceId は server が env から解決');
  // 受験版は plan enum だけを受け取る。CAREER は単一プランなので body 自体を読まない（より厳格）。
  check(/isPlanId\(planRaw\)/.test(examCheckout), '受験版: client からは plan enum のみ（price ではない）');
  check(
    !/req\.json\(\)/.test(careerCheckout),
    'CAREER: client からは何も受け取らない（単一プランのため body を読まない＝意図的にさらに厳格）',
  );
  for (const [label, src] of [['受験版', examCheckout], ['CAREER', careerCheckout]] as const) {
    check(
      /success_url/.test(src) && /cancel_url/.test(src) && /client_reference_id/.test(src),
      `parity: ${label} checkout は success/cancel/client_reference_id を server 側で組む`,
    );
    check(
      /subscription_data/.test(src) && /metadata/.test(src),
      `parity: ${label} は webhook が読む metadata を subscription へ載せる`,
    );
  }

  // (e) success 到達では権利を与えない。DB 反映を polling してから次画面へ。
  check(
    /POLL_INTERVAL_MS/.test(codeOf(read(EXAM.success))) && /POLL_INTERVAL_MS/.test(careerSuccess),
    'parity: 決済後は webhook 反映を polling してから遷移する',
  );
  check(
    /window\.location\.assign\('\/home'\)/.test(codeOf(read(EXAM.success))),
    '受験版: 反映確認後に /home へ（未入力なら /input/basic へ既存 guard が送る）',
  );
  check(
    /router\.replace\(nextPath\)/.test(careerSuccess),
    'CAREER: 反映確認後に基本情報 / Home へ（同じ「決済 → 初期入力 → Home」構造）',
  );

  // (f) webhook は署名検証を経てから DB を触る。
  for (const [label, rel] of [['受験版', EXAM.webhook], ['CAREER', 'app/api/career/billing/webhook/route.ts']] as const) {
    const src = codeOf(read(rel));
    check(/constructEvent\(/.test(src), `parity: ${label} webhook は署名検証する`);
    check(/stripe-signature/.test(src), `parity: ${label} webhook は署名ヘッダを要求する`);
  }

  // (g) ★ Project 境界。受験版を参考にしても Project A へは触らない。
  const careerFlowFiles = [
    'app/career/pricing/page.tsx',
    'app/career/pricing/pricingDisplay.ts',
    'app/career/billing/page.tsx',
    'app/career/components/CareerCheckoutButton.tsx',
    'app/career/components/CareerEmailOtpForm.tsx',
    'app/career/start/page.tsx',
    'lib/careerRouting/destination.ts',
    'lib/careerRouting/serverState.ts',
  ];
  const FORBIDDEN_A = [
    'lib/billing/plans',
    'lib/stripe/server',
    'lib/supabase/browserClient',
    'lib/supabase/serverClient',
    'app/components/AuthProvider',
    'components/landing/PricingSection',
    'STRIPE_PRICE_ID_BASIC',
    'STRIPE_PRICE_ID_PREMIUM',
    'subscriptions',
  ];
  for (const rel of careerFlowFiles) {
    const src = codeOf(read(rel));
    const hits = FORBIDDEN_A.filter((m) => src.includes(m));
    check(hits.length === 0, `境界: ${rel} が Project A 資産を参照しない${hits.length ? ' — ' + hits.join(', ') : ''}`);
  }
  // 受験版の Price / Product / secret を CAREER 側へ持ち込んでいない。
  check(
    !/price_[A-Za-z0-9]/.test(codeOf(read('app/career/pricing/pricingDisplay.ts'))),
    '境界: 表示用コピーに Stripe ID を書いていない',
  );
}
console.log('');

console.log(
  failures === 0
    ? 'career-signup-flow-qa: ALL PASS'
    : `career-signup-flow-qa: ${failures} FAIL`,
);
process.exit(failures === 0 ? 0 : 1);

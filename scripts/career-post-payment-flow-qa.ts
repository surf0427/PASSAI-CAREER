/*
 * scripts/career-post-payment-flow-qa.ts
 *
 * PASSAI CAREER — 決済「後」の導線 QA（dev-only / 静的 + 純関数 unit）。
 *
 *   Stripe Checkout 決済成功
 *     → signed webhook（POST /api/career/billing/webhook）
 *       → Project B persistence（career_stripe_events / career_billing_customers / career_subscriptions）
 *         → resolveCareerEntitlement → paid=true
 *           → /career/billing/success の有限ポーリング
 *             → 基本情報（/career/profile）→ Career Home（/career/home）
 *
 * 守りたい不変条件:
 *   [1] success_url への到達・session_id・localStorage・client state では権利が立たない。
 *   [2] webhook は署名検証を通るまで DB に触らない。重複配送は冪等。
 *   [3] entitlement の権威は Project B に永続化された subscription state だけ。
 *   [4] webhook race（paid=false → … → paid=true）で、true になるまで先へ進まない。
 *   [5] timeout しても paid 扱いしない・Profile / Home へ通さない。
 *   [6] 基本情報は保存できたことを確認してから Home へ進む。
 *   [7] 決済失敗 / キャンセル / 解約では権利を与えない・維持しない。
 *   [8] この導線のどこにも Project A（受験版）への依存が無い。
 *
 * ★ 実 Stripe / 実 Supabase に接続しない。ネットワーク不使用。LIVE 決済を一切発生させない。
 * 使い方: npx tsx scripts/career-post-payment-flow-qa.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  deriveCareerPaidAccess,
  type CareerSubscriptionRow,
} from '../lib/careerBilling/entitlementPolicy';
import {
  CAREER_ROUTES,
  isCareerBasicInfoComplete,
  resolveCareerGuardRedirect,
  resolveCareerStartDestination,
  type CareerAccessState,
} from '../lib/careerRouting/destination';
import type { CareerProfile } from '../types/careerProfile';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** 行 / ブロックコメントを潰して実コードだけを見る。 */
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const WEBHOOK = 'app/api/career/billing/webhook/route.ts';
const STATUS = 'app/api/career/billing/status/route.ts';
const CHECKOUT = 'app/api/career/billing/checkout/route.ts';
const SUCCESS = 'app/career/billing/success/page.tsx';
const CANCEL = 'app/career/billing/cancel/page.tsx';

const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
const past = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const row = (over: Partial<CareerSubscriptionRow>): CareerSubscriptionRow => ({
  plan: 'basic',
  status: 'active',
  current_period_end: future,
  cancel_at_period_end: false,
  ...over,
});

console.log('PASSAI CAREER — post-payment flow QA');
console.log('');

// ═══════════════════════════════════════════════════════════════
// [1] Checkout の着地先と、到達だけでは権利が立たないこと
// ═══════════════════════════════════════════════════════════════
console.log('[1] success_url / cancel_url と「到達 ≠ 権利」');
{
  const checkout = codeOf(read(CHECKOUT));
  check(
    /success_url: `\$\{origin\}\/career\/billing\/success\?session_id=\{CHECKOUT_SESSION_ID\}`/.test(checkout),
    'success_url は /career/billing/success（server が組む）',
  );
  check(
    /cancel_url: `\$\{origin\}\/career\/billing\/cancel`/.test(checkout),
    'cancel_url は /career/billing/cancel（server が組む）',
  );
  check(existsSync(join(ROOT, SUCCESS)), 'success ページが存在する');
  check(existsSync(join(ROOT, CANCEL)), 'cancel ページが存在する');

  const success = codeOf(read(SUCCESS));
  // 13/14: client state / session_id を権利の根拠にしない。
  check(!/session_id/.test(success), 'success は session_id を判定に使わない');
  check(
    !/localStorage|sessionStorage|document\.cookie/.test(success),
    'success は client storage を権利の根拠にしない',
  );
  check(!/method:\s*'POST'/.test(success), 'success は書き込み（POST）を行わない');
  for (const table of ['career_subscriptions', 'career_billing_customers', 'supabase']) {
    check(!new RegExp(table, 'i').test(success), `success が ${table} を直接触らない`);
  }
  check(/data\.paid === true/.test(success), '権利表示は server の paid 判定だけを根拠にする');
  check(/\/api\/career\/billing\/status/.test(success), 'server 判定 API を読む');

  // status API は client の主張を一切受け取らない（引数なし GET）。
  const status = codeOf(read(STATUS));
  check(/export async function GET\(\)/.test(status), 'status は引数なしの GET');
  check(!/searchParams|req\./.test(status), 'status は query / request を読まない');
  check(/resolveCareerEntitlement\(\)/.test(status), 'status は central resolver を使う');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [2] Webhook security（署名検証 → 冪等 → 永続化の順序）
// ═══════════════════════════════════════════════════════════════
console.log('[2] webhook security & idempotency');
{
  const raw = read(WEBHOOK);
  const src = codeOf(raw);

  check(/req\.headers\.get\('stripe-signature'\)/.test(src), 'stripe-signature ヘッダを必須にする');
  check(/status: 400/.test(src), '署名ヘッダ欠落は 400（retry させない）');
  check(/webhooks\.constructEvent\(/.test(src), 'constructEvent で署名検証する');
  check(
    /CAREER_STRIPE_WEBHOOK_SECRET/.test(src) && !/[^_]STRIPE_WEBHOOK_SECRET/.test(src),
    'CAREER 専用の webhook secret を使う（受験版 secret を使い回さない）',
  );

  // ★ 署名検証より前に DB を触っていないこと（実行順で検証する）。
  const verifyAt = src.indexOf('constructEvent(');
  const clientAt = src.indexOf('getCareerServiceRoleSupabaseClient()');
  const firstDbAt = Math.min(
    ...['\.from(', '\.insert(', '\.update(', '\.select(']
      .map((t) => src.indexOf(t))
      .filter((i) => i >= 0),
  );
  check(verifyAt >= 0 && clientAt > verifyAt, '署名検証の後に初めて DB client を作る');
  check(verifyAt >= 0 && firstDbAt > verifyAt, '署名検証より前に DB へ触れない');

  // test ⇄ live 混線ガード。
  check(/event\.livemode !== expectedLivemode/.test(src), 'livemode 不一致の event を拒否する');

  // 冪等性: 既処理なら何もせず 200 / 未処理なら INSERT してから処理 / 失敗は processed_at を立てない。
  check(/career_stripe_events/.test(raw), 'event を career_stripe_events で記録する');
  check(/existing\?\.processed_at/.test(src), '処理済み event を検出する');
  check(/duplicate: true/.test(src), '重複配送は再処理せず 200 を返す');
  check(/!== '23505'/.test(src), '同時配送の unique 衝突は正常系として続行する');
  check(
    /transient-error/.test(src) && /status: 500/.test(src),
    'transient 失敗は 500（Stripe に retry させる）',
  );
  check(
    /permanent-error/.test(src),
    'permanent 失敗は記録して 200（retry しても直らない）',
  );

  // event coverage: 権利を動かすのは subscription.* のみ。
  for (const t of [
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'checkout.session.completed',
    'invoice.payment_failed',
  ]) {
    check(src.includes(`'${t}'`), `event ${t} を受け取る`);
  }
  check(
    /syncCareerSubscriptionFromStripe\(/.test(src),
    '権利の同期は subscription.* から syncCareerSubscriptionFromStripe 1 本',
  );
  // checkout.session.completed は観測のみ（ここで権利を与えない）。
  const completedAt = src.indexOf("case 'checkout.session.completed'");
  const completedBlock = completedAt >= 0 ? src.slice(completedAt, completedAt + 600) : '';
  check(
    completedBlock.length > 0 && !/syncCareerSubscriptionFromStripe/.test(completedBlock),
    'checkout.session.completed 単体では権利を与えない（観測ログのみ）',
  );
  check(
    !/HANDLED_EVENT_TYPES\.has\(event\.type\)[\s\S]{0,40}return \{ kind: 'handled' \}/.test(src),
    '未知の event は ignored（勝手に handled にしない）',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [3] entitlement（Project B の subscription state だけが権威）
// ═══════════════════════════════════════════════════════════════
console.log('[3] entitlement policy');
{
  // 10: canceled → unpaid（ただし期間内は grace）。現行 policy をそのまま固定する。
  check(deriveCareerPaidAccess([row({ status: 'active' })]) === true, 'active → paid');
  check(deriveCareerPaidAccess([row({ status: 'trialing' })]) === true, 'trialing → paid（現行 policy）');
  check(deriveCareerPaidAccess([row({ status: 'past_due' })]) === true, 'past_due → paid（dunning 猶予・現行 policy）');
  check(
    deriveCareerPaidAccess([row({ status: 'canceled', current_period_end: past })]) === false,
    'canceled かつ期間終了 → unpaid',
  );
  check(
    deriveCareerPaidAccess([row({ status: 'canceled', current_period_end: future })]) === true,
    'canceled でも期間内は grace（現行 policy）',
  );
  check(
    deriveCareerPaidAccess([row({ status: 'active', cancel_at_period_end: true })]) === true,
    '解約予約は期間終了まで維持',
  );
  for (const status of ['unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
    check(
      deriveCareerPaidAccess([row({ status, current_period_end: future })]) === false,
      `${status} → unpaid（決済失敗系で権利を与えない）`,
    );
  }
  check(deriveCareerPaidAccess([]) === false, '行が無い → unpaid');

  // DB 到達不能 / 未適用は fail-closed（resolver 側）。
  const ent = codeOf(read('lib/careerBilling/entitlement.ts'));
  check(/not-provisioned/.test(ent) && /ENTITLEMENT_CHECK_FAILED/.test(ent), '判定不能は reject（fail-closed）');
  const serverState = codeOf(read('lib/careerRouting/serverState.ts'));
  check(
    /kind: 'unavailable'/.test(serverState),
    '判定不能を unavailable として扱う（paid 側に倒さない）',
  );
  check(!/career_subscriptions/.test(serverState), 'routing は subscription を直接読まない（resolver に委譲）');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [4] success ページ: 有限ポーリングと webhook race
// ═══════════════════════════════════════════════════════════════
console.log('[4] webhook race（Case A: 遅延反映 / Case B: timeout）');
{
  const success = codeOf(read(SUCCESS));
  check(/POLL_INTERVAL_MS/.test(success) && /MAX_ATTEMPTS/.test(success), 'ポーリング間隔と上限が定義されている');
  check(/attemptsRef\.current >= MAX_ATTEMPTS/.test(success), '試行回数に上限がある（永久 poll 禁止）');
  check(/setPhase\('pending'\)/.test(success), 'timeout は失敗ではなく recoverable な状態にする');
  check(/router\.replace\(nextPath\)/.test(success), 'paid 確認後にだけ次画面へ進む');
  // 自動遷移は phase === 'active'（= paid 確認済み）のときだけ。
  check(
    /if \(phase !== 'active'\) return;/.test(success),
    '自動遷移は paid 確認済みのときだけ発火する',
  );

  // Case A: paid=false → false → true。true になって初めて基本情報へ。
  const timeline: CareerAccessState[] = [
    { kind: 'unpaid' },
    { kind: 'unpaid' },
    { kind: 'paid', basicInfoComplete: false },
  ];
  const dests = timeline.map(resolveCareerStartDestination);
  check(
    dests[0] === CAREER_ROUTES.pricing &&
      dests[1] === CAREER_ROUTES.pricing &&
      dests[2] === CAREER_ROUTES.basicInfo,
    'Case A: paid=false の間は基本情報へ進まず、true で基本情報へ',
  );

  // Case B: paid=false のまま timeout。Profile / Home のどちらにも通さない。
  for (const state of [
    { kind: 'unpaid' } as CareerAccessState,
    { kind: 'unavailable' } as CareerAccessState,
    { kind: 'guest' } as CareerAccessState,
  ]) {
    check(
      resolveCareerGuardRedirect(state, CAREER_ROUTES.basicInfo) !== null,
      `Case B: ${state.kind} は基本情報へ通さない`,
    );
    check(
      resolveCareerGuardRedirect(state, CAREER_ROUTES.home) !== null,
      `Case B: ${state.kind} は Home へ通さない`,
    );
  }
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [5] 決済後の routing matrix（server guard）
// ═══════════════════════════════════════════════════════════════
console.log('[5] routing matrix');
{
  const PAID_NEW: CareerAccessState = { kind: 'paid', basicInfoComplete: false };
  const PAID_DONE: CareerAccessState = { kind: 'paid', basicInfoComplete: true };

  check(resolveCareerStartDestination({ kind: 'guest' }) === CAREER_ROUTES.pricing, 'guest → Pricing');
  check(resolveCareerStartDestination({ kind: 'unpaid' }) === CAREER_ROUTES.pricing, 'unpaid → Pricing');
  check(resolveCareerStartDestination(PAID_NEW) === CAREER_ROUTES.basicInfo, 'paid + 基本情報未完 → Profile');
  check(resolveCareerStartDestination(PAID_DONE) === CAREER_ROUTES.home, 'paid + 基本情報完了 → Home');
  // 解約済み（= unpaid 相当）は Pricing。契約管理ページを購入導線にしない。
  check(
    resolveCareerStartDestination({ kind: 'unpaid' }) !== CAREER_ROUTES.billing,
    'canceled/unpaid を契約管理ページへ送らない',
  );

  check(resolveCareerGuardRedirect(PAID_NEW, CAREER_ROUTES.basicInfo) === null, 'paid は Profile を閲覧できる');
  check(resolveCareerGuardRedirect(PAID_DONE, CAREER_ROUTES.home) === null, 'paid は Home を閲覧できる');
  check(
    resolveCareerGuardRedirect({ kind: 'guest' }, CAREER_ROUTES.home) ===
      `${CAREER_ROUTES.login}?redirect=${encodeURIComponent(CAREER_ROUTES.home)}`,
    'guest は login へ（戻り先付き）',
  );

  // guard が server 側に存在し、client state を根拠にしない。
  for (const rel of ['app/career/profile/page.tsx', 'app/career/home/page.tsx']) {
    const src = codeOf(read(rel));
    check(!/^\s*['"]use client['"]/m.test(src), `${rel} は server component`);
    check(/resolveCareerAccessState\(\)/.test(src), `${rel} は server resolver で判定する`);
    check(/redirect\(away\)/.test(src), `${rel} は不許可なら redirect する`);
    check(
      !/searchParams|session_id|localStorage/.test(src),
      `${rel} は query / session_id / localStorage を権利判定に使わない`,
    );
  }
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [6] 基本情報の保存と Home への遷移
// ═══════════════════════════════════════════════════════════════
console.log('[6] 基本情報 保存 → Home');
{
  const profileClient = codeOf(read('app/career/profile/ProfileClient.tsx'));
  check(/router\.push\('\/career\/home'\)/.test(profileClient), '保存成功後は /career/home へ進む');
  // 8: 保存できていなければ Home へ進ませない（読み直して確認する）。
  const guardAt = profileClient.indexOf('isCareerBasicInfoComplete(loadBasicInfo())');
  const pushAt = profileClient.indexOf("router.push('/career/home')");
  check(guardAt >= 0, '保存後に canonical を読み直して完了を確認する');
  check(guardAt >= 0 && pushAt > guardAt, '確認は Home への push より前に行う');
  check(/setSaveError\(/.test(profileClient), '保存失敗はユーザーに提示する（黙って進まない）');
  // 完了判定は Home guard / success ページと同じ純関数を共有する。
  check(
    /isCareerBasicInfoComplete/.test(codeOf(read('app/career/home/CareerHomeClient.tsx'))),
    'Home の未完了判定も同じ純関数を使う',
  );
  check(
    /isCareerBasicInfoComplete/.test(codeOf(read(SUCCESS))),
    'success の遷移先判定も同じ純関数を使う',
  );

  // 完了判定そのもの（必須 5 項目）。
  const full = {
    name: 'ニックネーム',
    grade: '3年',
    graduationYear: '2027年卒',
    preferences: [{ university: 'A大学', faculty: 'B学部', department: '' }],
  } as unknown as CareerProfile;
  check(isCareerBasicInfoComplete(full), '必須項目が揃えば完了');
  check(!isCareerBasicInfoComplete(null), '未保存は未完了');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [7] キャンセル / 契約管理との分離
// ═══════════════════════════════════════════════════════════════
console.log('[7] cancel と Pricing / Billing の分離');
{
  const cancel = codeOf(read(CANCEL));
  check(/\/career\/pricing/.test(cancel), 'cancel からは公開 Pricing に戻す');
  check(!/マイページ/.test(cancel), 'cancel に会員向けマイページ導線を出さない');
  check(
    !/paid|entitlement|subscription/i.test(cancel),
    'cancel は権利に一切触れない（表示のみ）',
  );

  const billing = codeOf(read('app/career/billing/page.tsx'));
  check(!/CareerCheckoutButton/.test(billing), '契約管理ページに購入 CTA を置かない');
  const pricing = codeOf(read('app/career/pricing/page.tsx'));
  check(/CareerCheckoutButton/.test(pricing), '購入導線は公開 Pricing に一本化されている');
  // 11: 契約中は購入 CTA を出さない（server 側 409 が最終防御）。
  check(/subscribed \?/.test(pricing), '契約中は購入 CTA を出さない');
  check(
    /ALREADY_SUBSCRIBED/.test(codeOf(read(CHECKOUT))),
    '二重 Subscription は checkout API が 409 で拒否する',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [8] Project 境界（決済後 chain は Project B だけで閉じる）
// ═══════════════════════════════════════════════════════════════
console.log('[8] Project A 非依存');
{
  const CHAIN = [
    WEBHOOK,
    STATUS,
    CHECKOUT,
    SUCCESS,
    CANCEL,
    'app/career/profile/page.tsx',
    'app/career/home/page.tsx',
    'lib/careerBilling/entitlement.ts',
    'lib/careerBilling/subscription.ts',
    'lib/careerRouting/serverState.ts',
  ];
  const FORBIDDEN = [
    'lib/supabase/browserClient',
    'lib/supabase/serverClient',
    'lib/supabase/serviceRoleClient',
    'lib/billing/',
    'lib/stripe/server',
    'app/components/AuthProvider',
    'STRIPE_WEBHOOK_SECRET"',
    "from('subscriptions')",
    "from('profiles')",
  ];
  for (const rel of CHAIN) {
    const src = codeOf(read(rel));
    const hits = FORBIDDEN.filter((m) => src.includes(m));
    check(hits.length === 0, `${rel}: Project A 資産を参照しない${hits.length ? ' — ' + hits.join(', ') : ''}`);
  }
  // careerBilling / careerRouting 全体でも Project A client を掴まない。
  const libFiles = [
    ...walkTs(join(ROOT, 'lib/careerBilling')),
    ...walkTs(join(ROOT, 'lib/careerRouting')),
  ];
  const bad = libFiles.filter((f) =>
    /getServerSupabaseClient|getBrowserSupabaseClient|getServiceRoleSupabaseClient/.test(
      codeOf(readFileSync(f, 'utf8')),
    ),
  );
  check(bad.length === 0, `Project A client factory 参照 0（残 ${bad.map((f) => relative(ROOT, f)).join(', ')}）`);
}
console.log('');

console.log(
  failures === 0
    ? 'career-post-payment-flow-qa: ALL PASS'
    : `career-post-payment-flow-qa: ${failures} FAIL`,
);
process.exit(failures === 0 ? 0 : 1);

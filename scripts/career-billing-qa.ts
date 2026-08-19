/*
 * scripts/career-billing-qa.ts
 *
 * PASSAI CAREER — 認証 / Stripe 課金 / entitlement の QA（dev-only）。
 *
 * 検証:
 *   [1] entitlement policy の unit test（deriveCareerEffectivePlan / 解約予約 / grace）
 *   [2] plan catalog（server-side allowlist・受験版 env 名との分離）
 *   [3] Checkout route の security 契約（priceId / userId / customerId を受け取らない）
 *   [4] Portal route の security 契約（body を読まない = 他人 customer を開けない）
 *   [5] Webhook の security / 冪等契約（署名検証が DB より先・専用 secret・event 表）
 *   [6] Project 境界（課金 runtime が Project A の client / table に触れない）
 *   [7] client bundle 安全性（server-only module を 'use client' から import しない）
 *   [8] success ページが到達を根拠に権利を与えないこと
 *   [9] DDL（RLS + GRANT の最小権限・UNIQUE 制約・client 書き込み不可）
 *  [10] 既存 CAREER AI route を根拠なく paywall していないこと（AGENTS §19）
 *
 * ★ 実 Stripe / 実 Supabase へ接続しない。env 実値も secret も読まない・表示しない。
 * 使い方: npx tsx scripts/career-billing-qa.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  CAREER_PAID_PLAN_IDS,
  CAREER_PLANS,
  isCareerEffectivePlan,
  isCareerPaidPlanId,
} from '../lib/careerBilling/plans';
import {
  CAREER_SUBSCRIPTION_STATUSES,
  careerPlanSatisfies,
  deriveCareerEffectivePlan,
  hasCareerPaidAccess,
  type CareerSubscriptionRow,
} from '../lib/careerBilling/entitlementPolicy';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// コメントを潰して「実コードだけ」を検査する（説明文の語で誤判定しないため）。
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

// import 文を潰す。「署名検証より前に DB を触っていないか」を **本体の実行順**で
// 見たいので、ファイル冒頭の import 行が位置比較を汚さないようにする。
function stripImports(src: string): string {
  return src.replace(/^import[\s\S]*?;\s*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}

// SQL の行コメント（-- ...）を潰す。GRANT 検査を実 DDL だけに限定するため
// （§4 の解説コメントに GRANT の例示文が含まれる）。
function stripSqlComments(src: string): string {
  return src.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
}

const CHECKOUT = 'app/api/career/billing/checkout/route.ts';
const PORTAL = 'app/api/career/billing/portal/route.ts';
const WEBHOOK = 'app/api/career/billing/webhook/route.ts';
const STATUS = 'app/api/career/billing/status/route.ts';
const DDL = 'supabase/career_billing_apply.sql';

console.log('PASSAI CAREER — auth / Stripe billing / entitlement QA');
console.log('');

// ═══════════════════════════════════════════════════════════════
// [1] entitlement policy（純粋関数の unit test）
// ═══════════════════════════════════════════════════════════════
console.log('[1] entitlement policy (deriveCareerEffectivePlan)');
{
  const NOW = Date.UTC(2026, 0, 15); // 2026-01-15 固定（時刻依存を排除）
  const future = new Date(NOW + 30 * 86400_000).toISOString();
  const past = new Date(NOW - 30 * 86400_000).toISOString();

  const row = (over: Partial<CareerSubscriptionRow>): CareerSubscriptionRow => ({
    plan: 'basic',
    status: 'active',
    current_period_end: future,
    cancel_at_period_end: false,
    ...over,
  });
  const derive = (rows: CareerSubscriptionRow[]) =>
    deriveCareerEffectivePlan(rows, NOW);

  check(derive([]) === 'free', '契約なし → free');
  check(derive([row({ status: 'active' })]) === 'basic', 'active → 権利あり');
  check(derive([row({ status: 'trialing' })]) === 'basic', 'trialing → 権利あり');
  // past_due は受験版 policy をそのまま踏襲（dunning 期間中はアクセス維持）。
  check(derive([row({ status: 'past_due' })]) === 'basic', 'past_due → 権利あり（受験版 policy 踏襲）');

  check(derive([row({ status: 'unpaid' })]) === 'free', 'unpaid → 権利なし');
  check(derive([row({ status: 'incomplete' })]) === 'free', 'incomplete → 権利なし');
  check(derive([row({ status: 'incomplete_expired' })]) === 'free', 'incomplete_expired → 権利なし');
  check(derive([row({ status: 'paused' })]) === 'free', 'paused → 権利なし');

  // ★ AGENTS §9 / QA Case 16: 解約予約しただけでは即時失効しない。
  check(
    derive([row({ status: 'active', cancel_at_period_end: true, current_period_end: future })]) === 'basic',
    'active + cancel_at_period_end + 期間内 → 期間終了まで権利維持',
  );
  check(
    derive([row({ status: 'canceled', cancel_at_period_end: true, current_period_end: future })]) === 'basic',
    'canceled + 期間内 → grace period として権利維持',
  );
  // ★ QA Case 17: 期間終了後は権利なし。
  check(
    derive([row({ status: 'canceled', cancel_at_period_end: true, current_period_end: past })]) === 'free',
    'canceled + 期間終了 → 権利なし',
  );
  check(
    derive([row({ status: 'canceled', current_period_end: null })]) === 'free',
    'canceled + period_end なし → 権利なし',
  );
  check(
    derive([row({ status: 'canceled', current_period_end: 'not-a-date' })]) === 'free',
    'canceled + 不正な日付 → 権利なし（fail-closed）',
  );

  // 未知の plan / status は権利に数えない。
  check(derive([row({ plan: 'attacker' })]) === 'free', '未知の plan → 権利なし');
  check(derive([row({ plan: 'free' })]) === 'free', "plan='free' 行 → 権利なし");

  // 複数行は強い方が勝つ。
  check(
    derive([row({ plan: 'basic' }), row({ plan: 'premium' })]) === 'premium',
    '複数契約 → premium > basic',
  );
  check(
    derive([row({ plan: 'premium', status: 'canceled', current_period_end: past }), row({ plan: 'basic' })]) === 'basic',
    '失効した premium + 有効な basic → basic',
  );

  // 述語
  check(!hasCareerPaidAccess('free'), 'hasCareerPaidAccess(free) === false');
  check(hasCareerPaidAccess('basic') && hasCareerPaidAccess('premium'), 'hasCareerPaidAccess(basic/premium) === true');
  check(!careerPlanSatisfies('free', 'basic'), 'free は basic を満たさない');
  check(careerPlanSatisfies('basic', 'basic'), 'basic は basic を満たす');
  check(!careerPlanSatisfies('basic', 'premium'), 'basic は premium を満たさない');
  check(careerPlanSatisfies('premium', 'basic'), 'premium は basic を満たす');

  // status 集合が DDL の CHECK と一致していること。
  const ddl = read(DDL);
  for (const s of CAREER_SUBSCRIPTION_STATUSES) {
    check(ddl.includes(`'${s}'`), `DDL の status CHECK に '${s}' がある`);
  }
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [2] plan catalog（server-side allowlist / 受験版との分離）
// ═══════════════════════════════════════════════════════════════
console.log('[2] plan catalog & Stripe Price env separation');
{
  const plansSrc = stripComments(read('lib/careerBilling/plans.ts'));

  check(CAREER_PAID_PLAN_IDS.length === 2, '有料プランは basic / premium の 2 つ');
  check(isCareerPaidPlanId('basic') && isCareerPaidPlanId('premium'), 'isCareerPaidPlanId が basic/premium を受理');
  check(!isCareerPaidPlanId('free'), "isCareerPaidPlanId は 'free' を拒否（契約は有料のみ）");
  check(!isCareerPaidPlanId('price_attacker'), '任意文字列は plan として拒否');
  check(isCareerEffectivePlan('free'), "isCareerEffectivePlan は 'free' を受理");

  // ★ 受験版 Price env 名を CAREER の catalog に持ち込んでいないこと（AGENTS §10）。
  for (const plan of CAREER_PAID_PLAN_IDS) {
    const envName = CAREER_PLANS[plan].stripePriceIdEnvName;
    check(envName.startsWith('STRIPE_PRICE_ID_CAREER_'), `${plan} の env 名が CAREER 専用（${envName}）`);
  }
  check(
    !/STRIPE_PRICE_ID_BASIC\b/.test(plansSrc) && !/STRIPE_PRICE_ID_PREMIUM\b/.test(plansSrc),
    'plans.ts に受験版 Price env 名（STRIPE_PRICE_ID_BASIC/PREMIUM）が無い',
  );
  // 価格・訴求文言を repo 側に持たない（CAREER の料金仕様が repo に存在しないため）。
  check(!/priceJpy/.test(plansSrc), 'plans.ts に金額（priceJpy）をハードコードしていない');
  check(!/process\.env/.test(plansSrc), 'plans.ts は env を読まない（pure constants）');

  // 逆引きは CAREER env のみを見る。
  const stripeSrc = stripComments(read('lib/careerBilling/stripe.ts'));
  check(
    /getCareerPlanFromPriceId/.test(stripeSrc),
    'CAREER 専用の Price → plan 逆引きが存在する',
  );
  check(
    /EXAM_PRICE_ENV_NAMES/.test(stripeSrc),
    '受験版 Price ID の誤設定を検知するガードがある',
  );
  check(
    /is not set/.test(stripeSrc) && /getCareerStripePriceId/.test(stripeSrc),
    'Price env 未設定は throw（fail-closed。既定 price へ fallback しない）',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [3] Checkout route の security 契約
// ═══════════════════════════════════════════════════════════════
console.log('[3] checkout route security contract');
{
  const src = stripComments(read(CHECKOUT));

  // body から読むのは plan だけ。
  const bodyReads = [...src.matchAll(/\(body as[^)]*\)\??\.(\w+)/g)].map((m) => m[1]);
  check(
    bodyReads.length > 0 && bodyReads.every((k) => k === 'plan'),
    `body から読むのは plan のみ（実際: ${JSON.stringify([...new Set(bodyReads)])}）`,
  );
  // ★ QA Case 8 / 9: 任意 priceId / userId / customerId の注入経路が無い。
  for (const forbidden of ['priceId', 'price_id', 'customerId', 'customer_id', 'userId', 'user_id', 'premium']) {
    check(
      !new RegExp(`body[^\\n]*\\b${forbidden}\\b`).test(src),
      `body から ${forbidden} を読まない`,
    );
  }
  check(
    /isCareerPaidPlanId\(planRaw\)/.test(src),
    'plan は server-side allowlist（isCareerPaidPlanId）で検証する',
  );
  // priceId は plan key → server allowlist → env → Stripe 実物照合、の順でのみ決まる。
  // （retrieveCareerPlanPrice が内部で getCareerStripePriceId を呼び、livemode まで検証する）
  check(
    /retrieveCareerPlanPrice\(plan\)/.test(src),
    'priceId は plan key から server 側で解決する（livemode 検証つき）',
  );
  check(
    /const priceId = priceCheck\.price\.id/.test(src),
    'Checkout に渡す priceId は Stripe から取得した実 Price の id',
  );
  // identity は server session。
  check(
    /authenticateCareerMember\(\)/.test(src),
    'identity は server session（authenticateCareerMember）で確定する',
  );
  check(
    /getOrCreateCareerStripeCustomer\(/.test(src),
    'customer は canonical mapping から解決する（client 指定不可）',
  );
  // ★ AGENTS §15: 既契約者に checkout を作らせない。
  check(/ALREADY_SUBSCRIBED/.test(src), '既契約時は 409 ALREADY_SUBSCRIBED を返す（重複契約防止）');
  check(/hasCareerPaidAccess\(/.test(src), '重複契約判定は entitlement policy を使う');
  // webhook との契約キー。
  check(
    /subscription_data/.test(src) && /CAREER_METADATA_USER_ID_KEY/.test(src),
    'subscription_data.metadata に app_user_id を必ず設定する',
  );
  check(/success_url/.test(src) && /cancel_url/.test(src), 'success_url / cancel_url を設定する');
  check(/\/career\/billing\/success/.test(src), 'success_url は CAREER 名前空間内');
  // fail-closed
  check(/isCareerPlanConfigured\(plan\)/.test(src), 'Price 未設定なら 503（fail-closed。売らない）');
  // secret / Stripe raw message を返さない。
  check(
    !/message:\s*(err|message)\b/.test(src) && !/detail:\s*message\b/.test(src),
    'Stripe の raw error message をレスポンスに載せない',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [4] Portal route の security 契約
// ═══════════════════════════════════════════════════════════════
console.log('[4] portal route security contract');
{
  const src = stripComments(read(PORTAL));
  // ★ QA Case 20: body を読まない = 他人の customer を開かせる経路が構造的に無い。
  check(!/req\.json\(\)/.test(src), 'portal は request body を読まない');
  check(!/\bcustomerId\b\s*=\s*[^;]*body/.test(src), 'customerId を body から取らない');
  check(
    /loadCareerStripeCustomerId\(/.test(src),
    'customer は「session userId → career_billing_customers」で解決する',
  );
  check(/authenticateCareerMember\(\)/.test(src), 'member 認証を行う');
  // ★ QA Case 18: customer が無い free user でも安全に処理される。
  check(/NO_CUSTOMER/.test(src), 'customer 未確定（未契約）は 400 NO_CUSTOMER で安全に返す');
  check(/billingPortal\.sessions\.create/.test(src), 'Stripe Billing Portal session を作る');
  check(/return_url/.test(src) && /\/career\/mypage/.test(src), 'return_url は CAREER 名前空間内');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [5] Webhook の security / 冪等契約
// ═══════════════════════════════════════════════════════════════
console.log('[5] webhook security & idempotency contract');
{
  const src = stripImports(stripComments(read(WEBHOOK)));

  // ★ QA Case 10: 署名検証が DB アクセスより **先**にあること（位置で検証する）。
  const verifyIdx = src.indexOf('constructEvent');
  const clientIdx = src.indexOf('getCareerServiceRoleSupabaseClient');
  const fromIdx = src.indexOf(".from('career_stripe_events')");
  check(verifyIdx > -1, 'webhooks.constructEvent で署名検証する');
  check(
    verifyIdx > -1 && clientIdx > verifyIdx,
    '署名検証が service_role client 取得より前にある',
  );
  check(
    verifyIdx > -1 && (fromIdx === -1 || fromIdx > verifyIdx),
    '署名検証が DB アクセスより前にある（検証失敗時は DB mutation 0）',
  );
  check(/status:\s*400/.test(src), '署名不正は 400（Stripe に retry させない）');

  // ★ 専用 webhook secret（受験版と混線させない）。
  check(
    /CAREER_STRIPE_WEBHOOK_SECRET/.test(src),
    'CAREER 専用 webhook secret（CAREER_STRIPE_WEBHOOK_SECRET）を使う',
  );
  check(
    !/(?<!CAREER_)\bSTRIPE_WEBHOOK_SECRET\b/.test(src),
    '受験版の STRIPE_WEBHOOK_SECRET を参照しない',
  );

  // ★ QA Case 12: 冪等化。
  check(/career_stripe_events/.test(src), 'career_stripe_events で event_id 単位に冪等化する');
  check(/processed_at/.test(src), 'processed_at で処理済みを判定する');
  check(/duplicate:\s*true/.test(src), '処理済み event は何もせず 200 で返す');
  check(/'23505'/.test(src), '同時配送の unique violation を race として許容する');

  // 扱う event（AGENTS §31）。
  for (const t of [
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'checkout.session.completed',
    'invoice.payment_failed',
  ]) {
    check(src.includes(t), `event '${t}' を扱う`);
  }
  check(
    /syncCareerSubscriptionFromStripe\(/.test(src),
    'subscription.* は同期処理へ dispatch する',
  );
  // permanent / transient の区別。
  check(/transient-error/.test(src) && /permanent-error/.test(src), 'transient / permanent の失敗を区別する');
  check(/status:\s*500/.test(src), 'transient failure は 500（Stripe に retry させる）');

  // ★ AGENTS §25: webhook で重い処理をしない。
  for (const heavy of ['careerAi', 'anthropic', 'openai', 'generation', 'fetchCompany', 'crawl']) {
    check(!new RegExp(heavy, 'i').test(src), `webhook が重い処理（${heavy}）を呼ばない`);
  }
  // secret をログに出さない。
  check(!/console\.(log|info|warn|error)\([^)]*SECRET/i.test(src), 'secret をログ出力しない');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [6] Project 境界（Project A の client / table に触れない）
// ═══════════════════════════════════════════════════════════════
console.log('[6] project boundary (billing runtime stays on Project B)');
{
  const billingFiles = [
    CHECKOUT,
    PORTAL,
    WEBHOOK,
    STATUS,
    'lib/careerBilling/plans.ts',
    'lib/careerBilling/entitlementPolicy.ts',
    'lib/careerBilling/entitlement.ts',
    'lib/careerBilling/customer.ts',
    'lib/careerBilling/subscription.ts',
    'lib/careerBilling/stripe.ts',
    'lib/careerBilling/origin.ts',
  ];
  for (const f of billingFiles) {
    check(existsSync(join(ROOT, f)), `${f} が存在する`);
  }

  const forbiddenIdents = [
    'getBrowserSupabaseClient',
    'getServerSupabaseClient',
    'getServiceRoleSupabaseClient',
    'getSupabaseServiceRoleKey',
  ];
  // Project A の課金 table を CAREER 課金 runtime が触らないこと。
  const forbiddenTables = ["from('subscriptions')", "from('stripe_events')", "from('profiles')"];

  let violations = 0;
  for (const f of billingFiles) {
    const code = stripComments(read(f));
    for (const ident of forbiddenIdents) {
      if (new RegExp(`(?<![A-Za-z0-9_])${ident}(?![A-Za-z0-9_])`).test(code)) {
        console.log(`  FAIL  ${f} references Project A factory "${ident}"`);
        failures++;
        violations++;
      }
    }
    for (const t of forbiddenTables) {
      if (code.includes(t)) {
        console.log(`  FAIL  ${f} touches Project A billing table ${t}`);
        failures++;
        violations++;
      }
    }
  }
  if (violations === 0) {
    check(true, '課金 runtime は getCareer* / career_* table のみを使う');
  }

  // 課金 state を保存する table 名が CAREER 専用であること。
  const subSrc = stripComments(read('lib/careerBilling/subscription.ts'));
  check(/career_subscriptions/.test(subSrc), 'subscription 同期先は career_subscriptions');
  check(/career_billing_customers/.test(subSrc), 'customer mapping は career_billing_customers');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [7] client bundle 安全性
// ═══════════════════════════════════════════════════════════════
console.log('[7] client bundle safety (no secrets, no server-only imports)');
{
  const SERVER_ONLY_MODULES = [
    'careerBilling/stripe',
    'careerBilling/entitlement',
    'careerBilling/subscription',
    'careerBilling/customer',
    'careerBilling/origin',
  ];

  // server-only module 側は 'server-only' を宣言していること。
  for (const m of SERVER_ONLY_MODULES) {
    const src = read(`lib/${m}.ts`);
    check(/^import 'server-only';/m.test(src), `lib/${m}.ts が 'server-only' を宣言している`);
  }

  // repo 全体の 'use client' ファイルが server-only module / secret を import しないこと。
  function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
    }
    return out;
  }
  const uiFiles = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))];

  let leaks = 0;
  for (const file of uiFiles) {
    const raw = readFileSync(file, 'utf8');
    if (!/^\s*['"]use client['"]/m.test(raw)) continue;
    const code = stripComments(raw);
    for (const m of SERVER_ONLY_MODULES) {
      // 型のみ import は bundle に残らないので許可する。
      const re = new RegExp(`import(?!\\s+type)[^;]*['"][^'"]*${m}['"]`);
      if (re.test(code)) {
        console.log(`  FAIL  ${relative(ROOT, file)} ('use client') imports server-only lib/${m}`);
        failures++;
        leaks++;
      }
    }
    for (const secret of ['STRIPE_SECRET_KEY', 'CAREER_STRIPE_WEBHOOK_SECRET', 'CAREER_SUPABASE_SERVICE_ROLE_KEY']) {
      if (code.includes(secret)) {
        console.log(`  FAIL  ${relative(ROOT, file)} ('use client') references secret ${secret}`);
        failures++;
        leaks++;
      }
    }
  }
  if (leaks === 0) {
    check(true, "'use client' から server-only module / secret を参照していない");
  }

  // client 側 CTA は plan key しか送らない。
  const btn = stripComments(read('app/career/components/CareerCheckoutButton.tsx'));
  check(
    /JSON\.stringify\(\{\s*plan\s*\}\)/.test(btn),
    'CTA が送る body は { plan } のみ',
  );
  check(!/priceId|customerId|price_/.test(btn), 'CTA は priceId / customerId を送らない');
  // ★ QA Case 5: open redirect 防止（login への戻り先は CAREER 相対 path 固定）。
  check(
    /\/career\/login\?redirect=\$\{encodeURIComponent\(next\)\}/.test(btn),
    'login への戻り先は encodeURIComponent 済みの CAREER 相対 path',
  );
  check(
    /const next = `\/career\/billing\?plan=\$\{plan\}`/.test(btn),
    '戻り先はリテラル構築（外部 URL が入り込む経路が無い）',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [8] success ページが到達を根拠に権利を与えないこと
// ═══════════════════════════════════════════════════════════════
console.log('[8] success page grants NO entitlement by arrival');
{
  const src = stripComments(read('app/career/billing/success/page.tsx'));
  check(
    /\/api\/career\/billing\/status/.test(src),
    'success ページは status API（server 判定）を読む',
  );
  check(
    !/method:\s*'POST'/.test(src),
    'success ページは POST（書き込み）を一切行わない',
  );
  for (const table of ['career_subscriptions', 'career_billing_customers', 'supabase']) {
    check(!new RegExp(table, 'i').test(src), `success ページが ${table} を直接触らない`);
  }
  check(/data\.paid === true/.test(src), '「契約済み」表示は server の paid 判定のみを根拠にする');

  // status API は client の主張を受け取らない（GET・body 無し）。
  const statusSrc = stripComments(read(STATUS));
  check(/export async function GET\(\)/.test(statusSrc), 'status API は引数なしの GET（client 入力を受け取らない）');
  check(/resolveCareerEntitlement\(\)/.test(statusSrc), 'status API は central resolver を使う');
  check(
    !/stripe_customer_id|stripe_subscription_id/.test(statusSrc),
    'status API は Stripe の customer / subscription ID を返さない',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [9] DDL（最小権限・UNIQUE 制約・client 書き込み不可）
// ═══════════════════════════════════════════════════════════════
console.log('[9] DDL: RLS + GRANT least privilege');
{
  const ddl = read(DDL);
  // GRANT/REVOKE の検査は「実 DDL のみ」を対象にする（解説コメントに例示があるため）。
  const ddlCode = stripSqlComments(ddl);
  const TABLES = ['career_billing_customers', 'career_subscriptions', 'career_stripe_events'];

  for (const t of TABLES) {
    check(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(ddl), `${t} を冪等に作成する`);
    check(new RegExp(`ALTER TABLE ${t}\\s+ENABLE ROW LEVEL SECURITY`).test(ddl), `${t} で RLS を有効化する`);
    check(
      new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM anon, authenticated`).test(ddlCode),
      `${t} は anon / authenticated から全権限を剥奪する`,
    );
    check(
      new RegExp(`GRANT ALL ON public\\.${t}\\s+TO service_role`).test(ddlCode),
      `${t} は service_role にのみ権限を与える`,
    );
  }

  // ★ AGENTS §21: client が課金状態を書き換えられないこと。
  check(
    !/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*TO\s+authenticated/i.test(ddlCode),
    'authenticated への GRANT が 1 つも無い（課金状態の client 改竄不可）',
  );
  check(!/TO\s+anon/i.test(ddlCode.replace(/FROM anon, authenticated/g, '')), 'anon への GRANT が無い');

  // ★ AGENTS §20: DB 側の一意性保証。
  check(/stripe_subscription_id\s+text\s+NOT NULL UNIQUE/.test(ddlCode), 'stripe_subscription_id が UNIQUE');
  check(/stripe_customer_id\s+text\s+NOT NULL UNIQUE/.test(ddlCode), 'customer mapping の stripe_customer_id が UNIQUE');
  check(/user_id\s+uuid\s+PRIMARY KEY REFERENCES auth\.users\(id\)/.test(ddlCode), '1 account : 1 customer を PK で保証');
  check(/event_id\s+text\s+PRIMARY KEY/.test(ddlCode), 'stripe event は event_id が PK（冪等化）');
  check(
    (ddlCode.match(/REFERENCES auth\.users\(id\) ON DELETE CASCADE/g) ?? []).length >= 2,
    'user 削除で課金行も追随する FK がある',
  );

  // ★ 未適用であることを明示している（AGENTS §38）。
  check(/適用状態:\s*\*\*未適用\*\*/.test(ddl), 'DDL ヘッダに「未適用」と明記されている');

  // ★ career_accounts に plan 列を足していない（client から改竄可能な cache を作らない）。
  const accountsDdl = stripSqlComments(read('supabase/career_accounts_apply.sql'));
  check(!/\bplan\b/.test(accountsDdl), 'career_accounts に plan 列を追加していない');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [10] 根拠のない paywall を張っていないこと（AGENTS §19）
// ═══════════════════════════════════════════════════════════════
console.log('[10] no ungrounded paywall on existing CAREER features');
{
  // CAREER の料金仕様（有料対象機能）が repo に存在しないため、既存 AI route を
  // 勝手に有料化しない。gate helper は存在するが呼び出しは 0 でなければならない。
  function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
    }
    return out;
  }
  const careerApiFiles = walk(join(ROOT, 'app/api/career')).filter(
    (f) => !f.includes(`${'app/api/career/billing'.split('/').join('/')}`),
  );

  const gated = careerApiFiles.filter((f) =>
    /requireCareerPaidAccess\s*\(/.test(stripComments(readFileSync(f, 'utf8'))),
  );
  check(
    gated.length === 0,
    `既存 CAREER AI route に paywall を適用していない（適用数: ${gated.length}）`,
  );

  // central resolver が存在し、将来の gate の唯一の入口になっていること。
  const ent = stripComments(read('lib/careerBilling/entitlement.ts'));
  check(/export async function requireCareerPaidAccess\(/.test(ent), 'central な paywall guard が用意されている');
  check(/export async function resolveCareerEntitlement\(/.test(ent), 'central な entitlement resolver が用意されている');
  check(/status:\s*402/.test(ent), 'paywall は 402 を返す（client 側 hide だけに依存しない）');
  // fail-closed
  check(/ENTITLEMENT_CHECK_FAILED/.test(ent), '判定不能時は fail-closed（権利を与えない）');
  check(!/return\s*{\s*kind:\s*'ok'[^}]*plan:\s*'premium'/.test(ent), '既定値として premium を返す経路が無い');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
if (failures === 0) {
  console.log('ALL PASS — CAREER auth/billing/entitlement contracts hold.');
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S) — CAREER billing contracts violated.`);
  process.exit(1);
}

/*
 * scripts/career-billing-qa.ts
 *
 * PASSAI CAREER — 認証 / Stripe 課金 / entitlement の QA（dev-only）。
 *
 * 検証:
 *   [1] entitlement policy の unit test（deriveCareerEffectivePlan / 解約予約 / grace）
 *   [2] 単一プラン catalog（server-side Price 解決・受験版 env 名との分離）
 *   [3] Checkout route の security 契約（priceId / userId / customerId を受け取らない）
 *   [4] Portal route の security 契約（body を読まない = 他人 customer を開けない）
 *   [5] Webhook の security / 冪等契約（署名検証が DB より先・専用 secret・event 表）
 *   [6] Project 境界（課金 runtime が Project A の client / table に触れない）
 *   [7] client bundle 安全性（server-only module を 'use client' から import しない）
 *   [8] success ページが到達を根拠に権利を与えないこと
 *   [9] DDL（RLS + GRANT の最小権限・UNIQUE 制約・client 書き込み不可）
 *  [10] cost-bearing な CAREER AI route が **すべて** 有料ゲートを通ること
 *       （2026-08-21 商品決定: guest / 未契約は AI 本実行不可）
 *
 * ★ 実 Stripe / 実 Supabase へ接続しない。env 実値も secret も読まない・表示しない。
 * 使い方: npx tsx scripts/career-billing-qa.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  CAREER_PRICE_ENV_NAME,
  CAREER_SUBSCRIPTION_PLAN_VALUES,
  CAREER_SUBSCRIPTION_PLAN_WRITE_VALUE,
  isCareerSubscriptionPlanValue,
} from '../lib/careerBilling/plans';
import {
  CAREER_SUBSCRIPTION_STATUSES,
  deriveCareerPaidAccess,
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
console.log('[1] entitlement policy (deriveCareerPaidAccess)');
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
  const paid = (rows: CareerSubscriptionRow[]) => deriveCareerPaidAccess(rows, NOW);

  check(paid([]) === false, '契約なし → 権利なし');
  check(paid([row({ status: 'active' })]), 'active → 権利あり');
  check(paid([row({ status: 'trialing' })]), 'trialing → 権利あり');
  // past_due は受験版 policy をそのまま踏襲（dunning 期間中はアクセス維持）。
  check(paid([row({ status: 'past_due' })]), 'past_due → 権利あり（受験版 policy 踏襲）');

  check(!paid([row({ status: 'unpaid' })]), 'unpaid → 権利なし');
  check(!paid([row({ status: 'incomplete' })]), 'incomplete → 権利なし');
  check(!paid([row({ status: 'incomplete_expired' })]), 'incomplete_expired → 権利なし');
  check(!paid([row({ status: 'paused' })]), 'paused → 権利なし');

  // ★ AGENTS §9 / QA Case 16: 解約予約しただけでは即時失効しない。
  check(
    paid([row({ status: 'active', cancel_at_period_end: true, current_period_end: future })]),
    'active + cancel_at_period_end + 期間内 → 期間終了まで権利維持',
  );
  check(
    paid([row({ status: 'canceled', cancel_at_period_end: true, current_period_end: future })]),
    'canceled + 期間内 → grace period として権利維持',
  );
  // ★ QA Case 17: 期間終了後は権利なし。
  check(
    !paid([row({ status: 'canceled', cancel_at_period_end: true, current_period_end: past })]),
    'canceled + 期間終了 → 権利なし',
  );
  check(
    !paid([row({ status: 'canceled', current_period_end: null })]),
    'canceled + period_end なし → 権利なし',
  );
  check(
    !paid([row({ status: 'canceled', current_period_end: 'not-a-date' })]),
    'canceled + 不正な日付 → 権利なし（fail-closed）',
  );

  // 未知の plan 値は権利に数えない（別商品の行が紛れ込んでも通さない）。
  check(!paid([row({ plan: 'attacker' })]), '未知の plan → 権利なし');
  check(!paid([row({ plan: 'free' })]), "plan='free' 行 → 権利なし");

  // ★ 単一プラン化: 旧 basic / 旧 premium いずれの行でも「有効な契約」として同じ扱い。
  //   （historical compatibility。過去 row を production で UPDATE せずに移行する）
  check(paid([row({ plan: 'basic' })]), '旧 basic 行 → 有効な契約として認識される');
  check(paid([row({ plan: 'premium' })]), '旧 premium 行 → 有効な契約として認識される');
  check(
    paid([row({ plan: 'premium', status: 'canceled', current_period_end: past }), row({ plan: 'basic' })]),
    '失効した行 + 有効な行 → 権利あり（行単位で判定）',
  );
  check(
    !paid([
      row({ plan: 'premium', status: 'canceled', current_period_end: past }),
      row({ plan: 'basic', status: 'unpaid' }),
    ]),
    '有効な行が 1 つも無ければ権利なし',
  );

  // ★ tier 判定が復活していないこと（単一プラン化の回帰防止）。
  const policySrc = stripComments(read('lib/careerBilling/entitlementPolicy.ts'));
  check(
    !/PLAN_RANK|careerPlanSatisfies|premium\s*>/.test(policySrc),
    'entitlementPolicy に tier の順位比較が無い（単一プラン）',
  );
  check(
    !/CareerEffectivePlan|deriveCareerEffectivePlan/.test(policySrc),
    '2 段階 plan の導出関数が残っていない',
  );

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
console.log('[2] single plan catalog & Stripe Price env separation');
{
  const plansSrc = stripComments(read('lib/careerBilling/plans.ts'));

  // ★ 単一プラン。tier の型 / catalog が残っていないこと。
  check(
    !/CareerPaidPlanId|CareerEffectivePlan|CAREER_PAID_PLAN_IDS|CAREER_PLANS\b/.test(plansSrc),
    'plans.ts に 2 段階 tier の型 / catalog が残っていない',
  );
  // ★ Price env は **ただ 1 つ**。候補リストや fallback を持たない。
  check(
    CAREER_PRICE_ENV_NAME === 'STRIPE_CAREER_PRICE_ID',
    `CAREER の canonical Price env は STRIPE_CAREER_PRICE_ID（実際: ${CAREER_PRICE_ENV_NAME}）`,
  );
  check(
    !/CAREER_PRICE_ENV_NAMES|CAREER_PRICE_ENV_TO_PLAN_VALUE/.test(plansSrc),
    'plans.ts に複数候補の Price env リストが残っていない',
  );
  // ★ 旧 CAREER env 名を runtime から参照しない（fallback 復活の防止）。
  for (const legacy of ['STRIPE_PRICE_ID_CAREER_BASIC', 'STRIPE_PRICE_ID_CAREER_PREMIUM']) {
    check(!plansSrc.includes(legacy), `plans.ts が旧 env（${legacy}）を参照していない`);
  }
  // ★ 受験版 Price env 名を CAREER の catalog に持ち込んでいないこと（AGENTS §10）。
  check(
    !/STRIPE_PRICE_ID_BASIC\b/.test(plansSrc) && !/STRIPE_PRICE_ID_PREMIUM\b/.test(plansSrc),
    'plans.ts に受験版 Price env 名（STRIPE_PRICE_ID_BASIC/PREMIUM）が無い',
  );
  // 価格・訴求文言を repo 側に持たない（金額は Stripe Price が正本）。
  check(!/priceJpy|3,?000/.test(plansSrc), 'plans.ts に金額をハードコードしていない');
  check(!/process\.env/.test(plansSrc), 'plans.ts は env を読まない（pure constants）');

  // DB の plan 列は既存 CHECK（'basic' / 'premium'）のままで、migration を足していない。
  check(
    CAREER_SUBSCRIPTION_PLAN_VALUES.every((v) => isCareerSubscriptionPlanValue(v)),
    'DB へ書く plan 値が型 guard と一致している',
  );
  check(!isCareerSubscriptionPlanValue('career'), '未知の plan 値は拒否される');
  const ddlCodeForPlan = stripSqlComments(read(DDL));
  for (const v of CAREER_SUBSCRIPTION_PLAN_VALUES) {
    check(
      new RegExp(`'${v}'`).test(ddlCodeForPlan),
      `DDL の plan CHECK が '${v}' を許容している（migration 不要）`,
    );
  }
  check(
    isCareerSubscriptionPlanValue(CAREER_SUBSCRIPTION_PLAN_WRITE_VALUE),
    '新規 subscription へ書く plan 値が DDL 許容値に閉じている',
  );

  // Price 解決は server-only。単一 Price / 逆引き / 受験版誤設定ガード。
  const stripeSrc = stripComments(read('lib/careerBilling/stripe.ts'));
  check(
    /export function getCareerCanonicalPrice/.test(stripeSrc),
    'Checkout に使う canonical price は 1 本だけ解決する',
  );
  // ★ env lookup は 1 箇所・1 変数だけ。候補を順に探す実装を復活させない。
  const careerEnvReads = [...stripeSrc.matchAll(/process\.env\[?([A-Za-z_.]*)/g)].map((m) => m[1]);
  check(
    /process\.env\[CAREER_PRICE_ENV_NAME\]/.test(stripeSrc),
    'Price env は CAREER_PRICE_ENV_NAME から 1 回だけ読む',
  );
  check(
    !/for \(const envName of|listConfiguredCareerPrices/.test(stripeSrc),
    'Price env の候補ループが残っていない（fallback なし）',
  );
  for (const legacy of ['STRIPE_PRICE_ID_CAREER_BASIC', 'STRIPE_PRICE_ID_CAREER_PREMIUM']) {
    check(!stripeSrc.includes(legacy), `stripe.ts が旧 env（${legacy}）を参照していない`);
  }
  // ★ 受験版 env へ fallback しない（誤設定検知としてだけ参照する）。
  check(
    /EXAM_PRICE_ENV_NAMES/.test(stripeSrc) &&
      !/process\.env\.STRIPE_PRICE_ID_(BASIC|PREMIUM)\s*(\|\||\?\?)/.test(stripeSrc),
    '受験版 Price env へ fallback する経路が無い',
  );
  void careerEnvReads;
  check(
    /export function resolveCareerPlanValueFromPriceId/.test(stripeSrc),
    'CAREER 専用の Price → plan 値 逆引きが存在する（他商品の subscription を弾く）',
  );
  check(
    !/CareerPaidPlanId|listCareerPlanOffers|retrieveCareerPlanPrice/.test(stripeSrc),
    'stripe.ts に tier 前提の API が残っていない',
  );
  check(
    /EXAM_PRICE_ENV_NAMES/.test(stripeSrc),
    '受験版 Price ID の誤設定を検知するガードがある',
  );
  check(
    /kind: 'unconfigured'/.test(stripeSrc),
    'Price env 未設定は unconfigured（fail-closed。既定 price へ fallback しない）',
  );
  check(
    /if \(!value\) return null;/.test(stripeSrc),
    'env 未設定は null（他の env を探しに行かない）',
  );
  const checkoutSrc = stripComments(read(CHECKOUT));
  check(
    /BILLING_UNCONFIGURED/.test(checkoutSrc) && /503/.test(checkoutSrc),
    'Price env 未設定なら checkout は 503 BILLING_UNCONFIGURED（fail-closed）',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [3] Checkout route の security 契約
// ═══════════════════════════════════════════════════════════════
console.log('[3] checkout route security contract');
{
  const src = stripComments(read(CHECKOUT));

  // ★ 単一プラン: body を **一切読まない**（client は plan も price も選べない）。
  check(!/req\.json\(\)/.test(src), 'checkout は request body を読まない');
  check(!/\bbody\b/.test(src), 'checkout に body 由来の値が存在しない');
  // ★ QA Case 8 / 9: 任意 priceId / userId / customerId / plan の注入経路が無い。
  for (const forbidden of ['priceId', 'price_id', 'customerId', 'customer_id', 'userId', 'user_id', 'premium', 'plan']) {
    check(
      !new RegExp(`body[^\\n]*\\b${forbidden}\\b`).test(src),
      `body から ${forbidden} を読まない`,
    );
  }
  check(
    !/isCareerPaidPlanId|INVALID_PLAN/.test(src),
    'plan 選択の入口が残っていない（単一プラン）',
  );
  // priceId は env → server 解決 → Stripe 実物照合、の順でのみ決まる。
  // （retrieveCareerPrice が内部で canonical price env を読み、livemode まで検証する）
  check(
    /retrieveCareerPrice\(\)/.test(src),
    'priceId は server が env から解決する（引数を取らない / livemode 検証つき）',
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
  check(/state\.snapshot\.paid/.test(src), '重複契約判定は server 導出の paid フラグを使う');
  // webhook との契約キー。
  check(
    /subscription_data/.test(src) && /CAREER_METADATA_USER_ID_KEY/.test(src),
    'subscription_data.metadata に app_user_id を必ず設定する',
  );
  check(/success_url/.test(src) && /cancel_url/.test(src), 'success_url / cancel_url を設定する');
  check(/\/career\/billing\/success/.test(src), 'success_url は CAREER 名前空間内');
  // fail-closed
  check(/isCareerBillingConfigured\(\)/.test(src), 'Price 未設定なら 503（fail-closed。売らない）');
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

  // client 側 CTA は body を一切送らない（単一プランなので選ぶものが無い）。
  const btn = stripComments(read('app/career/components/CareerCheckoutButton.tsx'));
  check(
    !/JSON\.stringify/.test(btn) && !/\bbody:/.test(btn),
    'CTA は checkout に body を送らない（plan / price を client が選べない）',
  );
  check(!/priceId|customerId|price_/.test(btn), 'CTA は priceId / customerId を送らない');
  // ★ QA Case 5: open redirect 防止（認証画面への戻り先は CAREER 相対 path 固定）。
  //   未ログインの申し込みは新規登録（/career/register）へ送る（既存ログインとは UI を分ける）。
  check(
    /\$\{CAREER_ROUTES\.register\}\?redirect=\$\{encodeURIComponent\(next\)\}/.test(btn),
    '認証画面への戻り先は encodeURIComponent 済みの CAREER 相対 path',
  );
  check(
    /CAREER_ROUTES\.register/.test(btn) && !/'\/career\/login'/.test(btn),
    '未ログインの申し込みは登録画面（canonical 定数）へ送る',
  );
  check(
    /const next = `\/career\/billing\?\$\{CHECKOUT_RESUME_PARAM\}=1`/.test(btn),
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

  // ★ provisioning 状態を必ず明示していること（AGENTS §38）。
  //   「未適用」「適用済み」のどちらかを書く。状態が変わったらヘッダも更新する運用なので、
  //   ここでは「どちらか一方が明記されている」ことと、適用主体が operator であることを固定する。
  //   （2026-08-21 の read-only probe で Project B に適用済みであることを確認）。
  check(
    /適用状態:\s*\*\*(未適用|適用済み)\*\*/.test(ddl),
    'DDL ヘッダに provisioning 状態（未適用 / 適用済み）が明記されている',
  );
  check(
    /Claude Code からは本番 DB へ適用しない/.test(ddl),
    'DDL の適用主体が operator であることを明記している',
  );

  // ★ career_accounts に plan 列を足していない（client から改竄可能な cache を作らない）。
  const accountsDdl = stripSqlComments(read('supabase/career_accounts_apply.sql'));
  check(!/\bplan\b/.test(accountsDdl), 'career_accounts に plan 列を追加していない');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// [10] cost-bearing な CAREER AI route が **すべて** 有料ゲートを通ること
//
//   ★ 2026-08-21 の商品決定により、旧仕様（guest 利用を正式に許可 / paywall 適用数 0）は
//     廃止された。PASSAI CAREER は単一の有料プランで、AI 本実行は契約者のみ。
//   ★ paid gate と quota unit は別概念:
//       paid gate … AI 原価が発生する **すべての** route
//       quota     … 商品仕様で決めた 8 anchor だけ
//     したがって quota を消費しない subflow（ES 深掘り / 面接 turn / GD AI 発言 …）にも
//     gate は必要。
// ═══════════════════════════════════════════════════════════════
console.log('[10] every cost-bearing CAREER AI route is behind the paid gate');
{
  /** Anthropic / OpenAI など課金 API を実行する CAREER route（正本）。 */
  const COST_BEARING_ROUTES = [
    'app/api/career/self-analysis/route.ts',
    'app/api/career/self-analysis/question/route.ts',
    'app/api/career/company-research/route.ts',
    'app/api/career/company-research/extract/route.ts',
    'app/api/career/consultation/route.ts',
    'app/api/career/es-review/route.ts',
    'app/api/career/es/deep/route.ts',
    'app/api/career/es/materials/route.ts',
    'app/api/career/es/organize/route.ts',
    'app/api/career/interview/start/route.ts',
    'app/api/career/interview/turn/route.ts',
    'app/api/career/interview/complete/route.ts',
    'app/api/career/presentation/theme/route.ts',
    'app/api/career/presentation/evaluate/route.ts',
    'app/api/career/presentation/qa/route.ts',
    'app/api/career/gd/theme/route.ts',
    'app/api/career/gd/turn/route.ts',
    'app/api/career/gd/feedback/route.ts',
    'app/api/career/gd/room/[roomId]/ai-turn/route.ts',
    'app/api/career/gd/room/[roomId]/result/route.ts',
    'app/api/career/matching/route.ts',
  ];
  const GATE = /requireCareerAiAccess(ForUser)?\s*\(/;

  for (const rel of COST_BEARING_ROUTES) {
    if (!existsSync(join(ROOT, rel))) {
      check(false, `${rel} が存在する`);
      continue;
    }
    const routeSrc = stripImports(stripComments(read(rel)));
    const postAt = routeSrc.search(/export async function POST/);
    const post = postAt >= 0 ? routeSrc.slice(postAt) : routeSrc;

    const gateAt = post.search(GATE);
    check(gateAt >= 0, `${rel}: 有料ゲートを通る`);
    if (gateAt < 0) continue;

    // ★ AI 到達前。
    const aiAt = post.search(
      /anthropic\.messages\.create|handleSelfAnalysisJobPost|generateRoomFeedback|generateCareerGdSummary|buildGdAiTurn|runAiTurn/,
    );
    check(aiAt < 0 || gateAt < aiAt, `${rel}: 有料ゲートは AI 実行より前`);

    // ★ Quota より前（未契約者に quota を消費させない）。
    const quotaAt = post.search(/enforceCareerDailyQuota\s*\(/);
    check(quotaAt < 0 || gateAt < quotaAt, `${rel}: 有料ゲートは Daily Quota consume より前`);

    // ★ identity は server 側で解決したものだけを渡す（client 申告値を渡さない）。
    check(
      /requireCareerAiAccess\(guard\.identity\)|requireCareerAiAccessForUser\(auth\.userId\)/.test(post),
      `${rel}: gate へ渡す identity は server 解決値`,
    );
  }

  // gate helper 自体の契約。
  const gateSrc = stripComments(read('lib/careerBilling/aiAccess.ts'));
  check(/import 'server-only';/.test(gateSrc), 'aiAccess は server-only');
  check(
    /identity\.kind !== 'member'/.test(gateSrc) && /loginRequiredResponse\(\)/.test(gateSrc),
    'guest は 401 LOGIN_REQUIRED（AI 実行前に終了）',
  );
  const ent = stripComments(read('lib/careerBilling/entitlement.ts'));
  check(/status:\s*402/.test(ent), '未契約は 402 PAYMENT_REQUIRED');
  check(
    /export async function requireCareerPaidAccessForUser/.test(ent),
    'server 解決済み userId 用の gate がある（auth.getUser を 2 回叩かない）',
  );
  // ★ fail-closed: 判定不能で AI を通さない。
  check(/BILLING_NOT_PROVISIONED/.test(ent), 'billing DDL 未適用なら reject（fail-closed）');
  check(/ENTITLEMENT_CHECK_FAILED/.test(ent), 'DB エラーなら reject（fail-closed）');
  check(
    !/return\s*\{\s*kind:\s*'ok'[^}]*\}\s*;?\s*\/\/\s*fail-open/.test(ent),
    'fail-open で権利を与える経路が無い',
  );
  // ★ tier 引数が復活していないこと。
  check(
    !/requireCareerPaidAccess\(\s*required/.test(ent) && !/CareerPaidPlanId/.test(ent),
    'paid gate に tier 引数が無い（単一プラン）',
  );

  // ★ guest を許可すると明言していた旧コメントが残っていないこと（仕様の二重化を防ぐ）。
  for (const rel of [
    'lib/careerApi/requestGuard.ts',
    'app/api/career/es/requestGuard.ts',
    'app/api/career/interview/requestGuard.ts',
    'app/api/career/presentation/requestGuard.ts',
  ]) {
    const src = read(rel);
    check(
      !/guest 利用を正式に許可(した|している)/.test(src) && !/401 では閉じない/.test(src),
      `${rel}: 旧仕様（guest に AI を許可）の記述が残っていない`,
    );
    check(
      /有料ゲート|requireCareerAiAccess/.test(src),
      `${rel}: 有料ゲートが後段にあることを明記している`,
    );
  }
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

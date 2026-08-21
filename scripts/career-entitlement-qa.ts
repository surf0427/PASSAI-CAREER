/*
 * scripts/career-entitlement-qa.ts
 *
 * PASSAI CAREER — 有料 entitlement（単一プラン）の QA（dev-only / 実 DB・実 Stripe 非接続）。
 *
 * 商品仕様（2026-08-21 決定）:
 *   PASSAI CAREER は単一の有料プラン。AI 本実行は **有効な契約を持つ member だけ**。
 *
 * 検証:
 *   [1] status 別の権利マトリクス（guest / 未契約 / active / trialing / past_due /
 *       cancel_at_period_end / canceled / expired / incomplete / paused）
 *   [2] 実行順序 — request guard → 有料ゲート → Daily Quota → AI → settle
 *   [3] 未契約 / guest は **Quota を消費しない**（entitlement reject が quota より前）
 *   [4] cost-bearing route の網羅（AI を呼ぶ route に gate 抜けが無い）
 *   [5] 単一プラン化の回帰防止（tier 分岐・plan 選択 UI・client Price 指定が無い）
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-entitlement-qa.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
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

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}
function stripImports(src: string): string {
  return src.replace(/^import[\s\S]*?;\s*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** AI 課金 API を実行する CAREER route（正本）。gate 抜けの検出に使う。 */
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

const NOW = Date.UTC(2026, 0, 15);
const FUTURE = new Date(NOW + 30 * 86400_000).toISOString();
const PAST = new Date(NOW - 30 * 86400_000).toISOString();

const row = (over: Partial<CareerSubscriptionRow>): CareerSubscriptionRow => ({
  plan: 'basic',
  status: 'active',
  current_period_end: FUTURE,
  cancel_at_period_end: false,
  ...over,
});

// ═══════════════════════════════════════════════════════════════
console.log('[1] entitlement matrix（status 別の AI アクセス可否）');
{
  const CASES: Array<{ label: string; rows: CareerSubscriptionRow[]; expect: boolean }> = [
    { label: 'ログイン済み・契約なし', rows: [], expect: false },
    { label: 'active', rows: [row({ status: 'active' })], expect: true },
    { label: 'trialing', rows: [row({ status: 'trialing' })], expect: true },
    { label: 'past_due（dunning 猶予・既存 policy 踏襲）', rows: [row({ status: 'past_due' })], expect: true },
    {
      label: 'cancel_at_period_end + 期間内',
      rows: [row({ status: 'active', cancel_at_period_end: true, current_period_end: FUTURE })],
      expect: true,
    },
    {
      label: 'canceled + 期間内（grace）',
      rows: [row({ status: 'canceled', cancel_at_period_end: true, current_period_end: FUTURE })],
      expect: true,
    },
    {
      label: 'canceled + 期間終了（expired）',
      rows: [row({ status: 'canceled', current_period_end: PAST })],
      expect: false,
    },
    { label: 'unpaid', rows: [row({ status: 'unpaid' })], expect: false },
    { label: 'incomplete', rows: [row({ status: 'incomplete' })], expect: false },
    { label: 'incomplete_expired', rows: [row({ status: 'incomplete_expired' })], expect: false },
    { label: 'paused', rows: [row({ status: 'paused' })], expect: false },
  ];
  for (const c of CASES) {
    check(
      deriveCareerPaidAccess(c.rows, NOW) === c.expect,
      `${c.label} → AI ${c.expect ? 'ALLOW' : 'BLOCK'}`,
    );
  }

  // guest は identity 段階で弾かれる（DB を見るまでもない）。
  const gate = stripComments(read('lib/careerBilling/aiAccess.ts'));
  check(
    /identity\.kind !== 'member'/.test(gate) && /loginRequiredResponse\(\)/.test(gate),
    'guest → AI BLOCK（401 LOGIN_REQUIRED / DB へ行く前に終了）',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[2] 実行順序 & [3] 未契約は Quota を消費しない（pipeline シミュレーション）');
{
  // route の実際の順序を模した最小 harness。
  //   guard（identity 解決）→ 有料ゲート → Daily Quota → AI → settle
  type Identity = { kind: 'member'; userId: string } | { kind: 'guest' };
  type Trace = string[];

  function paidGate(identity: Identity, rowsOf: (u: string) => CareerSubscriptionRow[]): 'ok' | 401 | 402 {
    if (identity.kind !== 'member') return 401;
    return deriveCareerPaidAccess(rowsOf(identity.userId), NOW) ? 'ok' : 402;
  }

  function runRoute(
    identity: Identity,
    rowsOf: (u: string) => CareerSubscriptionRow[],
    quotaRemaining: number,
  ): { status: number; trace: Trace } {
    const trace: Trace = [];
    trace.push('guard');
    const gate = paidGate(identity, rowsOf);
    trace.push('paid-gate');
    if (gate !== 'ok') return { status: gate, trace };
    trace.push('quota-consume');
    if (quotaRemaining <= 0) return { status: 429, trace };
    trace.push('ai');
    trace.push('quota-settle');
    return { status: 200, trace };
  }

  const noRows = () => [];
  const activeRows = () => [row({ status: 'active' })];
  const expiredRows = () => [row({ status: 'canceled', current_period_end: PAST })];

  const guest = runRoute({ kind: 'guest' }, noRows, 10);
  check(guest.status === 401, 'guest → 401');
  check(!guest.trace.includes('quota-consume'), 'guest → Quota を消費しない');
  check(!guest.trace.includes('ai'), 'guest → AI を実行しない');

  const unpaid = runRoute({ kind: 'member', userId: 'u1' }, noRows, 10);
  check(unpaid.status === 402, 'ログイン済み未契約 → 402');
  check(!unpaid.trace.includes('quota-consume'), '未契約 → Quota を消費しない');
  check(!unpaid.trace.includes('ai'), '未契約 → AI を実行しない');

  const expired = runRoute({ kind: 'member', userId: 'u1' }, expiredRows, 10);
  check(expired.status === 402, '契約失効 → 402');
  check(!expired.trace.includes('quota-consume'), '契約失効 → Quota を消費しない');

  const paid = runRoute({ kind: 'member', userId: 'u1' }, activeRows, 10);
  check(paid.status === 200, '契約中 → ALLOW');
  check(
    paid.trace.join('>') === 'guard>paid-gate>quota-consume>ai>quota-settle',
    `契約中の順序が guard → paid gate → quota → AI → settle（実測: ${paid.trace.join(' > ')}）`,
  );

  const over = runRoute({ kind: 'member', userId: 'u1' }, activeRows, 0);
  check(over.status === 429, '契約中 + 上限到達 → 429');
  check(!over.trace.includes('ai'), '上限到達 → AI を実行しない');
  check(over.trace.includes('paid-gate'), '上限到達時も有料ゲートは通過済み（順序が逆でない）');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[4] cost-bearing route の網羅（gate 抜けが無い）');
{
  const GATE = /requireCareerAiAccess(ForUser)?\s*\(/;
  const AI = /anthropic|openai/i;

  for (const rel of COST_BEARING_ROUTES) {
    if (!existsSync(join(ROOT, rel))) {
      check(false, `${rel} が存在する`);
      continue;
    }
    const src = stripImports(stripComments(read(rel)));
    const postAt = src.search(/export async function POST/);
    const post = postAt >= 0 ? src.slice(postAt) : src;
    const gateAt = post.search(GATE);
    const quotaAt = post.search(/enforceCareerDailyQuota\s*\(/);
    check(gateAt >= 0, `${rel}: 有料ゲートあり`);
    check(quotaAt < 0 || (gateAt >= 0 && gateAt < quotaAt), `${rel}: gate は quota より前`);
  }

  // ★ 一覧の網羅性そのものを検査する: AI を呼ぶ route が一覧から漏れていないこと。
  const declared = new Set(COST_BEARING_ROUTES);
  const missed: string[] = [];
  for (const abs of walk(join(ROOT, 'app/api/career'))) {
    if (!abs.endsWith('route.ts')) continue;
    const rel = abs.slice(ROOT.length + 1);
    if (rel.startsWith('app/api/career/billing/')) continue;
    const src = stripComments(readFileSync(abs, 'utf8'));
    if (!AI.test(src)) continue;
    if (!declared.has(rel) && !GATE.test(src)) missed.push(rel);
  }
  check(
    missed.length === 0,
    `AI を呼ぶ route に gate 抜けが無い（漏れ ${missed.length}${missed.length ? ': ' + missed.join(', ') : ''}）`,
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[5] 単一プラン化の回帰防止');
{
  // runtime に tier 分岐が残っていないこと（型・関数・定数）。
  const TIER_TOKENS =
    /CareerPaidPlanId|CareerEffectivePlan|CAREER_PAID_PLAN_IDS|CAREER_PLANS\b|careerPlanSatisfies|deriveCareerEffectivePlan|hasCareerPaidAccess|CAREER_PLAN_LIMITS|getCareerFeatureLimit/;
  const scanned = [
    ...walk(join(ROOT, 'lib/careerBilling')),
    ...walk(join(ROOT, 'lib/careerAi')),
    ...walk(join(ROOT, 'app/api/career')),
  ];
  const tierHits = scanned
    .map((f) => f.slice(ROOT.length + 1))
    .filter((rel) => TIER_TOKENS.test(stripComments(read(rel))));
  check(
    tierHits.length === 0,
    `runtime に 2 段階 tier の参照が無い（残 ${tierHits.length}${tierHits.length ? ': ' + tierHits.join(', ') : ''}）`,
  );
  check(
    !existsSync(join(ROOT, 'lib/careerAi/usage.ts')),
    '旧 tier 別上限テーブル（lib/careerAi/usage.ts）を削除した',
  );

  // client が plan / price を選べないこと。
  const btn = stripComments(read('app/career/components/CareerCheckoutButton.tsx'));
  check(!/plan/.test(btn), 'Checkout CTA に plan の概念が残っていない');
  check(!/priceId|price_/.test(btn), 'Checkout CTA は priceId を扱わない');
  const page = stripComments(read('app/career/billing/page.tsx'));
  check(!/premium|basic/i.test(page), 'プラン比較 UI（basic / premium）が残っていない');
  check(!/grid gap-4 sm:grid-cols-2/.test(page), '2 プラン並列のグリッドが残っていない');

  // upgrade / downgrade の独自 UI が無い。Customer Portal は維持する。
  const portalRoute = 'app/api/career/billing/portal/route.ts';
  check(existsSync(join(ROOT, portalRoute)), 'Customer Portal（解約・支払方法・請求書）は維持されている');
  const uiFiles = [...walk(join(ROOT, 'app/career'))].map((f) => f.slice(ROOT.length + 1));
  const upgradeHits = uiFiles.filter((rel) =>
    /アップグレード|ダウングレード|プラン変更|upgrade|downgrade/i.test(stripComments(read(rel))),
  );
  check(
    upgradeHits.length === 0,
    `upgrade / downgrade の独自 UI が無い（残 ${upgradeHits.length}${upgradeHits.length ? ': ' + upgradeHits.join(', ') : ''}）`,
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
if (failures === 0) {
  console.log('ALL PASS — CAREER single-plan entitlement contracts hold.');
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S) — CAREER entitlement contracts violated.`);
  process.exit(1);
}

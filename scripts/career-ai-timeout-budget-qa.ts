/*
 * scripts/career-ai-timeout-budget-qa.ts
 *
 * PASSAI CAREER — AI 呼び出しの時間予算 QA（STEP-API-TIMEOUT-02）。
 *
 * 目的:
 *   1. lib/aiTimeout.ts の createAiCallBudget を fake clock で決定論検証する
 *      （実 Claude API も実 sleep も使わない）。
 *   2. career の AI route が「retry を含む worst case の合計 AI 時間」を
 *      **それを囲む境界（Vercel maxDuration / client の AbortController）より内側**に
 *      収めていることを静的に検証する（regression guard）。
 *
 * 背景（この QA が守っている不変条件）:
 *   parse 失敗 retry を持つ route は attempt ごとに満額の timeout signal を再発行していた。
 *   worst case は per-call × attempt 数になるが、囲む境界はいずれも 1 attempt 分の値で
 *   設計されていたため、retry が走ると外側が先に切れ、ユーザーには JSON エラーではなく
 *   504（非JSON）や "Load failed" 相当の汎用失敗が見えていた（bf6d0e5 と同じ不具合クラス）。
 *
 * 使い方:  npx tsx scripts/career-ai-timeout-budget-qa.ts
 * 終了コード: 全 PASS → 0 / 1 件でも FAIL → 1。
 *
 * dev-only。next build には含まれない。
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { AI_BUDGET_PRESET_80S_WALL, createAiCallBudget } from '../lib/aiTimeout';

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

/** 手動で進められる fake clock（実 sleep を一切しない）。 */
function fakeClock(startMs = 1_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// ─────────────────────────────────────────────────────────────────────
// Part A — createAiCallBudget の振る舞い（fake clock）
// ─────────────────────────────────────────────────────────────────────
console.log('\n[A] createAiCallBudget — 時間予算の振る舞い（fake clock / 実 API 無し）');

// S1: 通常の高速応答 — 1 回目は満額、retry も満額もらえる。
{
  const c = fakeClock();
  const b = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL, now: c.now });
  eq('S1 初回 attempt は per-call 満額 60s', b.nextCallTimeoutMs(), 60_000);
  c.advance(5_000); // 5s で応答したが parse 失敗
  eq('S1 5s 経過後の retry も per-call 満額 60s', b.nextCallTimeoutMs(), 60_000);
}

// S2: 遅いが正当な応答 — per-call 内なら予算は殺さない。
{
  const c = fakeClock();
  const b = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL, now: c.now });
  const first = b.nextCallTimeoutMs();
  check('S2 55s の正当な応答は初回 timeout(60s) 内に収まる', first !== null && first >= 55_000);
  c.advance(55_000);
  eq('S2 55s 経過（残 19s < minRetry 30s）→ retry しない', b.nextCallTimeoutMs(), null);
}

// S3: 本当にハングした場合 — 有界であること。
{
  const c = fakeClock();
  const b = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL, now: c.now });
  const first = b.nextCallTimeoutMs();
  check('S3 初回 timeout は per-call 上限を超えない', first !== null && first <= 60_000);
  c.advance(60_000); // 初回が満額 abort
  eq('S3 abort 後は残予算不足で retry しない（無限待ちなし）', b.nextCallTimeoutMs(), null);
}

// S4: retry 可能な一時失敗 — 予算が残っていれば retry を許す。
{
  const c = fakeClock();
  const b = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL, now: c.now });
  b.nextCallTimeoutMs();
  c.advance(20_000);
  eq('S4 20s 経過（残 54s ≥ minRetry）→ retry 許可・残予算で clamp', b.nextCallTimeoutMs(), 54_000);
}

// S5: retry 不可 — 残予算が minRetry を下回れば null（呼び出し側は即エラー返却）。
{
  const c = fakeClock();
  const b = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL, now: c.now });
  b.nextCallTimeoutMs();
  c.advance(50_000); // 残 24s < minRetry 30s
  eq('S5 残 24s < minRetry 30s → retry せず null', b.nextCallTimeoutMs(), null);
}

// S6: 予算を使い切った後 — 初回であっても null（呼び出しを始めない）。
{
  const c = fakeClock();
  const b = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL, now: c.now });
  c.advance(80_000); // 準備段階で予算超過（想定外の遅延）
  eq('S6 予算超過後は初回でも null（新規 AI 呼び出しをしない）', b.nextCallTimeoutMs(), null);
}

// S7: 長い context で latency が伸びても worst case は totalBudget を超えない。
{
  const c = fakeClock();
  const b = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL, now: c.now });
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const ms = b.nextCallTimeoutMs();
    if (ms === null) break;
    total += ms;
    c.advance(ms); // 各 attempt が満額 abort する最悪ケース
  }
  check(
    'S7 全 attempt が満額 abort しても合計 ≤ totalBudget(74s)',
    total <= AI_BUDGET_PRESET_80S_WALL.totalBudgetMs,
    `total=${total}`,
  );
}

// 境界: minRetryBudgetMs ちょうどは retry 可（< で判定していること）。
{
  const c = fakeClock();
  const b = createAiCallBudget({ totalBudgetMs: 74_000, perCallTimeoutMs: 60_000, minRetryBudgetMs: 30_000, now: c.now });
  b.nextCallTimeoutMs();
  c.advance(44_000); // 残ちょうど 30_000
  eq('境界 残 == minRetry は retry 可', b.nextCallTimeoutMs(), 30_000);
}

// elapsedMs は観測用に単調増加する。
{
  const c = fakeClock();
  const b = createAiCallBudget({ ...AI_BUDGET_PRESET_80S_WALL, now: c.now });
  eq('elapsedMs 初期値は 0', b.elapsedMs(), 0);
  c.advance(1_234);
  eq('elapsedMs は経過を反映', b.elapsedMs(), 1_234);
}

// ─────────────────────────────────────────────────────────────────────
// Part B — route の時間予算契約（静的検証 / regression guard）
// ─────────────────────────────────────────────────────────────────────
console.log('\n[B] career AI route の時間予算契約（worst case ≤ 囲む境界）');

interface RouteContract {
  file: string;
  /** worst case の合計 AI 時間（ms）。route が宣言している予算。 */
  worstCaseTotalMs: number;
  /** 囲む境界（ms）と、その出所。 */
  boundMs: number;
  boundSource: string;
  /** 境界に対して残すべき最低余白（auth/DB/parse/response のオーバーヘッド分）。 */
  minMarginMs: number;
}

const WALL_80S = 80_000;
const PRESET_TOTAL = AI_BUDGET_PRESET_80S_WALL.totalBudgetMs; // 74_000

// 予算方式で修正した route（preset 使用）。
const PRESET_ROUTES = [
  'app/api/career/company-research/route.ts',
  'app/api/career/consultation/route.ts',
  'app/api/career/es-review/route.ts',
  'app/api/career/es/organize/route.ts',
  'app/api/career/gd/theme/route.ts',
  'app/api/career/gd/room/roomFeedback.ts',
  'app/api/career/interview/complete/route.ts',
  'app/api/career/interview/turn/route.ts',
  'app/api/career/presentation/qa/route.ts',
];

// bf6d0e5 で route-local に修正済みの 3 route（TOTAL_BUDGET_MS を自前で持つ）。
const LOCAL_BUDGET_ROUTES = [
  'app/api/career/matching/route.ts',
  'app/api/career/presentation/evaluate/route.ts',
  'app/api/career/gd/feedback/route.ts',
];

const CONTRACTS: RouteContract[] = [
  ...PRESET_ROUTES.map((file) => ({
    file,
    worstCaseTotalMs: PRESET_TOTAL,
    // roomFeedback は route ではなく helper。境界は呼び出し元 result route の maxDuration=80。
    boundMs: WALL_80S,
    boundSource: file.endsWith('roomFeedback.ts')
      ? 'caller app/api/career/gd/room/[roomId]/result/route.ts maxDuration=80'
      : 'maxDuration=80',
    minMarginMs: 5_000,
  })),
  ...LOCAL_BUDGET_ROUTES.map((file) => ({
    file,
    worstCaseTotalMs: 74_000,
    boundMs: WALL_80S,
    boundSource: 'maxDuration=80',
    minMarginMs: 5_000,
  })),
  {
    // client 側 AbortController が実効的な外側境界（run/page.tsx QUESTION_TIMEOUT_MS）。
    file: 'app/api/career/self-analysis/question/route.ts',
    worstCaseTotalMs: 30_000,
    boundMs: 35_000,
    boundSource: 'client QUESTION_TIMEOUT_MS=35s (app/career/self-analysis/run/page.tsx)',
    minMarginMs: 5_000,
  },
  {
    file: 'app/api/career/self-analysis/route.ts',
    worstCaseTotalMs: 60_000,
    boundMs: 70_000,
    boundSource: 'client GENERATE_TIMEOUT_MS=70s (app/career/self-analysis/run/page.tsx)',
    minMarginMs: 5_000,
  },
  {
    file: 'app/api/career/es/deep/route.ts',
    worstCaseTotalMs: 45_000,
    boundMs: WALL_80S,
    boundSource: 'maxDuration=80',
    minMarginMs: 5_000,
  },
  {
    // ES 深掘りの「材料候補 × 設問」関連判定（Material Selection V1 で追加）。
    // route-local 予算は es/deep と同一ポリシー（per-call 30s / total 45s / minRetry 12s）。
    // 関連判定は候補ラベルのみ・max_tokens 900 と軽く、深掘り質問と同じ予算方針に揃えてある。
    file: 'app/api/career/es/materials/route.ts',
    worstCaseTotalMs: 45_000,
    boundMs: WALL_80S,
    boundSource: 'maxDuration=80',
    minMarginMs: 5_000,
  },
];

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

for (const c of CONTRACTS) {
  const src = read(c.file);
  const label = c.file.replace('app/api/career/', '');

  // 1. worst case が囲む境界より内側で、かつ十分な余白があること。
  check(
    `${label}: worst case ${c.worstCaseTotalMs / 1000}s ≤ ${c.boundSource} − ${c.minMarginMs / 1000}s`,
    c.worstCaseTotalMs + c.minMarginMs <= c.boundMs,
  );

  // 2. retry loop を持つなら、必ず予算から timeout を導出していること
  //    （満額 signal の再発行＝不具合パターンの再混入を検出する）。
  const hasRetryLoop = /for \(let attempt = 1; attempt <= 2; attempt\+\+\)/.test(src);
  if (hasRetryLoop) {
    const usesBudget =
      /createAiCallBudget\(/.test(src) || /TOTAL_BUDGET_MS/.test(src);
    check(`${label}: retry loop が時間予算を使っている`, usesBudget);

    // 予算由来の変数から signal を作っているか（引数なし／固定リテラルは不可）。
    const budgetDerivedSignal =
      /createTimeoutSignal\((callTimeoutMs|aiBudget[^)]*)\)/.test(src);
    check(`${label}: retry loop の signal が残予算由来`, budgetDerivedSignal);

    // 残予算不足時に retry せず打ち切る分岐があること。
    const hasGiveUpBranch =
      /callTimeoutMs === null/.test(src) || /remainingMs < MIN_RETRY_BUDGET_MS/.test(src);
    check(`${label}: 残予算不足時に retry せず打ち切る分岐がある`, hasGiveUpBranch);
  }
}

// 3. 予算 preset を使う route が、preset を実際に import していること。
for (const file of PRESET_ROUTES) {
  const src = read(file);
  check(
    `${file.replace('app/api/career/', '')}: AI_BUDGET_PRESET_80S_WALL を使用`,
    /AI_BUDGET_PRESET_80S_WALL/.test(src),
  );
}

// 4. client 側の境界値が契約どおりであること（片側だけ変更されるドリフトを検出）。
{
  const page = read('app/career/self-analysis/run/page.tsx');
  check(
    'client QUESTION_TIMEOUT_MS = 35_000（server 合計 30s の外側）',
    /const QUESTION_TIMEOUT_MS = 35_000;/.test(page),
  );
  check(
    'client GENERATE_TIMEOUT_MS = 70_000（server 合計 60s の外側）',
    /const GENERATE_TIMEOUT_MS = 70_000;/.test(page),
  );
}

// 5. 網羅性: retry loop を持つ career route が契約表から漏れていないこと。
{
  const out = execSync(
    `grep -rl "for (let attempt = 1; attempt <= 2; attempt++)" app/api/career --include="*.ts" || true`,
    { cwd: ROOT, encoding: 'utf8' },
  );
  const found = out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
  const covered = new Set(CONTRACTS.map((c) => c.file));
  const missing = found.filter((f) => !covered.has(f));
  check(
    `網羅性: retry loop を持つ career route ${found.length} 件がすべて契約表にある`,
    missing.length === 0,
    missing.length ? `未カバー: ${missing.join(', ')}` : '',
  );
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n結果: PASS ${passes} / FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);

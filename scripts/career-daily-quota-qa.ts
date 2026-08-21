/*
 * scripts/career-daily-quota-qa.ts
 *
 * PASSAI CAREER — 機能別 1 日利用回数上限（daily quota）の QA（dev-only / 実 DB 非接続）。
 *
 * 検証:
 *   [1] 上限マトリクス（商品仕様値そのもの）と canonical feature key
 *   [2] JST（Asia/Tokyo）の 1 日境界 — 23:59:59 / 00:00:00 / リセット時刻
 *   [3] operation identity — 同一入力の dedupe / key 順序非依存 / 時間 bucket
 *   [4] consume の状態機械（SQL と同一意味の reference 実装）
 *        - Boundary: limit-1 ALLOW / limit ALLOW / limit+1 BLOCK（全 7 feature）
 *        - Multi-call dedup: ES / 自己分析 / 面接 / プレゼン / GD の 1 ワークフロー = 1 消費
 *        - Cross-feature isolation
 *        - Concurrency: 残り 1 に 20 並列 → ALLOW=1 / REJECT=19 / 最終 count=limit
 *        - Day reset: JST 日付が変われば 0 から
 *   [5] DDL 契約（原子性・JST・RLS/GRANT 最小権限・client 書き込み不可・EXECUTE 制限）
 *   [6] route 配線契約（anchor だけが消費 / guard の後 / AI の前 / 数値の直書き禁止）
 *   [7] security（client 申告の plan / userId / feature / limit を信用しない）
 *   [8] 非退行（既存 burst rate limit / Stripe / prompt / model に触れていない）
 *
 * 使い方: npx tsx scripts/career-daily-quota-qa.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAREER_BASIC_DAILY_LIMITS,
  CAREER_DAILY_QUOTA_DEDUPE_WINDOW_SECONDS,
  CAREER_DAILY_QUOTA_FEATURES,
  CAREER_DAILY_QUOTA_LABELS,
  careerQuotaJstDate,
  careerQuotaJstResetAtMs,
  getCareerDailyLimit,
  isCareerDailyQuotaFeature,
  type CareerDailyQuotaFeature,
} from '../lib/careerQuota/limits';
import {
  buildCareerQuotaOperationIds,
  canonicalJson,
  careerQuotaOperationDigest,
} from '../lib/careerQuota/operationId';
import { CAREER_QUOTA_ANCHORS } from '../lib/careerQuota/anchors';

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

// import 行を潰す（「guard より後 / AI より前」を **本体の実行順**で見るため、
// ファイル冒頭の import 行が位置比較を汚さないようにする）。
function stripImports(src: string): string {
  return src.replace(/^import[\s\S]*?;\s*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}

function stripSqlComments(src: string): string {
  return src.replace(/^\s*--[^\n]*$/gm, '');
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
console.log('[1] daily limit matrix / canonical feature keys');
{
  // 商品仕様の絶対値。ここが変わったら仕様変更であり、QA が必ず落ちる。
  const SPEC: Record<string, number> = {
    self_analysis: 10,
    company_research: 10,
    es: 10,
    interview: 8,
    presentation: 5,
    gd: 5,
    matching: 5,
  };
  for (const [feature, limit] of Object.entries(SPEC)) {
    check(
      isCareerDailyQuotaFeature(feature) &&
        getCareerDailyLimit(feature as CareerDailyQuotaFeature) === limit,
      `${feature} = ${limit} 回/日`,
    );
  }
  check(
    CAREER_DAILY_QUOTA_FEATURES.length === Object.keys(SPEC).length,
    `feature は 7 種類ちょうど（${CAREER_DAILY_QUOTA_FEATURES.length}）`,
  );
  check(
    CAREER_DAILY_QUOTA_FEATURES.every((f) => CAREER_BASIC_DAILY_LIMITS[f] > 0),
    'すべての feature に正の上限がある（0 = 未提供が紛れていない）',
  );
  check(
    CAREER_DAILY_QUOTA_FEATURES.every((f) => !!CAREER_DAILY_QUOTA_LABELS[f]),
    'すべての feature に日本語ラベルがある（上限到達メッセージ用）',
  );
  check(!isCareerDailyQuotaFeature('career-es'), '別語彙（career-es）は feature key として拒否される');

  // anchor 表がすべての feature を覆っていること。
  const covered = new Set(CAREER_QUOTA_ANCHORS.map((a) => a.feature));
  check(
    CAREER_DAILY_QUOTA_FEATURES.every((f) => covered.has(f)),
    '全 feature に quota anchor route が定義されている',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[2] JST（Asia/Tokyo）の 1 日境界');
{
  // 2026-08-21 23:59:59 JST = 2026-08-21T14:59:59Z
  const jstLate = Date.parse('2026-08-21T14:59:59.000Z');
  // 2026-08-22 00:00:00 JST = 2026-08-21T15:00:00Z
  const jstMidnight = Date.parse('2026-08-21T15:00:00.000Z');

  check(careerQuotaJstDate(jstLate) === '2026-08-21', '23:59:59 JST は当日の日付');
  check(careerQuotaJstDate(jstMidnight) === '2026-08-22', '00:00:00 JST は翌日の日付（リセット）');
  check(
    careerQuotaJstDate(Date.parse('2026-08-21T14:00:00.000Z')) === '2026-08-21',
    'UTC 日付が変わっても JST 日付は変わらない（23:00 JST）',
  );
  check(
    careerQuotaJstResetAtMs(jstLate) === jstMidnight,
    'リセット時刻は次の JST 0:00',
  );
  check(
    careerQuotaJstResetAtMs(jstMidnight) === Date.parse('2026-08-22T15:00:00.000Z'),
    '0:00 直後のリセット時刻は 24 時間後の JST 0:00',
  );
  // 日本に DST は無いので冬時間でも同じオフセット。
  check(
    careerQuotaJstDate(Date.parse('2026-01-15T15:00:00.000Z')) === '2026-01-16',
    '冬季も +09:00 固定（日本に DST 無し）',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[3] operation identity（retry / 二重送信 / reload 対策）');
{
  const bodyA = { answer: 'これは私のES本文です。', question: '学生時代に力を入れたこと' };
  const bodyAReordered = { question: '学生時代に力を入れたこと', answer: 'これは私のES本文です。' };
  const bodyB = { answer: 'これは私のES本文です！', question: '学生時代に力を入れたこと' };

  check(
    careerQuotaOperationDigest(bodyA) === careerQuotaOperationDigest(bodyAReordered),
    '同一内容は key 順序が違っても同一 digest（JSON.stringify の順序依存を排除）',
  );
  check(
    careerQuotaOperationDigest(bodyA) !== careerQuotaOperationDigest(bodyB),
    '1 文字でも違えば別 operation',
  );
  check(
    canonicalJson({ b: 1, a: [3, { z: 1, y: 2 }] }) === '{"a":[3,{"y":2,"z":1}],"b":1}',
    'canonicalJson は入れ子まで key 順を固定する',
  );
  check(!/[^0-9a-f]/.test(careerQuotaOperationDigest(bodyA)), 'digest は hex のみ（本文は復元不能）');

  // 日単位 dedupe（既定）。
  const es1 = buildCareerQuotaOperationIds({ feature: 'es', source: bodyA, windowSeconds: null });
  const es2 = buildCareerQuotaOperationIds({ feature: 'es', source: bodyA, windowSeconds: null });
  check(es1.length === 1 && es1[0] === es2[0], '窓なし feature は同一入力 → 同一 id 1 本');
  check(es1[0].startsWith('es:'), 'operation id は feature で namespace 化される');
  const gd1 = buildCareerQuotaOperationIds({ feature: 'gd', source: bodyA, windowSeconds: null });
  check(gd1[0] !== es1[0], '同一入力でも feature が違えば別 operation（bucket 混線なし）');

  // 面接だけ時間 bucket（同設定の無限再開始を防ぐ）。
  check(
    CAREER_DAILY_QUOTA_DEDUPE_WINDOW_SECONDS.interview === 1800 &&
      CAREER_DAILY_QUOTA_FEATURES.filter(
        (f) => CAREER_DAILY_QUOTA_DEDUPE_WINDOW_SECONDS[f] !== null,
      ).length === 1,
    '時間 bucket を使うのは面接だけ（他は日単位 dedupe）',
  );
  const t0 = Date.parse('2026-08-21T03:00:00.000Z');
  const iv0 = buildCareerQuotaOperationIds({ feature: 'interview', source: bodyA, windowSeconds: 1800, nowMs: t0 });
  const ivRetry = buildCareerQuotaOperationIds({ feature: 'interview', source: bodyA, windowSeconds: 1800, nowMs: t0 + 5_000 });
  const ivLater = buildCareerQuotaOperationIds({ feature: 'interview', source: bodyA, windowSeconds: 1800, nowMs: t0 + 90 * 60_000 });
  check(iv0.length === 2, '時間 bucket 使用時は「現在 bucket + 直前 bucket」を返す');
  check(iv0[0] === ivRetry[0], '数秒後の retry は同一 canonical id（二重消費しない）');
  check(iv0[0] !== ivLater[0] && !ivLater.includes(iv0[0]), '90 分後の新セッションは別 operation');
  // 窓の境界をまたいだ retry を取りこぼさない。
  const edge = Date.parse('2026-08-21T03:29:59.000Z');
  const edgeIds = buildCareerQuotaOperationIds({ feature: 'interview', source: bodyA, windowSeconds: 1800, nowMs: edge });
  const afterEdge = buildCareerQuotaOperationIds({ feature: 'interview', source: bodyA, windowSeconds: 1800, nowMs: edge + 3_000 });
  check(afterEdge.includes(edgeIds[0]), 'bucket 境界をまたぐ retry も dedupe 候補に含まれる');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
// SQL `career_daily_quota_consume` と同一意味の reference 実装。
//   - operation を先に確保 → 勝った側だけが used を条件付きで +1
//   - `used < limit` の評価は **行 lock を保持したまま**行う（Postgres の
//     ON CONFLICT DO UPDATE ... WHERE と同じ意味）。ここを模した mutex を挟むことで、
//     「read → await → write」の間に他 request が割り込む余地が無いことを検証する。
type Outcome = 'CONSUMED' | 'DEDUPED' | 'LIMIT_REACHED';

class QuotaModel {
  private used = new Map<string, number>();
  private ops = new Set<string>();
  private rowLocks = new Map<string, Promise<void>>();

  constructor(private nowMs: number) {}

  setNow(nowMs: number) {
    this.nowMs = nowMs;
  }

  usedOf(userId: string, feature: string, nowMs = this.nowMs): number {
    return this.used.get(`${userId}|${feature}|${careerQuotaJstDate(nowMs)}`) ?? 0;
  }

  private async withRowLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.rowLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.rowLocks.set(key, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async consume(input: {
    userId: string;
    feature: CareerDailyQuotaFeature;
    operationIds: readonly string[];
    limit: number;
  }): Promise<{ outcome: Outcome; used: number }> {
    const date = careerQuotaJstDate(this.nowMs);
    const scope = `${input.userId}|${input.feature}|${date}`;
    const canonical = `${scope}|${input.operationIds[0]}`;

    // (1) 既に計上済みの operation か。
    if (input.operationIds.some((id) => this.ops.has(`${scope}|${id}`))) {
      return { outcome: 'DEDUPED', used: this.used.get(scope) ?? 0 };
    }
    // (2) operation を確保（同一 operation の同時 request は 1 本だけ勝つ）。
    if (this.ops.has(canonical)) {
      return { outcome: 'DEDUPED', used: this.used.get(scope) ?? 0 };
    }
    this.ops.add(canonical);

    // (3) 行 lock を取ったうえで最新値に対して used < limit を評価する。
    return this.withRowLock(scope, async () => {
      // 非原子な実装なら、ここでの await が overshoot を生む。
      await Promise.resolve();
      const current = this.used.get(scope) ?? 0;
      if (current >= input.limit) {
        this.ops.delete(canonical);
        return { outcome: 'LIMIT_REACHED' as const, used: current };
      }
      this.used.set(scope, current + 1);
      return { outcome: 'CONSUMED' as const, used: current + 1 };
    });
  }
}

const allow = (o: Outcome) => o === 'CONSUMED' || o === 'DEDUPED';

const T_NOON_JST = Date.parse('2026-08-21T03:00:00.000Z'); // 2026-08-21 12:00 JST

async function main() {
console.log('[4a] Boundary QA — limit-1 ALLOW / limit ALLOW / limit+1 BLOCK');
{
  for (const feature of CAREER_DAILY_QUOTA_FEATURES) {
    const limit = getCareerDailyLimit(feature);
    const model = new QuotaModel(T_NOON_JST);
    const outcomes: Outcome[] = [];
    for (let i = 1; i <= limit + 1; i++) {
      const ids = buildCareerQuotaOperationIds({
        feature,
        source: { op: i }, // 毎回別の top-level operation
        windowSeconds: CAREER_DAILY_QUOTA_DEDUPE_WINDOW_SECONDS[feature],
        nowMs: T_NOON_JST,
      });
      outcomes.push((await model.consume({ userId: 'u1', feature, operationIds: ids, limit })).outcome);
    }
    const allowed = outcomes.filter(allow).length;
    check(
      allowed === limit &&
        outcomes[limit - 2] === 'CONSUMED' &&
        outcomes[limit - 1] === 'CONSUMED' &&
        outcomes[limit] === 'LIMIT_REACHED',
      `${feature}: 1〜${limit} ALLOW / ${limit + 1} BLOCK（最終 count=${model.usedOf('u1', feature)}）`,
    );
  }
}
console.log('');

console.log('[4b] Multi-call dedup — 内部 AI call を利用回数として数えない');
{
  // 実 route での「消費するのは anchor だけ」は [6] で静的に検証する。
  // ここでは「1 ワークフローが anchor を 1 度だけ通ると usage=1」を確認する。
  const workflows: Array<{ label: string; feature: CareerDailyQuotaFeature; calls: string[]; anchorCalls: number }> = [
    { label: 'ES workflow（organize/materials/deep×5/review）', feature: 'es', calls: ['materials', 'deep', 'deep', 'deep', 'deep', 'deep', 'organize', 'review'], anchorCalls: 1 },
    { label: '自己分析 session（seed/followup×N/summary）', feature: 'self_analysis', calls: ['seed', 'followup', 'followup', 'followup', 'summary'], anchorCalls: 1 },
    { label: '面接 session（start/turn×4/complete）', feature: 'interview', calls: ['start', 'turn', 'turn', 'turn', 'turn', 'complete'], anchorCalls: 1 },
    { label: 'プレゼン session（theme/evaluate/QA×4）', feature: 'presentation', calls: ['theme', 'evaluate', 'qa', 'qa', 'qa', 'qa'], anchorCalls: 1 },
    { label: 'GD session（theme/turn×N/feedback）', feature: 'gd', calls: ['theme', 'turn', 'turn', 'turn', 'feedback'], anchorCalls: 1 },
  ];
  for (const wf of workflows) {
    const model = new QuotaModel(T_NOON_JST);
    const ids = buildCareerQuotaOperationIds({
      feature: wf.feature,
      source: { session: wf.label },
      windowSeconds: CAREER_DAILY_QUOTA_DEDUPE_WINDOW_SECONDS[wf.feature],
      nowMs: T_NOON_JST,
    });
    for (let i = 0; i < wf.anchorCalls; i++) {
      await model.consume({ userId: 'u1', feature: wf.feature, operationIds: ids, limit: getCareerDailyLimit(wf.feature) });
    }
    check(
      model.usedOf('u1', wf.feature) === 1,
      `${wf.label} → daily usage = 1（内部 ${wf.calls.length} call）`,
    );
  }

  // retry / 二重送信 / reload 後の再送 = 同一 body → 追加消費 0。
  const model = new QuotaModel(T_NOON_JST);
  const body = { answer: '同じ本文', question: '同じ設問' };
  const ids = buildCareerQuotaOperationIds({ feature: 'es', source: body, windowSeconds: null });
  const r1 = await model.consume({ userId: 'u1', feature: 'es', operationIds: ids, limit: 10 });
  const r2 = await model.consume({ userId: 'u1', feature: 'es', operationIds: ids, limit: 10 });
  const r3 = await model.consume({ userId: 'u1', feature: 'es', operationIds: ids, limit: 10 });
  check(
    r1.outcome === 'CONSUMED' && r2.outcome === 'DEDUPED' && r3.outcome === 'DEDUPED' &&
      model.usedOf('u1', 'es') === 1,
    '同一 operation の 3 連投（double click / retry / reload）→ usage 1',
  );
  check(allow(r2.outcome) && allow(r3.outcome), 'dedupe された retry は 429 にならず処理を続行できる');

  // 再添削（本文が変わる）は ES bucket の +1。
  const ids2 = buildCareerQuotaOperationIds({ feature: 'es', source: { ...body, answer: '改善版の本文' }, windowSeconds: null });
  await model.consume({ userId: 'u1', feature: 'es', operationIds: ids2, limit: 10 });
  check(model.usedOf('u1', 'es') === 2, '改善版の再添削は ES bucket の +1（新規と合算で 10 回/日）');

  // マルチ GD は room 単位。
  const gdModel = new QuotaModel(T_NOON_JST);
  const roomIds = buildCareerQuotaOperationIds({ feature: 'gd', source: { roomId: 'room-1' }, windowSeconds: null });
  await gdModel.consume({ userId: 'u1', feature: 'gd', operationIds: roomIds, limit: 5 });
  await gdModel.consume({ userId: 'u1', feature: 'gd', operationIds: roomIds, limit: 5 });
  check(gdModel.usedOf('u1', 'gd') === 1, 'マルチ GD は room 単位で 1 消費（評価の再実行でも +0）');
}
console.log('');

console.log('[4c] Cross-feature isolation');
{
  const model = new QuotaModel(T_NOON_JST);
  for (let i = 1; i <= 10; i++) {
    const ids = buildCareerQuotaOperationIds({ feature: 'es', source: { op: i }, windowSeconds: null });
    await model.consume({ userId: 'u1', feature: 'es', operationIds: ids, limit: 10 });
  }
  check(model.usedOf('u1', 'es') === 10, 'ES を 10 回使用した');
  const others: Array<[CareerDailyQuotaFeature, number]> = [
    ['company_research', 10],
    ['interview', 8],
    ['gd', 5],
    ['presentation', 5],
    ['matching', 5],
    ['self_analysis', 10],
  ];
  for (const [feature, limit] of others) {
    const remaining = limit - model.usedOf('u1', feature);
    check(remaining === limit, `${feature} の残りは ${limit}（ES の消費に巻き込まれない）`);
  }
  // 別ユーザーにも影響しない。
  check(model.usedOf('u2', 'es') === 0, '他ユーザーの counter に影響しない');
}
console.log('');

console.log('[4d] Concurrency — 残り 1 に 20 並列');
{
  const model = new QuotaModel(T_NOON_JST);
  for (let i = 1; i <= 9; i++) {
    const ids = buildCareerQuotaOperationIds({ feature: 'es', source: { op: i }, windowSeconds: null });
    await model.consume({ userId: 'u1', feature: 'es', operationIds: ids, limit: 10 });
  }
  check(model.usedOf('u1', 'es') === 9, '前提: used = 9 / limit = 10');

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      model.consume({
        userId: 'u1',
        feature: 'es',
        // すべて **別の** operation（＝ dedupe ではなく本当の同時消費）。
        operationIds: buildCareerQuotaOperationIds({ feature: 'es', source: { parallel: i }, windowSeconds: null }),
        limit: 10,
      }),
    ),
  );
  const allowed = results.filter((r) => r.outcome === 'CONSUMED').length;
  const rejected = results.filter((r) => r.outcome === 'LIMIT_REACHED').length;
  check(allowed === 1, `20 並列のうち ALLOW = 1（実測 ${allowed}）`);
  check(rejected === 19, `20 並列のうち REJECT = 19（実測 ${rejected}）`);
  check(model.usedOf('u1', 'es') === 10, `最終 count = 10（実測 ${model.usedOf('u1', 'es')}）`);

  // 同一 operation の 20 並列は 1 消費（dedupe 側の並列安全性）。
  const dedupeModel = new QuotaModel(T_NOON_JST);
  const sameIds = buildCareerQuotaOperationIds({ feature: 'presentation', source: { t: 'same' }, windowSeconds: null });
  const dedupeResults = await Promise.all(
    Array.from({ length: 20 }, () =>
      dedupeModel.consume({ userId: 'u1', feature: 'presentation', operationIds: sameIds, limit: 5 }),
    ),
  );
  check(
    dedupeModel.usedOf('u1', 'presentation') === 1 && dedupeResults.every((r) => allow(r.outcome)),
    '同一 operation の 20 並列 → usage 1・全件 ALLOW（連打で上限を溶かさない）',
  );
}
console.log('');

console.log('[4e] Day reset（JST 00:00）');
{
  const late = Date.parse('2026-08-21T14:59:59.000Z'); // 23:59:59 JST
  const midnight = Date.parse('2026-08-21T15:00:00.000Z'); // 翌 00:00:00 JST
  const model = new QuotaModel(late);
  for (let i = 1; i <= 5; i++) {
    await model.consume({
      userId: 'u1',
      feature: 'gd',
      operationIds: buildCareerQuotaOperationIds({ feature: 'gd', source: { op: i }, windowSeconds: null }),
      limit: 5,
    });
  }
  const blocked = await model.consume({
    userId: 'u1',
    feature: 'gd',
    operationIds: buildCareerQuotaOperationIds({ feature: 'gd', source: { op: 6 }, windowSeconds: null }),
    limit: 5,
  });
  check(blocked.outcome === 'LIMIT_REACHED', '23:59:59 JST — 上限到達');

  model.setNow(midnight);
  const after = await model.consume({
    userId: 'u1',
    feature: 'gd',
    operationIds: buildCareerQuotaOperationIds({ feature: 'gd', source: { op: 6 }, windowSeconds: null }),
    limit: 5,
  });
  check(after.outcome === 'CONSUMED' && after.used === 1, '00:00:00 JST — usage がリセットされる');
  check(model.usedOf('u1', 'gd', late) === 5, '前日の記録は消えない（監査可能）');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[5] DDL 契約（原子性 / JST / 最小権限）');
{
  const sqlPath = 'supabase/career_daily_quota_apply.sql';
  check(existsSync(join(ROOT, sqlPath)), `${sqlPath} が存在する`);
  const sql = stripSqlComments(read(sqlPath));

  check(/CREATE TABLE IF NOT EXISTS career_daily_usage\b/.test(sql), 'counter table が定義されている');
  check(
    /CREATE TABLE IF NOT EXISTS career_daily_usage_operations\b/.test(sql),
    'operation dedupe table が定義されている',
  );
  check(
    /PRIMARY KEY \(user_id, feature, usage_date_jst\)/.test(sql),
    'counter は (user_id, feature, JST 日付) で一意（feature 間で混ざらない）',
  );
  check(
    /PRIMARY KEY \(user_id, feature, usage_date_jst, operation_id\)/.test(sql),
    'operation 台帳は operation_id まで含めて一意（二重消費を DB 制約で防ぐ）',
  );
  // 原子性: 条件付き UPSERT で check と consume を 1 statement にする。
  check(
    /ON CONFLICT \(user_id, feature, usage_date_jst\) DO UPDATE[\s\S]{0,200}?WHERE career_daily_usage\.used < p_limit/.test(sql),
    '原子的 consume（ON CONFLICT DO UPDATE ... WHERE used < limit）',
  );
  check(
    !/SELECT[\s\S]{0,400}?FOR UPDATE[\s\S]{0,200}?UPDATE public\.career_daily_usage/.test(sql),
    'SELECT してから UPDATE する非原子的な経路が無い',
  );
  check(
    /now\(\) AT TIME ZONE 'Asia\/Tokyo'/.test(sql),
    '日付は DB 側で JST 判定（client 時計を受け取らない）',
  );
  check(
    !/p_date|p_usage_date|p_now|p_today/.test(sql),
    '日付 / 現在時刻を引数で受け取っていない（client 由来の日付を信用しない）',
  );
  check(
    /SECURITY DEFINER/.test(sql) && /SET search_path = public, pg_temp/.test(sql),
    'SECURITY DEFINER + search_path 固定',
  );
  // 最小権限。
  for (const table of ['career_daily_usage', 'career_daily_usage_operations']) {
    check(
      new RegExp(`REVOKE ALL ON public\\.${table} FROM anon`).test(sql) &&
        new RegExp(`REVOKE ALL ON public\\.${table} FROM authenticated`).test(sql),
      `${table}: anon / authenticated の権限を剥奪している`,
    );
    check(
      new RegExp(`GRANT ALL ON public\\.${table} TO service_role`).test(sql),
      `${table}: 書き込みは service_role のみ`,
    );
    check(
      new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`).test(sql),
      `${table}: RLS が有効`,
    );
  }
  check(
    !/CREATE POLICY[\s\S]{0,200}FOR (INSERT|UPDATE|DELETE|ALL)[\s\S]{0,60}TO authenticated/.test(sql),
    'authenticated 向けの書き込み policy が無い（client が used を書き換えられない）',
  );
  check(
    /GRANT SELECT ON public\.career_daily_usage TO authenticated/.test(sql) &&
      !/GRANT SELECT ON public\.career_daily_usage_operations TO authenticated/.test(sql),
    'owner が読めるのは counter のみ（dedupe 台帳は server 内部）',
  );
  check(
    /REVOKE ALL ON FUNCTION public\.career_daily_quota_consume[\s\S]{0,400}?GRANT EXECUTE ON FUNCTION public\.career_daily_quota_consume\(uuid, text, text\[\], int\) TO service_role/.test(sql),
    'RPC の EXECUTE は service_role のみ（client から直接叩けない）',
  );
  // feature 語彙が TS と一致していること。
  const chk = sql.match(/career_daily_usage_feature_chk CHECK \(\s*feature IN \(([\s\S]*?)\)\s*\)/);
  const sqlFeatures = chk
    ? [...chk[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    : [];
  check(
    JSON.stringify(sqlFeatures) === JSON.stringify([...CAREER_DAILY_QUOTA_FEATURES].sort()),
    'DDL の feature CHECK は TS の canonical key と同一集合',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[6] route 配線契約（anchor だけが消費 / guard の後 / AI の前）');
{
  const ENFORCE = /enforceCareerDailyQuota\s*\(/;
  const anchorRoutes = new Set(CAREER_QUOTA_ANCHORS.map((a) => a.route));

  for (const anchor of CAREER_QUOTA_ANCHORS) {
    const abs = join(ROOT, anchor.route);
    if (!existsSync(abs)) {
      check(false, `${anchor.route} が存在する`);
      continue;
    }
    const src = stripImports(stripComments(readFileSync(abs, 'utf8')));
    // 位置比較は POST 本体の中だけで行う（helper 関数の定義位置に引きずられないため）。
    const postAt = src.search(/export async function POST/);
    const postSrc = postAt >= 0 ? src.slice(postAt) : src;
    const calls = [...src.matchAll(/enforceCareerDailyQuota\s*\(/g)].length;
    check(calls === 1, `${anchor.route}: quota を 1 度だけ消費する（${calls} 箇所）`);

    // feature key の直書き一致（anchor 表と route が乖離しない）。
    check(
      new RegExp(`feature:\\s*'${anchor.feature}'`).test(src),
      `${anchor.route}: feature='${anchor.feature}' で消費する`,
    );

    check(postAt >= 0, `${anchor.route}: POST handler がある`);
    const quotaAt = postSrc.search(ENFORCE);
    // guard（identity / rate limit / body 上限）より後ろ。
    const guardAt = postSrc.search(/guard(CareerAiRequest|EsRequest|InterviewRequest|PresentationRequest)\s*\(|authenticateGdMember\s*\(/);
    check(guardAt >= 0 && guardAt < quotaAt, `${anchor.route}: quota は identity/rate limit guard より後`);
    // AI 呼び出しより前。
    const aiAt = postSrc.search(/anthropic\.messages\.create|generateRoomFeedback|generateCareerGdSummary|handleSelfAnalysisJobPost/);
    check(aiAt < 0 || quotaAt < aiAt, `${anchor.route}: quota は AI 実行より前（上限到達なら AI コール 0 回）`);
    // 上限値の直書き禁止。
    check(
      !new RegExp(`limit:\\s*${getCareerDailyLimit(anchor.feature)}\\b`).test(src),
      `${anchor.route}: 上限値を route に直書きしていない`,
    );
  }

  // anchor 以外の career AI route は消費しない（内部 call を数えない構造の担保）。
  const careerApiFiles = walk(join(ROOT, 'app/api/career'));
  const unexpected = careerApiFiles
    .map((f) => f.slice(ROOT.length + 1))
    .filter((rel) => !anchorRoutes.has(rel) && ENFORCE.test(stripComments(read(rel))));
  check(
    unexpected.length === 0,
    `anchor 以外の career route は quota を消費しない（違反 ${unexpected.length} 件${unexpected.length ? ': ' + unexpected.join(', ') : ''}）`,
  );

  // 内部 subflow が消費していないことを名指しで確認する（Phase 19 の核心）。
  const NON_CONSUMING = [
    'app/api/career/self-analysis/question/route.ts',
    'app/api/career/es/deep/route.ts',
    'app/api/career/es/materials/route.ts',
    'app/api/career/es/organize/route.ts',
    'app/api/career/interview/turn/route.ts',
    'app/api/career/interview/complete/route.ts',
    'app/api/career/presentation/theme/route.ts',
    'app/api/career/presentation/qa/route.ts',
    'app/api/career/gd/theme/route.ts',
    'app/api/career/gd/turn/route.ts',
    'app/api/career/gd/room/create/route.ts',
    'app/api/career/gd/room/join/route.ts',
    'app/api/career/gd/room/[roomId]/ai-turn/route.ts',
    'app/api/career/gd/room/[roomId]/messages/route.ts',
    'app/api/career/gd/lobby/create/route.ts',
    'app/api/career/gd/lobby/join/route.ts',
    'app/api/career/gd/match/enter/route.ts',
    'app/api/career/company-research/extract/route.ts',
  ];
  for (const rel of NON_CONSUMING) {
    if (!existsSync(join(ROOT, rel))) {
      check(false, `${rel} が存在する`);
      continue;
    }
    check(!ENFORCE.test(stripComments(read(rel))), `${rel}: 内部 call は消費しない`);
  }

  // Company Data Spine（prefetch / identity / official facts）は消費しない。
  const spineDirs = ['lib/careerCompanyPrefetch', 'lib/careerCompanyIdentity', 'lib/careerCompanyKnowledge'];
  const spineHits = spineDirs
    .flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => ENFORCE.test(stripComments(readFileSync(f, 'utf8'))));
  check(spineHits.length === 0, 'Company Data Spine は quota を消費しない（内部 prefetch は 0 消費）');
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[7] security / failure semantics');
{
  const enforce = stripComments(read('lib/careerQuota/enforce.ts'));
  const repo = stripComments(read('lib/careerQuota/repository.server.ts'));
  const opid = stripComments(read('lib/careerQuota/operationId.ts'));

  check(/import 'server-only';/.test(enforce), 'enforce は server-only');
  check(/import 'server-only';/.test(repo), 'repository は server-only');
  check(
    /identity\.kind !== 'member'/.test(enforce),
    'userId は server で解決した identity からのみ取る',
  );
  check(
    !/body\.(userId|plan|limit|used|feature)/.test(enforce) && !/req\.headers/.test(enforce),
    'client 申告の userId / plan / limit / used / feature を読まない',
  );
  check(
    !/operationId\s*\?\?|input\.operationId|body\.operationId/.test(opid + enforce),
    'operation id は server が計算する（client 指定 id を受け取らない）',
  );
  check(
    /getCareerServiceRoleSupabaseClient/.test(enforce),
    'counter への書き込みは service_role 経由（RLS 越しの client 書き込みではない）',
  );
  check(/status:\s*429/.test(enforce), '上限到達は 429');
  check(
    /error:\s*'DAILY_LIMIT_REACHED'/.test(enforce) &&
      /feature[,:]/.test(enforce) &&
      /limit[,:]/.test(enforce) &&
      /used[,:]/.test(enforce),
    '429 body は machine-readable（error / feature / limit / used）',
  );
  check(
    /const detail =/.test(enforce) && /^\s+detail,$/m.test(enforce),
    '既存 client 契約（data.detail）に載せて理由が UI に出る',
  );
  check(/'Retry-After'/.test(enforce), 'Retry-After header を返す');
  check(
    /resetAt/.test(enforce) && /careerQuotaJstResetAtMs/.test(enforce),
    'リセット時刻（JST 翌日 0:00）を返す',
  );

  // 429 レスポンスの実物を検証する。
  const { careerDailyLimitReachedResponse } = await import('../lib/careerQuota/enforce');
  const now = Date.parse('2026-08-21T03:00:00.000Z');
  const res = careerDailyLimitReachedResponse({
    feature: 'es',
    limit: 10,
    used: 10,
    resetAtMs: careerQuotaJstResetAtMs(now),
    nowMs: now,
  });
  const payload = (await res.json()) as Record<string, unknown>;
  check(res.status === 429, '429 Too Many Requests を返す');
  check(
    payload.error === 'DAILY_LIMIT_REACHED' && payload.feature === 'es' &&
      payload.limit === 10 && payload.used === 10 && payload.remaining === 0,
    '429 body の形が仕様どおり',
  );
  check(
    typeof payload.detail === 'string' && payload.detail.includes('10回') && payload.detail.includes('翌日'),
    '上限到達の理由と復帰タイミングが日本語で伝わる',
  );
  check(
    payload.resetAt === new Date(Date.parse('2026-08-21T15:00:00.000Z')).toISOString(),
    'resetAt は JST 翌日 0:00',
  );
  check(res.headers.get('Retry-After') === String(12 * 3600), 'Retry-After はリセットまでの秒数');
  check(
    !JSON.stringify(payload).includes('user') && !JSON.stringify(payload).includes('operation'),
    '429 body に userId / operation を含めない',
  );

  // fail-open の明示（silent no-op にしない）。
  check(
    /not-provisioned[\s\S]{0,300}console\.warn/.test(enforce),
    'DDL 未適用時は警告を出す（黙って無効化しない）',
  );
  check(
    /CAREER_DAILY_QUOTA_DISABLED/.test(enforce) &&
      /v === '1' \|\| v === 'true'/.test(enforce),
    '無効化 flag は明示 opt-in（既定は有効）',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[8] 非退行（既存レイヤーに触れていない）');
{
  const rl = read('lib/rateLimit/index.ts');
  for (const name of [
    'CAREER_GD_RATE_LIMITS',
    'CAREER_PRESENTATION_RATE_LIMITS',
    'CAREER_INTERVIEW_RATE_LIMITS',
    'CAREER_ES_RATE_LIMITS',
    'CAREER_BILLING_RATE_LIMITS',
    'CAREER_AI_RATE_LIMITS',
  ]) {
    check(rl.includes(`export const ${name}`), `既存 burst rate limit ${name} が残っている`);
  }
  check(
    !stripComments(read('lib/careerQuota/enforce.ts')).includes('rateLimit'),
    'daily quota は既存 rate limit を置き換えず別レイヤーとして共存する',
  );

  // quota モジュールが AI / Stripe / prompt に触れていないこと。
  for (const f of ['lib/careerQuota/limits.ts', 'lib/careerQuota/operationId.ts', 'lib/careerQuota/enforce.ts', 'lib/careerQuota/repository.server.ts', 'lib/careerQuota/anchors.ts']) {
    const src = read(f);
    check(
      !/@\/lib\/ai\b|anthropic|stripe|max_tokens|buildCareerAiContext/i.test(src),
      `${f}: AI / prompt / Stripe に触れない`,
    );
  }

  // anchor route の diff が quota 挿入だけであること（prompt / model / Data Spine 非変更）。
  const FORBIDDEN = /max_tokens|CAREER_[A-Z_]*MODEL|buildCareerAiContext/;
  for (const anchor of CAREER_QUOTA_ANCHORS) {
    const src = read(anchor.route);
    const quotaBlock = src.slice(
      Math.max(0, src.indexOf('enforceCareerDailyQuota')),
      src.indexOf('enforceCareerDailyQuota') + 400,
    );
    check(!FORBIDDEN.test(quotaBlock), `${anchor.route}: 挿入箇所が prompt / model に触れていない`);
  }
}
console.log('');

// ═══════════════════════════════════════════════════════════════
if (failures === 0) {
  console.log('ALL PASS — CAREER daily quota contracts hold.');
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S) — CAREER daily quota contracts violated.`);
  process.exit(1);
}
}

void main();

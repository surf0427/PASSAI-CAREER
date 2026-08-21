/*
 * scripts/career-daily-quota-qa.ts
 *
 * PASSAI CAREER — 機能別 1 日利用回数上限（daily quota）の QA（dev-only / 実 DB 非接続）。
 *
 * 検証:
 *   [1] 上限マトリクス（商品仕様値そのもの）と canonical feature key
 *   [2] JST（Asia/Tokyo）の 1 日境界 — 23:59:59 / 00:00:00 / リセット時刻
 *   [3] operation identity — server 計算の digest / key 順序非依存 / feature 名前空間
 *   [4] consume の状態機械（SQL と同一意味の reference 実装）
 *        - Boundary: limit-1 ALLOW / limit ALLOW / limit+1 BLOCK（全 7 feature）
 *        - Multi-call dedup: ES / 自己分析 / 面接 / プレゼン / GD の 1 ワークフロー = 1 消費
 *        - ★ 事故の重複（retry / 二重送信 / 20 並列）= +0
 *        - ★ 同一内容でもユーザーが明示的に再実行 = 毎回 +1（全 anchor で 3 連続検証）
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
  CAREER_DAILY_QUOTA_FEATURES,
  CAREER_DAILY_QUOTA_LABELS,
  CAREER_QUOTA_LEASE_SECONDS,
  CAREER_QUOTA_MAX_DEDUPE_HITS,
  careerQuotaJstDate,
  careerQuotaJstResetAtMs,
  getCareerDailyLimit,
  isCareerDailyQuotaFeature,
  type CareerDailyQuotaFeature,
} from '../lib/careerQuota/limits';
import {
  buildCareerQuotaOperationId,
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
console.log('[3] operation identity（server 計算 / client 指定不可）');
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

  const es1 = buildCareerQuotaOperationId('es', bodyA);
  const es2 = buildCareerQuotaOperationId('es', bodyA);
  check(es1 === es2, '同一入力 → 同一 operation id（決定的）');
  check(es1.startsWith('es:'), 'operation id は feature で namespace 化される');
  check(
    buildCareerQuotaOperationId('gd', bodyA) !== es1,
    '同一入力でも feature が違えば別 operation（bucket 混線なし）',
  );

  // ★ 時間依存を持たない = 「30 分以内の 2 回目が無料」という不具合が構造的に起きない。
  const opSrc = readFileSync(join(ROOT, 'lib/careerQuota/operationId.ts'), 'utf8');
  check(
    !/Date\.now\(\)|nowMs|windowSeconds|bucket/.test(stripComments(opSrc)),
    'operation id は時刻に依存しない（time bucket による誤 dedupe が無い）',
  );
  check(
    !/operationId|operationKey|idempotency/i.test(stripComments(opSrc).replace(/careerQuotaOperationDigest|buildCareerQuotaOperationId/g, '')),
    'client 指定の operation id / idempotency key を受け取らない',
  );

  // lease / 畳み上限の定義が妥当な範囲にあること。
  check(
    CAREER_QUOTA_LEASE_SECONDS >= 300 && CAREER_QUOTA_LEASE_SECONDS <= 3600,
    `in_flight lease は最長 AI route（300s）より長い（${CAREER_QUOTA_LEASE_SECONDS}s）`,
  );
  check(
    CAREER_QUOTA_MAX_DEDUPE_HITS >= 20,
    `同一 operation の 20 並列を畳める（max dedupe hits = ${CAREER_QUOTA_MAX_DEDUPE_HITS}）`,
  );
}
console.log('');

// SQL `career_daily_quota_consume` / `career_daily_quota_settle` と同一意味の reference 実装。
//   - operation は実行状態を持つ（in_flight / settled）
//       in_flight 中の同一 digest … retry / 二重送信 → DEDUPED（+0）
//       settled 後の同一 digest   … 明示的な再実行   → CONSUMED（+1・再 arm）
//   - counter の +1 は「行 lock を保持したまま used < limit を評価」する条件付き UPSERT。
//     ここを模した mutex を挟むことで、read → await → write の割り込み余地が無いことを検証する。
//   - operation 行の判定も FOR UPDATE 相当の lock で直列化する。
type Outcome = 'CONSUMED' | 'DEDUPED' | 'LIMIT_REACHED';

type OpRow = {
  state: 'in_flight' | 'settled';
  dedupeHits: number;
  executions: number;
  startedAtMs: number;
};

class QuotaModel {
  private used = new Map<string, number>();
  private ops = new Map<string, OpRow>();
  private locks = new Map<string, Promise<void>>();

  constructor(private nowMs: number) {}

  setNow(nowMs: number) {
    this.nowMs = nowMs;
  }

  advance(ms: number) {
    this.nowMs += ms;
  }

  usedOf(userId: string, feature: string, nowMs = this.nowMs): number {
    return this.used.get(`${userId}|${feature}|${careerQuotaJstDate(nowMs)}`) ?? 0;
  }

  executionsOf(userId: string, feature: string, operationId: string): number {
    return this.ops.get(this.opKey(userId, feature, operationId))?.executions ?? 0;
  }

  private opKey(userId: string, feature: string, operationId: string): string {
    return `${userId}|${feature}|${careerQuotaJstDate(this.nowMs)}|${operationId}`;
  }

  private async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.locks.set(key, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 条件付き UPSERT（行 lock を保持したまま used < limit を評価）。上限到達なら null。 */
  private async increment(scope: string, limit: number): Promise<number | null> {
    return this.withLock(scope, async () => {
      await Promise.resolve(); // 非原子な実装ならここで overshoot が起きる
      const current = this.used.get(scope) ?? 0;
      if (current >= limit) return null;
      this.used.set(scope, current + 1);
      return current + 1;
    });
  }

  async consume(input: {
    userId: string;
    feature: CareerDailyQuotaFeature;
    operationId: string;
    limit: number;
    leaseSeconds?: number;
    maxDedupeHits?: number;
  }): Promise<{ outcome: Outcome; used: number }> {
    const leaseSeconds = input.leaseSeconds ?? CAREER_QUOTA_LEASE_SECONDS;
    const maxDedupeHits = input.maxDedupeHits ?? CAREER_QUOTA_MAX_DEDUPE_HITS;
    const date = careerQuotaJstDate(this.nowMs);
    const scope = `${input.userId}|${input.feature}|${date}`;
    const opKey = this.opKey(input.userId, input.feature, input.operationId);

    // (1) 新規 operation（初回実行）。
    if (!this.ops.has(opKey)) {
      this.ops.set(opKey, {
        state: 'in_flight',
        dedupeHits: 0,
        executions: 1,
        startedAtMs: this.nowMs,
      });
      const used = await this.increment(scope, input.limit);
      if (used === null) {
        this.ops.delete(opKey); // 予約は残さない
        return { outcome: 'LIMIT_REACHED', used: this.used.get(scope) ?? 0 };
      }
      return { outcome: 'CONSUMED', used };
    }

    // (2) 既存 operation は lock を取って直列に判定する（SQL の FOR UPDATE 相当）。
    return this.withLock(opKey, async () => {
      const row = this.ops.get(opKey)!;
      const fresh = this.nowMs - row.startedAtMs < leaseSeconds * 1000;
      const reusable = row.state === 'in_flight' && fresh && row.dedupeHits < maxDedupeHits;

      if (reusable) {
        row.dedupeHits += 1;
        return { outcome: 'DEDUPED' as const, used: this.used.get(scope) ?? 0 };
      }

      // (3) settled / stale / 畳み上限超過 → 新しい logical operation として消費する。
      const used = await this.increment(scope, input.limit);
      if (used === null) {
        // 既存行は消さない（過去の実行記録であり予約ではない）。
        return { outcome: 'LIMIT_REACHED' as const, used: this.used.get(scope) ?? 0 };
      }
      row.state = 'in_flight';
      row.dedupeHits = 0;
      row.executions += 1;
      row.startedAtMs = this.nowMs;
      return { outcome: 'CONSUMED' as const, used };
    });
  }

  /** 実行成功の記録（冪等）。失敗パスでは呼ばれない。 */
  settle(userId: string, feature: CareerDailyQuotaFeature, operationId: string): void {
    const row = this.ops.get(this.opKey(userId, feature, operationId));
    if (row && row.state === 'in_flight') row.state = 'settled';
  }

  /** 1 回の成功実行（consume → AI → settle）を模す。 */
  async execute(input: {
    userId: string;
    feature: CareerDailyQuotaFeature;
    source: unknown;
    limit?: number;
  }): Promise<Outcome> {
    const operationId = buildCareerQuotaOperationId(input.feature, input.source);
    const limit = input.limit ?? getCareerDailyLimit(input.feature);
    const r = await this.consume({ userId: input.userId, feature: input.feature, operationId, limit });
    if (r.outcome !== 'LIMIT_REACHED') this.settle(input.userId, input.feature, operationId);
    return r.outcome;
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
      // 毎回別の top-level operation（別内容）を成功実行する。
      outcomes.push(await model.execute({ userId: 'u1', feature, source: { op: i } }));
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
  const workflows: Array<{ label: string; feature: CareerDailyQuotaFeature; calls: string[] }> = [
    { label: 'ES workflow（organize/materials/deep×5/review）', feature: 'es', calls: ['materials', 'deep', 'deep', 'deep', 'deep', 'deep', 'organize', 'review'] },
    { label: '自己分析 session（seed/followup×N/summary）', feature: 'self_analysis', calls: ['seed', 'followup', 'followup', 'followup', 'summary'] },
    { label: '面接 session（start/turn×4/complete）', feature: 'interview', calls: ['start', 'turn', 'turn', 'turn', 'turn', 'complete'] },
    { label: 'プレゼン session（theme/evaluate/QA×4）', feature: 'presentation', calls: ['theme', 'evaluate', 'qa', 'qa', 'qa', 'qa'] },
    { label: 'GD session（theme/turn×N/feedback）', feature: 'gd', calls: ['theme', 'turn', 'turn', 'turn', 'feedback'] },
  ];
  for (const wf of workflows) {
    const model = new QuotaModel(T_NOON_JST);
    await model.execute({ userId: 'u1', feature: wf.feature, source: { session: wf.label } });
    check(
      model.usedOf('u1', wf.feature) === 1,
      `${wf.label} → daily usage = 1（内部 ${wf.calls.length} call）`,
    );
  }
}
console.log('');

console.log('[4c] 事故の重複は +0 — retry / double click / timeout 後の再送');
{
  // ★ dedupe が効くのは「実行中（in_flight）の operation への再送」だけ。
  const body = { answer: '同じ本文', question: '同じ設問' };
  const opId = buildCareerQuotaOperationId('es', body);

  // double click: 1 本目が返る前に 2 本目・3 本目が届く。
  {
    const m = new QuotaModel(T_NOON_JST);
    const r1 = await m.consume({ userId: 'u1', feature: 'es', operationId: opId, limit: 10 });
    const r2 = await m.consume({ userId: 'u1', feature: 'es', operationId: opId, limit: 10 });
    const r3 = await m.consume({ userId: 'u1', feature: 'es', operationId: opId, limit: 10 });
    check(
      r1.outcome === 'CONSUMED' && r2.outcome === 'DEDUPED' && r3.outcome === 'DEDUPED' &&
        m.usedOf('u1', 'es') === 1,
      '実行中の 3 連投（double click / 二重送信）→ usage 1',
    );
    check(allow(r2.outcome) && allow(r3.outcome), '畳まれた再送は 429 にならず処理を続行できる');
  }

  // 失敗した実行の retry: settle していないので +0。
  {
    const m = new QuotaModel(T_NOON_JST);
    await m.consume({ userId: 'u1', feature: 'es', operationId: opId, limit: 10 }); // 失敗 → settle しない
    m.advance(3_000);
    const retry = await m.consume({ userId: 'u1', feature: 'es', operationId: opId, limit: 10 });
    check(
      retry.outcome === 'DEDUPED' && m.usedOf('u1', 'es') === 1,
      'AI 失敗後のユーザー再試行 → +0（settle していない実行への再送）',
    );
  }

  // 20 並列の同一 operation（script / 多タブ）。
  {
    const m = new QuotaModel(T_NOON_JST);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        m.consume({ userId: 'u1', feature: 'presentation', operationId: buildCareerQuotaOperationId('presentation', { t: 'same' }), limit: 5 }),
      ),
    );
    check(
      m.usedOf('u1', 'presentation') === 1 && results.every((r) => allow(r.outcome)),
      '同一 operation の 20 並列 → usage 1・全件 ALLOW（連打で枠を溶かさない）',
    );
  }

  // settle されないまま lease を過ぎた in_flight は回収される（永久無料の穴を塞ぐ）。
  {
    const m = new QuotaModel(T_NOON_JST);
    await m.consume({ userId: 'u1', feature: 'es', operationId: opId, limit: 10 }); // crash（settle されず）
    m.advance((CAREER_QUOTA_LEASE_SECONDS + 60) * 1000);
    const after = await m.consume({ userId: 'u1', feature: 'es', operationId: opId, limit: 10 });
    check(
      after.outcome === 'CONSUMED' && m.usedOf('u1', 'es') === 2,
      'lease 切れの stale in_flight は新しい実行として消費される',
    );
  }

  // 畳み上限を超えた再送は消費に回る（1 消費で無制限実行にしない）。
  {
    const m = new QuotaModel(T_NOON_JST);
    const id = buildCareerQuotaOperationId('es', { flood: true });
    for (let i = 0; i <= 3; i++) {
      await m.consume({ userId: 'u1', feature: 'es', operationId: id, limit: 10, maxDedupeHits: 3 });
    }
    const over = await m.consume({ userId: 'u1', feature: 'es', operationId: id, limit: 10, maxDedupeHits: 3 });
    check(
      over.outcome === 'CONSUMED' && m.usedOf('u1', 'es') === 2,
      '畳み上限を超えた再送は消費される（コスト増幅に上限がある）',
    );
  }
}
console.log('');

console.log('[4d] 意図的な再実行は毎回 +1（同一内容でも）');
{
  // ★ 本 Phase の最重要要件。同じ payload を hash しただけの dedupe だと
  //   「同じ内容 = 永久に同一 operation」になり、上限を無限に迂回できてしまう。
  const CASES: Array<{ label: string; feature: CareerDailyQuotaFeature; source: unknown }> = [
    {
      label: 'ES 再添削（企業 Keyence / 本文・文字数・選考種別すべて同一）',
      feature: 'es',
      source: { company: 'Keyence', question: 'ガクチカ', answer: '全く同じ本文', maxChars: 400, selectionType: '本選考' },
    },
    {
      label: '企業分析（同一企業・同一資料）',
      feature: 'company_research',
      source: { companyName: 'Keyence', verifiedResearchText: '同じ企業研究テキスト' },
    },
    {
      label: 'マッチング（同一プロフィール・同一条件）',
      feature: 'matching',
      source: { profile: { name: 'A' }, values: { axis: '成長' } },
    },
    {
      label: 'プレゼン再評価（同一 transcript）',
      feature: 'presentation',
      source: { theme: '同じお題', transcript: '同じ発表内容' },
    },
    {
      label: 'ソロ GD 再評価（同一 transcript）',
      feature: 'gd',
      source: { theme: { title: '同じテーマ' }, transcript: ['同じ発言'] },
    },
    {
      label: '面接の再開始（同一設定 / 同一 30 分内）',
      feature: 'interview',
      source: { target: { company: 'Keyence', industry: '製造', jobType: '技術' }, interviewType: 'real' },
    },
    {
      label: '自己分析の再生成（同一会話内容）',
      feature: 'self_analysis',
      source: { conversation: [{ role: 'answer', content: '同じ回答' }] },
    },
  ];

  for (const c of CASES) {
    const m = new QuotaModel(T_NOON_JST);
    const outcomes: Outcome[] = [];
    const useds: number[] = [];
    for (let i = 1; i <= 3; i++) {
      outcomes.push(await m.execute({ userId: 'u1', feature: c.feature, source: c.source }));
      useds.push(m.usedOf('u1', c.feature));
    }
    check(
      outcomes.every((o) => o === 'CONSUMED') && useds[0] === 1 && useds[1] === 2 && useds[2] === 3,
      `${c.label} ×3 → used ${useds.join(' / ')}（期待 1 / 2 / 3）`,
    );
  }

  // 面接は「同じ設定で 30 分以内に 2 回開始」でも 2 消費（旧 time bucket 実装の不具合の回帰テスト）。
  {
    const m = new QuotaModel(T_NOON_JST);
    const src = { target: { company: 'Keyence' }, interviewType: 'real' };
    await m.execute({ userId: 'u1', feature: 'interview', source: src });
    m.advance(5 * 60_000);
    await m.execute({ userId: 'u1', feature: 'interview', source: src });
    check(m.usedOf('u1', 'interview') === 2, '面接: 同一設定を 5 分後に再開始 → +1（time bucket による誤 dedupe が無い）');
  }

  // 別セッションで内容が同じ場合も新しい実行として +1。
  {
    const m = new QuotaModel(T_NOON_JST);
    const src = { theme: '同じ', transcript: '同じ' };
    await m.execute({ userId: 'u1', feature: 'gd', source: src });
    await m.execute({ userId: 'u1', feature: 'gd', source: src });
    check(m.usedOf('u1', 'gd') === 2, 'different session / same content → +1');
  }

  // マルチ GD は room 単位。同一 room の再評価は消費しない（route 側が cached を先に返す）。
  {
    const m = new QuotaModel(T_NOON_JST);
    await m.execute({ userId: 'u1', feature: 'gd', source: { roomId: 'room-1' } });
    await m.execute({ userId: 'u1', feature: 'gd', source: { roomId: 'room-2' } });
    check(m.usedOf('u1', 'gd') === 2, 'マルチ GD: 別 room は別 operation（+1 ずつ）');
    const opId = buildCareerQuotaOperationId('gd', { roomId: 'room-1' });
    check(m.executionsOf('u1', 'gd', opId) === 1, 'マルチ GD: room 1 つにつき実行 1 回として記録される');
  }
}
console.log('');

console.log('[4e] Cross-feature isolation');
{
  const model = new QuotaModel(T_NOON_JST);
  for (let i = 1; i <= 10; i++) {
    await model.execute({ userId: 'u1', feature: 'es', source: { op: i } });
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
    check(limit - model.usedOf('u1', feature) === limit, `${feature} の残りは ${limit}（ES の消費に巻き込まれない）`);
  }
  check(model.usedOf('u2', 'es') === 0, '他ユーザーの counter に影響しない');
}
console.log('');

console.log('[4f] Concurrency — 残り 1 に 20 並列');
{
  const model = new QuotaModel(T_NOON_JST);
  for (let i = 1; i <= 9; i++) {
    await model.execute({ userId: 'u1', feature: 'es', source: { op: i } });
  }
  check(model.usedOf('u1', 'es') === 9, '前提: used = 9 / limit = 10');

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      model.consume({
        userId: 'u1',
        feature: 'es',
        // すべて **別の** operation（＝ dedupe ではなく本当の同時消費）。
        operationId: buildCareerQuotaOperationId('es', { parallel: i }),
        limit: 10,
      }),
    ),
  );
  const allowed = results.filter((r) => r.outcome === 'CONSUMED').length;
  const rejected = results.filter((r) => r.outcome === 'LIMIT_REACHED').length;
  check(allowed === 1, `20 並列のうち ALLOW = 1（実測 ${allowed}）`);
  check(rejected === 19, `20 並列のうち REJECT = 19（実測 ${rejected}）`);
  check(model.usedOf('u1', 'es') === 10, `最終 count = 10（実測 ${model.usedOf('u1', 'es')}）`);
}
console.log('');

console.log('[4g] Day reset（JST 00:00）');
{
  const late = Date.parse('2026-08-21T14:59:59.000Z'); // 23:59:59 JST
  const midnight = Date.parse('2026-08-21T15:00:00.000Z'); // 翌 00:00:00 JST
  const model = new QuotaModel(late);
  for (let i = 1; i <= 5; i++) {
    await model.execute({ userId: 'u1', feature: 'gd', source: { op: i } });
  }
  const blocked = await model.execute({ userId: 'u1', feature: 'gd', source: { op: 6 } });
  check(blocked === 'LIMIT_REACHED', '23:59:59 JST — 上限到達');

  model.setNow(midnight);
  const after = await model.execute({ userId: 'u1', feature: 'gd', source: { op: 6 } });
  check(after === 'CONSUMED' && model.usedOf('u1', 'gd') === 1, '00:00:00 JST — usage がリセットされる');
  check(model.usedOf('u1', 'gd', late) === 5, '前日の記録は消えない（監査可能）');
}
console.log('');

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
    !/SELECT[\s\S]{0,400}?FOR UPDATE[\s\S]{0,200}?UPDATE public\.career_daily_usage\s+SET used/.test(sql),
    'SELECT してから UPDATE する非原子的な counter 更新が無い',
  );
  // 実行状態の state machine（本 Phase の核心）。
  check(
    /state\s+text\s+NOT NULL DEFAULT 'in_flight'/.test(sql) &&
      /CHECK \(state IN \('in_flight', 'settled'\)\)/.test(sql),
    'operation は実行状態（in_flight / settled）を持つ',
  );
  check(
    /v_reusable := v_op\.state = 'in_flight'[\s\S]{0,240}?dedupe_hits < p_max_dedupe_hits/.test(sql),
    'dedupe は in_flight かつ lease 内かつ畳み上限内のときだけ効く',
  );
  check(
    /started_at > now\(\) - make_interval\(secs => p_lease_seconds\)/.test(sql),
    'settle されない stale in_flight は lease で回収される（永久無料の穴が無い）',
  );
  check(
    /executions = executions \+ 1/.test(sql),
    'settled 後の同一 digest は新しい実行として再 arm される（明示的な再実行 = +1）',
  );
  check(
    /FOR UPDATE;/.test(sql),
    '既存 operation 行は FOR UPDATE で lock してから判定する（並行再送の直列化）',
  );
  check(
    /CREATE OR REPLACE FUNCTION public\.career_daily_quota_settle/.test(sql) &&
      /SET state = 'settled', settled_at = now\(\)[\s\S]{0,300}?AND state = 'in_flight'/.test(sql),
    'settle function は冪等（in_flight のときだけ settled にする）',
  );
  check(
    !/p_operation_ids|windowSeconds|bucket/.test(sql),
    'operation は時間 bucket を持たない（時刻依存の誤 dedupe が無い）',
  );
  check(
    /now\(\) AT TIME ZONE 'Asia\/Tokyo'/.test(sql),
    '日付は DB 側で JST 判定（client 時計を受け取らない）',
  );
  // 公開 entry point（consume / settle）が日付・現在時刻を引数で受け取らないこと。
  //   内部 helper（increment / used）は consume が JST で決めた日付を渡すだけなので対象外。
  const consumeSig = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.career_daily_quota_consume('),
    sql.indexOf('RETURNS TABLE'),
  );
  const settleSig = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.career_daily_quota_settle('),
    sql.indexOf('RETURNS void'),
  );
  check(
    !/p_date|p_usage_date|p_now|p_today/.test(consumeSig + settleSig),
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
  // ★ PostgreSQL は関数作成時に PUBLIC へ EXECUTE を暗黙付与する。
  //   明示的に REVOKE しないと anon / authenticated が PostgREST 経由で RPC を直接叩き、
  //   user_id / feature / limit / operation_id を偽装できてしまう。
  const QUOTA_FNS = [
    'career_daily_quota_consume',
    'career_daily_quota_increment',
    'career_daily_quota_used',
    'career_daily_quota_settle',
  ];
  const revokeBlock = sql.slice(sql.indexOf('FOREACH v_sig IN ARRAY'));
  for (const fn of QUOTA_FNS) {
    check(
      new RegExp(`public\\.${fn}\\(`).test(revokeBlock),
      `${fn}: 権限剥奪の対象に含まれている`,
    );
  }
  check(
    /REVOKE ALL ON FUNCTION %s FROM PUBLIC/.test(revokeBlock),
    'PUBLIC への暗黙 EXECUTE を明示的に剥奪している',
  );
  check(
    /REVOKE ALL ON FUNCTION %s FROM anon/.test(revokeBlock) &&
      /REVOKE ALL ON FUNCTION %s FROM authenticated/.test(revokeBlock),
    'anon / authenticated から EXECUTE を剥奪している',
  );
  check(
    /GRANT EXECUTE ON FUNCTION %s TO service_role/.test(revokeBlock),
    'EXECUTE は service_role にだけ付与している',
  );
  check(
    (sql.match(/^SECURITY DEFINER$/gm) ?? []).length === QUOTA_FNS.length,
    `全 quota 関数が SECURITY DEFINER（${QUOTA_FNS.length}）`,
  );
  check(
    (sql.match(/^SET search_path = public, pg_temp$/gm) ?? []).length === QUOTA_FNS.length,
    '全 quota 関数で search_path を固定（SECURITY DEFINER の乗っ取り面を塞ぐ）',
  );
  check(
    /p_limit IS NULL OR p_limit <= 0 OR p_limit > 1000/.test(sql),
    'p_limit は範囲検証される（呼び出し側の異常値を通さない）',
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
    // gate の受け取り方（429 をそのまま返す）。
    check(
      /if \(quota\.blocked\) return quota\.blocked;/.test(postSrc),
      `${anchor.route}: 上限到達の 429 をそのまま返す`,
    );
    // settle は成功パスに 1 箇所だけ。
    const settleCalls = [...postSrc.matchAll(/quota\.settle\(\)/g)].length;
    check(settleCalls === 1, `${anchor.route}: settle を成功パスに 1 度だけ置く（${settleCalls} 箇所）`);
    // guard（identity / rate limit / body 上限）より後ろ。
    const guardAt = postSrc.search(/guard(CareerAiRequest|EsRequest|InterviewRequest|PresentationRequest)\s*\(|authenticateGdMember\s*\(/);
    check(guardAt >= 0 && guardAt < quotaAt, `${anchor.route}: quota は identity/rate limit guard より後`);
    // AI 呼び出しより前。
    const aiAt = postSrc.search(/anthropic\.messages\.create|generateRoomFeedback|generateCareerGdSummary|handleSelfAnalysisJobPost/);
    check(aiAt < 0 || quotaAt < aiAt, `${anchor.route}: quota は AI 実行より前（上限到達なら AI コール 0 回）`);
    // settle は AI 実行より後（＝ 成功が確定してから記録する）。
    const settleAt = postSrc.search(/quota\.settle\(\)/);
    check(
      settleAt > quotaAt && (aiAt < 0 || settleAt > aiAt),
      `${anchor.route}: settle は consume と AI 実行より後にある`,
    );
    // settle は成功レスポンスの直前にある（失敗パスでは settle しない）。
    const afterSettle = settleAt >= 0 ? postSrc.slice(settleAt, settleAt + 260) : '';
    check(
      /return (Response\.json\(|jobResponse;)/.test(afterSettle) &&
        !/status:\s*(4|5)\d\d/.test(afterSettle),
      `${anchor.route}: settle は成功レスポンス直前にある（失敗パスでは settle しない）`,
    );
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
    !/body\.operationId|headers\.get\(['"][xX]-.*[Oo]peration/.test(opid + enforce),
    'operation id は server が計算する（client 指定 id / header を受け取らない）',
  );
  check(
    /leaseSeconds: CAREER_QUOTA_LEASE_SECONDS/.test(enforce) &&
      /maxDedupeHits: CAREER_QUOTA_MAX_DEDUPE_HITS/.test(enforce),
    'lease / 畳み上限は server 定数から渡す（route ごとに書き換えられない）',
  );
  check(
    /limit = getCareerDailyLimit\(feature\)/.test(enforce),
    '上限値は limits.ts の正本から解決する（client からも route からも渡させない）',
  );
  // settle は成功時だけ（enforce 側に「失敗でも settle」する経路が無い）。
  check(
    /settle: async \(\) => \{\}/.test(enforce),
    '上限到達 gate の settle は no-op（ブロック時に実行を記録しない）',
  );
  const repoSrc = stripComments(read('lib/careerQuota/repository.server.ts'));
  check(
    /p_operation_id: input\.operationId/.test(repoSrc) && !/p_operation_ids/.test(repoSrc),
    'RPC には単一の server 計算 operation id を渡す',
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

  // ★ fail-closed（2026-08-22 切替）: quota を数えられない状態で AI を実行しない。
  check(
    !/fail-open/.test(enforce),
    'enforce に fail-open の経路が残っていない',
  );
  check(
    !/return NOOP_GATE;[\s\S]{0,40}\}\s*$/m.test(enforce.slice(enforce.indexOf('logQuotaFailure'))),
    '失敗分岐から NOOP_GATE（素通し）へ戻る経路が無い',
  );
  check(
    (enforce.match(/careerQuotaUnavailableResponse\(\)/g) ?? []).length >= 4,
    'service-role 欠落 / 想定外 throw / identity 不正 / 数えられない がすべて 503 を返す',
  );
  check(
    /status: 503/.test(enforce),
    'quota infrastructure 障害は 503',
  );
  check(
    /CAREER_DAILY_QUOTA_DISABLED/.test(enforce) &&
      /v === '1' \|\| v === 'true'/.test(enforce),
    '無効化 flag は明示 opt-in（未設定 = 有効）',
  );
  check(
    /VERCEL_ENV === 'production'[\s\S]{0,240}console\.warn/.test(enforce),
    'production で無効化 flag が立っていたら警告を出す',
  );
  check(
    /reason=\$\{reason\}/.test(enforce),
    '失敗理由が server ログで切り分けできる（reason= を出す）',
  );
  check(
    !/console\.(warn|error)\([^)]*userId|console\.(warn|error)\([^)]*operationId/.test(enforce),
    'ログに userId / operationId を出さない',
  );
}
console.log('');

// ═══════════════════════════════════════════════════════════════
console.log('[7b] fail-closed の全分岐（純関数 decideCareerQuotaGate を直接検証）');
{
  const { decideCareerQuotaGate, careerQuotaUnavailableResponse } = await import(
    '../lib/careerQuota/enforce'
  );
  const NOW = Date.parse('2026-08-21T03:00:00.000Z');

  // quota infrastructure の失敗はすべて BLOCK / 503（AI へ進ませない）。
  const FAILURES = [
    'not-provisioned',
    'service-role-missing',
    'db-error',
    'unexpected',
    'identity-missing',
  ] as const;
  for (const reason of FAILURES) {
    const d = decideCareerQuotaGate({
      feature: 'es',
      evaluation: { kind: 'failure', reason },
      nowMs: NOW,
    });
    check(d.blocked !== null, `${reason} → BLOCK（AI 未実行）`);
    check(d.blocked?.status === 503, `${reason} → 503（実測 ${d.blocked?.status}）`);
  }

  // 上限到達は 429（「数えられない」と混同しない）。
  const limitHit = decideCareerQuotaGate({
    feature: 'es',
    evaluation: { kind: 'ok', outcome: 'LIMIT_REACHED', used: 10, limit: 10, resetAtMs: NOW + 3600_000 },
    nowMs: NOW,
  });
  check(limitHit.blocked?.status === 429, `上限到達 → 429（503 ではない / 実測 ${limitHit.blocked?.status}）`);

  // 通常系は通す。
  for (const outcome of ['CONSUMED', 'DEDUPED'] as const) {
    const d = decideCareerQuotaGate({
      feature: 'es',
      evaluation: { kind: 'ok', outcome, used: 1, limit: 10, resetAtMs: NOW + 3600_000 },
      nowMs: NOW,
    });
    check(d.blocked === null, `${outcome} → 通す（正常系は非退行）`);
  }

  // 503 body が内部情報を漏らさないこと。
  const unavailable = careerQuotaUnavailableResponse();
  const ub = (await unavailable.json()) as Record<string, unknown>;
  check(unavailable.status === 503, '503 Service Unavailable');
  check(ub.error === 'QUOTA_UNAVAILABLE', `error code = QUOTA_UNAVAILABLE（実測 ${String(ub.error)}）`);
  check(typeof ub.detail === 'string' && (ub.detail as string).length > 0, 'detail に安全な日本語文言');
  const ubs = JSON.stringify(ub);
  check(
    !/career_daily|supabase|service_role|rpc|PGRST|not-provisioned|db-error/i.test(ubs),
    '503 body に table 名 / RPC 名 / 内部理由 / secret を含めない',
  );
  check(unavailable.headers.get('Retry-After') !== null, 'Retry-After を返す');
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

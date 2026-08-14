/*
 * scripts/career-source-read-timeout-qa.ts
 *
 * PASSAI CAREER — Data Spine Source Read soft timeout QA（STEP-API-TIMEOUT-03 / dev-only）。
 *
 * 何を守るか:
 *   Data Spine の Layer 1 Source read は AI route の時間予算（lib/aiTimeout.ts）が始まる
 *   **前**に走る。read が無制限だと、AI 予算が満額使えるままでも request 全体が
 *   囲む境界（Vercel maxDuration / client AbortController）を超えうる。
 *   本 QA は read が CAREER_SOURCE_READ_SOFT_TIMEOUT_MS で必ず打ち切られ、
 *   既存の bridge fallback へ **既存の意味論のまま**倒れることを固定する。
 *
 * 方針:
 *   - 実 Supabase / 実 Claude / 実 sleep を一切使わない（DI fake + 手動制御 promise）。
 *   - soft timer は deps.createSoftTimer で注入し、任意のタイミングで発火させる。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-source-read-timeout-qa.ts
 * 終了コード: 全 PASS → 0 / 1 件でも FAIL → 1。
 */

import { readFileSync } from 'node:fs';

import {
  loadCareerSourceData,
  type CareerSourceReader,
  type CareerSourceReaderDeps,
  type CareerSourceSoftTimer,
} from '@/lib/careerSourceData/serverReader.server';
import {
  CAREER_SOURCE_READ_SOFT_TIMEOUT_MS,
  type CareerSourceKind,
} from '@/lib/careerSourceData/types';
import { decideBaseContextSource } from '@/lib/careerServerContext/baseContextPolicy';
import { AI_BUDGET_PRESET_80S_WALL } from '@/lib/aiTimeout';

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

// ── unhandled rejection 検出（S5 用。全 scenario を通して監視する）──────
const unhandled: unknown[] = [];
process.on('unhandledRejection', (r) => unhandled.push(r));

// ── DI fake ────────────────────────────────────────────────────────────
/** 手動で発火できる soft timer。 */
function manualTimer() {
  let fire!: () => void;
  let cancelled = false;
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  const timer: CareerSourceSoftTimer = {
    promise,
    cancel: () => {
      cancelled = true;
    },
  };
  return { timer, fire: () => fire(), wasCancelled: () => cancelled };
}

type SelectBehavior =
  | { kind: 'resolve'; rows: unknown[] }
  | { kind: 'never' }
  | { kind: 'reject-later'; reject: () => void };

function makeReader(behavior: () => SelectBehavior, onSelect?: () => void): CareerSourceReader {
  return {
    getUserId: async () => '11111111-2222-3333-4444-555555555555',
    select: () => {
      onSelect?.();
      const b = behavior();
      if (b.kind === 'resolve') return Promise.resolve({ rows: b.rows, failed: false });
      // 'never' / 'reject-later': 解決しない promise を返す（timeout を再現）。
      return new Promise((_res, rej) => {
        if (b.kind === 'reject-later') {
          b.reject = () => rej(new Error('late supabase failure'));
        }
      });
    },
  };
}

function makeDeps(
  reader: CareerSourceReader | null | 'throw',
  timer: CareerSourceSoftTimer,
  clock = { t: 0 },
): CareerSourceReaderDeps {
  return {
    now: () => clock.t,
    createReader: async () => {
      if (reader === 'throw') throw new Error('reader boom');
      return reader;
    },
    createSoftTimer: () => timer,
  };
}

const KINDS: CareerSourceKind[] = ['profile', 'activity', 'values'];

// ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('\n[S1] read が soft timeout より先に完了 → 従来どおり server source');
  {
    const { timer, wasCancelled } = manualTimer();
    const r = await loadCareerSourceData(
      KINDS,
      makeDeps(makeReader(() => ({ kind: 'resolve', rows: [{ data: { name: 'x' }, updated_at: null }] })), timer),
    );
    eq('S1 outcome は ok', r.meta.outcome, 'ok');
    eq('S1 softTimeout は立たない', r.meta.softTimeout, undefined);
    check('S1 read 勝利時は timer を cancel する（event loop に残さない）', wasCancelled());
    eq('S1 profile status は ok', r.meta.statuses.profile, 'ok');
  }

  console.log('\n[S2] read が soft timeout を超過 → 打ち切って bridge fallback へ');
  {
    const { timer, fire } = manualTimer();
    const clock = { t: 0 };
    const p = loadCareerSourceData(KINDS, makeDeps(makeReader(() => ({ kind: 'never' })), timer, clock));
    clock.t = CAREER_SOURCE_READ_SOFT_TIMEOUT_MS; // 経過を進める
    fire();
    const r = await p; // ← hang しないこと自体が assertion（never 解決の read を待たない）
    eq('S2 request は hang せず返る / outcome は error', r.meta.outcome, 'error');
    eq('S2 softTimeout=true で観測できる', r.meta.softTimeout, true);
    eq('S2 durationMs が記録される', r.meta.durationMs, CAREER_SOURCE_READ_SOFT_TIMEOUT_MS);
    check(
      'S2 要求した kind はすべて error（部分データを採用しない）',
      KINDS.every((k) => r.meta.statuses[k] === 'error'),
    );
    check(
      'S2 bundle は空（打ち切り時に中途半端な値を返さない）',
      r.bundle.profile === null && r.bundle.activity === null && r.bundle.values === null,
    );
    // ★ 最重要: 既存の decision policy が bridge fallback を選ぶこと（新しい意味論を作らない）。
    const d = decideBaseContextSource(true, r.meta.statuses, false, false);
    eq('S2 decideBaseContextSource → useServerSource=false', d.useServerSource, false);
    eq('S2 decision reason は既存の source_unavailable', d.reason, 'source_unavailable');
  }

  console.log('\n[S3] read が即座に throw → 既存の error/fallback 意味論を維持');
  {
    const { timer } = manualTimer();
    const r = await loadCareerSourceData(KINDS, makeDeps('throw', timer));
    eq('S3 outcome は error（never-throw 境界は維持）', r.meta.outcome, 'error');
    eq('S3 softTimeout は立たない（timeout ではない）', r.meta.softTimeout, undefined);
    const d = decideBaseContextSource(true, r.meta.statuses, false, false);
    eq('S3 decision も source_unavailable（S2 と同一の fallback）', d.reason, 'source_unavailable');
  }

  console.log('\n[S4] 境界: read が先に settle 済みなら timer が発火しても read が勝つ');
  {
    // 「read が先に settle 済み」の状態を作ってから timer を発火させ、read 勝利を固定する。
    const { timer, fire } = manualTimer();
    const p = loadCareerSourceData(
      KINDS,
      makeDeps(makeReader(() => ({ kind: 'resolve', rows: [] })), timer),
    );
    // read の await 連鎖（createReader → getUserId → Promise.all）が settle するまで進める。
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    fire(); // 決着後に timeout を発火させても結果は変わらない
    const r = await p;
    eq('S4 read が先に settle していれば outcome は ok（timeout に倒れない）', r.meta.outcome, 'ok');
    eq('S4 決着後の timer 発火は結果を変えない', r.meta.softTimeout, undefined);

    // 逆向きの境界: timer が先なら timeout が勝つ（S2 と同じ決定論）。
    const { timer: t2, fire: fire2 } = manualTimer();
    const p2 = loadCareerSourceData(KINDS, makeDeps(makeReader(() => ({ kind: 'never' })), t2));
    fire2();
    eq('S4 timer が先なら timeout 勝利', (await p2).meta.softTimeout, true);
  }

  console.log('\n[S5] 打ち切り後に read が遅れて reject → unhandled rejection にしない');
  {
    const before = unhandled.length;
    const { timer, fire } = manualTimer();
    // callback 内代入は TS の narrowing で never になるため配列に貯める。
    const lateRejecters: Array<() => void> = [];
    const reader: CareerSourceReader = {
      getUserId: async () => '11111111-2222-3333-4444-555555555555',
      select: () =>
        new Promise((_res, rej) => {
          lateRejecters.push(() => rej(new Error('late supabase failure')));
        }),
    };
    const p = loadCareerSourceData(KINDS, makeDeps(reader, timer));
    fire();
    const r = await p;
    const metaBefore = JSON.stringify(r.meta);
    eq('S5 timeout 応答が返る', r.meta.softTimeout, true);
    // 打ち切り後に in-flight read を reject させる。
    check('S5 in-flight read が存在する（前提確認）', lateRejecters.length > 0);
    for (const rejectLate of lateRejecters) rejectLate();
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    eq('S5 unhandled rejection が発生しない', unhandled.length, before);
    eq('S5 返却済み meta は後から書き換わらない', JSON.stringify(r.meta), metaBefore);
  }

  console.log('\n[S6] canary 非許可 / kinds 空 → Source read も timer も導入されない');
  {
    const { timer, wasCancelled } = manualTimer();
    let selects = 0;
    const r = await loadCareerSourceData(
      KINDS,
      makeDeps(makeReader(() => ({ kind: 'resolve', rows: [] }), () => { selects += 1; }), timer),
      () => false, // authorize deny（canary 非対象）
    );
    eq('S6 deny は unauthorized（既存挙動を変えない）', r.meta.outcome, 'unauthorized');
    eq('S6 table read は 0 回（I/O ゼロを維持）', selects, 0);
    eq('S6 softTimeout は立たない', r.meta.softTimeout, undefined);
    check('S6 timer は cancel される', wasCancelled());

    const { timer: t2, wasCancelled: c2 } = manualTimer();
    let selects2 = 0;
    const r2 = await loadCareerSourceData(
      [],
      makeDeps(makeReader(() => ({ kind: 'resolve', rows: [] }), () => { selects2 += 1; }), t2),
    );
    eq('S6 kinds 空は skipped', r2.meta.outcome, 'skipped');
    eq('S6 kinds 空で I/O ゼロ', selects2, 0);
    check('S6 kinds 空では timer を張らない（cancel も不要）', !c2());
  }

  console.log('\n[S7] 合計時間予算の不変条件（Source read + AI + 余白 < 外側境界）');
  {
    const SOURCE = CAREER_SOURCE_READ_SOFT_TIMEOUT_MS; // 1_500
    // 応答 serialize / parse / 保存など AI 以外の処理に最低限残すべき headroom。
    // ★ 外側境界（maxDuration / client timeout）は絶対に引き上げない。
    //   headroom が薄い route は下の一覧で実測値を可視化し、報告対象とする。
    const MIN_HEADROOM_MS = 2_000;

    type RouteBound = {
      route: string;
      aiTotalMs: number;
      /** 実効的な外側境界（client abort があればその小さい方）。 */
      boundMs: number;
      boundSource: string;
      /** Data Spine の Source read が走る route か。 */
      sourceRead: boolean;
    };

    const ROUTES: RouteBound[] = [
      { route: 'company-research', aiTotalMs: AI_BUDGET_PRESET_80S_WALL.totalBudgetMs, boundMs: 80_000, boundSource: 'maxDuration=80', sourceRead: true },
      { route: 'consultation', aiTotalMs: AI_BUDGET_PRESET_80S_WALL.totalBudgetMs, boundMs: 80_000, boundSource: 'maxDuration=80', sourceRead: true },
      { route: 'interview/complete', aiTotalMs: AI_BUDGET_PRESET_80S_WALL.totalBudgetMs, boundMs: 80_000, boundSource: 'maxDuration=80', sourceRead: true },
      { route: 'interview/turn', aiTotalMs: AI_BUDGET_PRESET_80S_WALL.totalBudgetMs, boundMs: 80_000, boundSource: 'maxDuration=80', sourceRead: true },
      { route: 'presentation/qa', aiTotalMs: AI_BUDGET_PRESET_80S_WALL.totalBudgetMs, boundMs: 80_000, boundSource: 'maxDuration=80', sourceRead: true },
      { route: 'matching', aiTotalMs: 74_000, boundMs: 80_000, boundSource: 'maxDuration=80', sourceRead: true },
      { route: 'presentation/evaluate', aiTotalMs: 74_000, boundMs: 80_000, boundSource: 'maxDuration=80', sourceRead: true },
      { route: 'self-analysis/question', aiTotalMs: 30_000, boundMs: 35_000, boundSource: 'client QUESTION_TIMEOUT_MS=35s', sourceRead: true },
      { route: 'self-analysis (legacy sync)', aiTotalMs: 60_000, boundMs: 70_000, boundSource: 'client GENERATE_TIMEOUT_MS=70s', sourceRead: true },
    ];

    for (const r of ROUTES) {
      const source = r.sourceRead ? SOURCE : 0;
      const worstCase = source + r.aiTotalMs;
      const headroom = r.boundMs - worstCase;
      check(
        `S7 ${r.route}: source ${source / 1000}s + AI ${r.aiTotalMs / 1000}s = ${worstCase / 1000}s ≤ ${r.boundSource} (headroom ${headroom / 1000}s)`,
        worstCase <= r.boundMs && headroom >= MIN_HEADROOM_MS,
        `worstCase=${worstCase / 1000}s bound=${r.boundMs / 1000}s headroom=${headroom / 1000}s < min ${MIN_HEADROOM_MS / 1000}s`,
      );
    }

    // soft timeout は bundle 全体に 1 回だけ適用される（1500ms × N query にならない）契約。
    check(
      'S7 soft timeout は bundle 全体で 1 回（per-query ではない）',
      /Promise\.race/.test(readFileSync('lib/careerSourceData/serverReader.server.ts', 'utf8')),
    );
  }
}

void main().then(() => {
  finish();
});

function finish(): void {
  console.log(`\n結果: PASS ${passes} / FAIL ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

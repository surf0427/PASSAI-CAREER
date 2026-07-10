/*
 * scripts/career-event-signal-operational-guard-qa.ts
 *
 * PASSAI CAREER — Consultation Event Signal Pilot **Operational Guard** QA（P10-F 常設 harness）。
 *
 * 検証（本番 Supabase / 外部 AI 非接続・deterministic）:
 *   1. Guard flag eval（fail-closed: 未設定/invalid → 無効）。
 *   2. Client load gate（member+ON のみ loader 実行）。
 *   3. Server-authoritative block 解決（OFF → client 強制 body を無視して空文字）。
 *   4. On/Off matrix（reader 回数・body signal・render・prompt block・consultation 継続）。
 *   5. Fail-closed（missing/invalid/error → 無効・相談継続）。
 *   6. [P10-E 1-A closeout] Latency: fast/medium/true-near(900ms)/just-over(1100ms)/never/
 *      reject-before/reject-after-timeout（unhandled rejection なし）・reader 1回・timer 残存なし。
 *   7. [P10-E 1-B closeout] Rich context budget: Signal なし 0B / block・body JSON delta bounded。
 *   8. Guard OFF neutrality（heavy signal でも block 0B）。
 *   9. Context isolation（非対象 purpose に guard/signals 非混入）。
 *
 * 使い方: npx tsx scripts/career-event-signal-operational-guard-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evalConsultationEventSignalPilotEnabled,
  shouldLoadConsultationEventSignals,
} from '@/lib/careerMemory/eventSignalPilotGuard';
import {
  renderCareerEventSignalsCompact,
  resolveConsultationEventSignalsBlock,
} from '@/lib/careerMemory/renderEventSignals';
import { loadCareerEventSignalSummary } from '@/lib/careerMemory/loadEventSignals';
import type { CareerEventSignalRowsAdapter } from '@/lib/careerEvents/readSignals';
import type { CareerEventSignalSummary } from '@/lib/careerMemory/eventSignals';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-10T00:00:00.000Z');
const USER = '11111111-1111-4111-8111-111111111111';
const ROOT = process.cwd();
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dbRow(feature: string, eventType: string, offsetMs: number, band?: string) {
  return { feature, event_type: eventType, score_band: band, occurred_at: new Date(NOW - offsetMs).toISOString() };
}
function spy(rows: unknown, delayMs = 0): { adapter: CareerEventSignalRowsAdapter; calls: () => number } {
  let calls = 0;
  const adapter: CareerEventSignalRowsAdapter = async () => {
    calls += 1;
    if (delayMs) await sleep(delayMs);
    return rows;
  };
  return { adapter, calls: () => calls };
}
const validSummary: CareerEventSignalSummary = {
  version: 1, windowDays: 30,
  recentFeatures: ['interview', 'es'], featureUsage: { interview: '2-3', es: '1' },
  latestBands: { presentation: { band: 'A', recency: '7d' } }, activeAreaCount: 2, lastActivityRecency: '7d',
};
const heavySummary: CareerEventSignalSummary = {
  version: 1, windowDays: 30,
  recentFeatures: ['matching', 'consultation', 'interview', 'es', 'presentation'],
  featureUsage: { matching: '4+', consultation: '4+', interview: '4+', es: '4+', presentation: '4+', company_research: '4+', self_analysis: '4+', gd: '4+' },
  latestBands: { matching: { band: 'A', recency: '30d' }, presentation: { band: 'B', recency: '30d' }, gd: { band: 'C', recency: '30d' } },
  activeAreaCount: 8, lastActivityRecency: '24h',
};

// page の load 判定を再現（reader 回数を返す）。
async function simulatePageReaderCalls(userId: string | null | undefined, enabled: boolean): Promise<number> {
  const s = spy([dbRow('interview', 'feature_completed', DAY, 'B')]);
  if (shouldLoadConsultationEventSignals(userId, enabled)) {
    await loadCareerEventSignalSummary({ userId, now: NOW }, s.adapter);
  }
  return s.calls();
}

void (async () => {
  // ── 1. Guard flag eval（fail-closed） ─────────────────────────
  console.log('[1] guard flag eval (fail-closed)');
  {
    for (const v of ['true', '1', 'yes', ' TRUE ', 'Yes', '  1  ']) {
      check(`"${v.trim()}" → 有効`, evalConsultationEventSignalPilotEnabled(v) === true);
    }
    for (const v of ['false', '0', 'no', '', ' ', 'maybe', 'on', 'enabled']) {
      check(`"${v.trim() || '(empty)'}" → 無効`, evalConsultationEventSignalPilotEnabled(v) === false);
    }
    for (const v of [undefined, null, 1, true, {}, []]) {
      check(`非文字列(${JSON.stringify(v)}) → 無効(fail-closed)`, evalConsultationEventSignalPilotEnabled(v) === false);
    }
  }

  // ── 2. Client load gate ───────────────────────────────────────
  console.log('[2] client load gate');
  {
    check('member + ON → load する', shouldLoadConsultationEventSignals(USER, true) === true);
    check('member + OFF → load しない', shouldLoadConsultationEventSignals(USER, false) === false);
    check('guest("") + ON → load しない', shouldLoadConsultationEventSignals('', true) === false);
    check('null + ON → load しない', shouldLoadConsultationEventSignals(null, true) === false);
    check('undefined + ON → load しない', shouldLoadConsultationEventSignals(undefined, true) === false);
  }

  // ── 3. Server-authoritative block 解決 ────────────────────────
  console.log('[3] server-authoritative resolve');
  {
    check('OFF + valid summary → 空（無視）', resolveConsultationEventSignalsBlock(false, validSummary) === '');
    check('OFF + 強制 malicious body → 空（迂回不可）', resolveConsultationEventSignalsBlock(false, { version: 1, recentFeatures: ['interview'], featureUsage: { interview: '1' } }) === '');
    check('ON + valid summary → 非空', resolveConsultationEventSignalsBlock(true, validSummary) !== '');
    check('ON + undefined → 空', resolveConsultationEventSignalsBlock(true, undefined) === '');
    check('ON + invalid version → 空', resolveConsultationEventSignalsBlock(true, { ...validSummary, version: 5 }) === '');
    check('ON の出力は renderer と一致', resolveConsultationEventSignalsBlock(true, validSummary) === renderCareerEventSignalsCompact(validSummary));
  }

  // ── 4. On/Off matrix ──────────────────────────────────────────
  console.log('[4] on/off matrix');
  {
    // ON member: reader 1・block 非空。
    check('ON/member: reader 1回', (await simulatePageReaderCalls(USER, true)) === 1);
    check('ON/member: prompt block 非空', resolveConsultationEventSignalsBlock(true, validSummary) !== '');
    // ON guest: reader 0（guest は body signal なし）。
    check('ON/guest: reader 0回', (await simulatePageReaderCalls('', true)) === 0);
    // OFF member: reader 0・block 空。
    check('OFF/member: reader 0回', (await simulatePageReaderCalls(USER, false)) === 0);
    check('OFF/member: prompt block 空', resolveConsultationEventSignalsBlock(false, validSummary) === '');
    // OFF guest: reader 0・block 空。
    check('OFF/guest: reader 0回', (await simulatePageReaderCalls('', false)) === 0);
    check('OFF/guest: prompt block 空', resolveConsultationEventSignalsBlock(false, undefined) === '');
    // OFF + malicious body: server 迂回不可。
    check('OFF/malicious body: server block 空', resolveConsultationEventSignalsBlock(false, heavySummary) === '');
    // invalid/config error: 無効扱い → reader 0・block 空。
    check('invalid config → reader 0回', (await simulatePageReaderCalls(USER, evalConsultationEventSignalPilotEnabled('garbage'))) === 0);
    check('config error(非文字列) → reader 0回', (await simulatePageReaderCalls(USER, evalConsultationEventSignalPilotEnabled(undefined))) === 0);
  }

  // ── 5. Fail-closed ────────────────────────────────────────────
  console.log('[5] fail-closed');
  {
    for (const raw of [undefined, null, '', 'false', 'garbage', 0 as unknown]) {
      const enabled = evalConsultationEventSignalPilotEnabled(raw);
      check(`config=${JSON.stringify(raw)} → 無効`, enabled === false);
      check(`config=${JSON.stringify(raw)} → block 空（相談継続）`, resolveConsultationEventSignalsBlock(enabled, validSummary) === '');
      check(`config=${JSON.stringify(raw)} → loader gate false`, shouldLoadConsultationEventSignals(USER, enabled) === false);
    }
  }

  // ── 6. Latency closeout（P10-E 1-A） ──────────────────────────
  console.log('[6] latency (true near-timeout / just-over / reject-after)');
  {
    const rows = [dbRow('interview', 'feature_completed', DAY, 'B')];
    const t0 = Date.now();
    const fast = spy(rows, 0);
    check('fast: summary', !!(await loadCareerEventSignalSummary({ userId: USER, now: NOW }, fast.adapter)));
    check('fast: reader 1回', fast.calls() === 1);
    check('fast: timeout 未満で解決（timer 残存なし）', Date.now() - t0 < 400);

    check('medium(~200ms): summary', !!(await loadCareerEventSignalSummary({ userId: USER, now: NOW }, spy(rows, 200).adapter)));

    // true near-timeout: 900ms < 1000ms → 成功。
    const near = spy(rows, 900);
    const tn = Date.now();
    const rNear = await loadCareerEventSignalSummary({ userId: USER, now: NOW }, near.adapter);
    check('true near-timeout(900ms): summary 付与', !!rNear);
    check('true near-timeout: reader 1回', near.calls() === 1);
    check('true near-timeout: ~900ms 台で解決', Date.now() - tn >= 850 && Date.now() - tn < 1050);

    // just-over-timeout: 1100ms > 1000ms → undefined（timeout 勝ち）。
    const over = spy(rows, 1100);
    const to = Date.now();
    const rOver = await loadCareerEventSignalSummary({ userId: USER, now: NOW }, over.adapter);
    check('just-over-timeout(1100ms): undefined', rOver === undefined);
    check('just-over-timeout: ~1000ms 上限で解決', Date.now() - to < 1080);

    // never resolve → undefined。
    const never: CareerEventSignalRowsAdapter = () => new Promise<unknown>(() => {});
    check('never resolve → undefined', (await loadCareerEventSignalSummary({ userId: USER, now: NOW }, never)) === undefined);

    // reject before timeout → undefined。
    check('reject before timeout → undefined', (await loadCareerEventSignalSummary({ userId: USER, now: NOW }, (() => Promise.reject(new Error('early'))) as CareerEventSignalRowsAdapter)) === undefined);

    // reject after timeout → undefined ＋ unhandled rejection なし。
    let unhandled = false;
    const onUnhandled = () => { unhandled = true; };
    process.on('unhandledRejection', onUnhandled);
    const rejectAfter: CareerEventSignalRowsAdapter = () => new Promise<unknown>((_, rej) => setTimeout(() => rej(new Error('late')), 1100));
    const rRa = await loadCareerEventSignalSummary({ userId: USER, now: NOW }, rejectAfter);
    await sleep(300); // late rejection を通過させる
    process.removeListener('unhandledRejection', onUnhandled);
    check('reject-after-timeout: undefined', rRa === undefined);
    check('reject-after-timeout: unhandled rejection なし', unhandled === false);

    // timeout 値は request/入力から変更不可（loader signature に timeout param なし）。
    const loaderSrc = readFileSync(join(ROOT, 'lib/careerMemory/loadEventSignals.ts'), 'utf8');
    check('timeout は固定 const（1000ms）', /SIGNAL_SOFT_TIMEOUT_MS = 1000/.test(loaderSrc));
    // signature region（`loadCareerEventSignalSummary(` 〜 `): Promise`）に timeout param がない。
    const sigRegion = loaderSrc.slice(loaderSrc.indexOf('loadCareerEventSignalSummary('), loaderSrc.indexOf('): Promise'));
    check('loader signature に timeout param なし', sigRegion.length > 0 && !/timeout/i.test(sigRegion));
    check('timer cleanup（clearTimeout）あり', /clearTimeout\(timer\)/.test(loaderSrc));
  }

  // ── 7. Rich context budget closeout（P10-E 1-B） ──────────────
  console.log('[7] rich context budget');
  {
    const noSignalBlock = resolveConsultationEventSignalsBlock(true, undefined);
    const heavyBlock = resolveConsultationEventSignalsBlock(true, heavySummary);
    const heavyBodyJson = JSON.stringify({ eventSignals: heavySummary }); // request body に載る構造化 delta
    check('Signal block: no-signal 0B', bytes(noSignalBlock) === 0);
    check('Signal block: heavy <=700B（prompt delta）', bytes(heavyBlock) <= 700);
    check('request body eventSignals JSON <=700B', bytes(heavyBodyJson) <= 700);
    check('guard OFF → body/prompt delta 0（従来一致）', resolveConsultationEventSignalsBlock(false, heavySummary) === '' && !shouldLoadConsultationEventSignals(USER, false));
    console.log(`  info  budget: prompt block no-signal=0B heavy=${bytes(heavyBlock)}B / body JSON delta heavy=${bytes(heavyBodyJson)}B (consultation の full request body / system prompt 絶対 byte は career-event-signal-consolidation-qa で実測)`);
  }

  // ── 8. Guard OFF neutrality ───────────────────────────────────
  console.log('[8] guard OFF neutrality');
  {
    check('OFF: heavy signal でも block 空', resolveConsultationEventSignalsBlock(false, heavySummary) === '');
    check('OFF: loader gate 常に false（member/guest）', !shouldLoadConsultationEventSignals(USER, false) && !shouldLoadConsultationEventSignals('', false));
  }

  // ── 9. Context isolation ──────────────────────────────────────
  console.log('[9] context isolation');
  {
    const otherRoutes = [
      'app/api/career/matching/route.ts', 'app/api/career/es/route.ts', 'app/api/career/es-review/route.ts',
      'app/api/career/interview/complete/route.ts', 'app/api/career/presentation/evaluate/route.ts',
      'app/api/career/gd/feedback/route.ts', 'app/api/career/self-analysis/route.ts', 'app/api/career/company-research/route.ts',
    ];
    for (const rel of otherRoutes) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      check(`${rel} に guard/signals 非混入`, !/eventSignalPilotGuard|resolveConsultationEventSignalsBlock|renderCareerEventSignalsCompact|eventSignals|loadCareerEventSignalSummary/.test(src));
    }
    const pages = ['app/career/matching/page.tsx', 'app/career/es/run/page.tsx', 'app/career/interview/session/page.tsx', 'app/career/presentation/session/page.tsx', 'app/career/gd/session/page.tsx', 'app/career/self-analysis/run/page.tsx'];
    for (const rel of pages) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      check(`${rel} に guard/loader 非混入`, !/eventSignalPilotGuard|loadCareerEventSignalSummary/.test(src));
    }
    // consultation のみ guard を使う。
    check('consultation page が guard を使う', /eventSignalPilotGuard/.test(readFileSync(join(ROOT, 'app/career/consultation/page.tsx'), 'utf8')));
    check('consultation route が guard を使う', /eventSignalPilotGuard/.test(readFileSync(join(ROOT, 'app/api/career/consultation/route.ts'), 'utf8')));
  }

  console.log('');
  if (failures === 0) {
    console.log('career-event-signal-operational-guard-qa: ALL PASS');
    process.exit(0);
  } else {
    console.error(`career-event-signal-operational-guard-qa: ${failures} FAIL`);
    process.exit(1);
  }
})();

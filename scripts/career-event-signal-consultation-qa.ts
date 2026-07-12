/*
 * scripts/career-event-signal-consultation-qa.ts
 *
 * PASSAI CAREER — L2 Event Signal の consultation-only pilot QA（P10-D 常設 harness）。
 *
 * 対象:
 *   - lib/careerMemory/loadEventSignals.ts（reader+builder 結合・soft timeout・never throw）
 *   - lib/careerMemory/renderEventSignals.ts（compact 固定ラベル render・byte cap・誤推論防止 note）
 *   - purpose isolation（renderer / loader が consultation 以外の career route/page に混入しない）
 *
 * 厳守: 本番 Supabase 非接続（reader adapter stub）。secret / userId / rows / summary を出力しない。
 * 使い方: npx tsx scripts/career-event-signal-consultation-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCareerEventSignalSummary } from '@/lib/careerMemory/loadEventSignals';
import { renderCareerEventSignalsCompact } from '@/lib/careerMemory/renderEventSignals';
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

function dbRow(feature: string, eventType: string, offsetMs: number, band?: string, extra: Record<string, unknown> = {}) {
  return { feature, event_type: eventType, score_band: band, occurred_at: new Date(NOW - offsetMs).toISOString(), ...extra };
}
// now を記録する reader adapter stub（rows を返す）。
function rowsAdapter(rows: unknown): { adapter: CareerEventSignalRowsAdapter; calls: number } {
  const state = { calls: 0 };
  const adapter: CareerEventSignalRowsAdapter = async () => {
    state.calls += 1;
    return rows;
  };
  return { adapter, get calls() { return state.calls; } };
}

// 直接構築する summary fixture（renderer 用）。
function summaryFixture(over: Partial<CareerEventSignalSummary> = {}): CareerEventSignalSummary {
  return {
    version: 1,
    windowDays: 30,
    recentFeatures: ['interview', 'es', 'company_research'],
    featureUsage: { interview: '2-3', es: '1', company_research: '1' },
    latestBands: { presentation: { band: 'A', recency: '7d' }, gd: { band: 'B', recency: '30d' } },
    activeAreaCount: 3,
    lastActivityRecency: '7d',
    ...over,
  };
}

void (async () => {
  // ── A. Loader ─────────────────────────────────────────────────
  console.log('[A] loader');
  {
    // member + normal rows → summary。
    const a = rowsAdapter([dbRow('interview', 'feature_completed', DAY), dbRow('es', 'ai_generated', 2 * DAY)]);
    const s = await loadCareerEventSignalSummary({ userId: USER, now: NOW }, a.adapter);
    check('member + rows → summary', !!s && s.version === 1);
    check('reader は 1 回だけ呼ばれる', a.calls === 1);

    // member + 0 rows → undefined。
    const empty = await loadCareerEventSignalSummary({ userId: USER, now: NOW }, rowsAdapter([]).adapter);
    check('0件 → undefined', empty === undefined);

    // guest / userId なし → reader 未呼出・undefined。
    const g = rowsAdapter([dbRow('es', 'ai_generated', DAY)]);
    const guest = await loadCareerEventSignalSummary({ userId: null, now: NOW }, g.adapter);
    check('guest → undefined', guest === undefined);
    check('guest → reader 未呼出', g.calls === 0);

    // invalid userId → undefined。
    const inv = await loadCareerEventSignalSummary({ userId: 'not-a-uuid', now: NOW }, rowsAdapter([dbRow('es', 'ai_generated', DAY)]).adapter);
    check('invalid userId → undefined', inv === undefined);

    // reader undefined（adapter が非配列）→ undefined。
    const ru = await loadCareerEventSignalSummary({ userId: USER, now: NOW }, (async () => undefined) as CareerEventSignalRowsAdapter);
    check('reader undefined → undefined', ru === undefined);

    // reader throw → undefined（never throw）。
    let threw = false;
    let rt: unknown = 'x';
    try {
      rt = await loadCareerEventSignalSummary({ userId: USER, now: NOW }, (async () => { throw new Error('boom'); }) as CareerEventSignalRowsAdapter);
    } catch { threw = true; }
    check('reader throw → undefined', rt === undefined);
    check('reader throw でも load は throw しない', threw === false);

    // builder null（全 row window 外）→ undefined。
    const bn = await loadCareerEventSignalSummary({ userId: USER, now: NOW }, rowsAdapter([dbRow('es', 'ai_generated', 40 * DAY)]).adapter);
    check('builder null（window外）→ undefined', bn === undefined);

    // timeout → undefined（never-resolving adapter・soft 1000ms）。
    const neverResolve: CareerEventSignalRowsAdapter = () => new Promise<unknown>(() => {});
    let toThrew = false;
    let to: unknown = 'x';
    try {
      to = await loadCareerEventSignalSummary({ userId: USER, now: NOW }, neverResolve);
    } catch { toThrew = true; }
    check('timeout → undefined', to === undefined);
    check('timeout でも throw しない', toThrew === false);
  }

  // ── B. Renderer golden ────────────────────────────────────────
  console.log('[B] renderer golden');
  {
    const full = renderCareerEventSignalsCompact(summaryFixture());
    check('heading を含む', full.includes('【参考：最近30日の利用傾向】'));
    check('直近利用行（日本語ラベル）', full.includes('・直近利用：面接、ES、企業研究'));
    check('利用量行（bucket）', full.includes('・利用量の目安：面接 2-3、ES 1、企業研究 1'));
    check('最新評価帯行（band+recency）', full.includes('・最新評価帯（練習時点）：プレゼン A（7日以内）、GD B（30日以内）'));
    check('固定 note を含む', full.includes('※参考情報です。利用量・未利用・評価帯は能力・意欲・適性・合否・弱みを意味しません'));
    check('note に本人入力優先', full.includes('本人の入力を最優先'));
    check('note に次の準備提案の補助', full.includes('次の準備提案の補助'));
    check('最大5行', full.split('\n').length <= 5);
    check('heading は1回', (full.match(/【参考/g) ?? []).length === 1);
    check('note は1回', (full.match(/※参考情報/g) ?? []).length === 1);
    check('exact timestamp なし', !/\d{4}-\d{2}-\d{2}T/.test(full));
    check('生 JSON なし', !/[{}\[\]]/.test(full));

    // 1 feature のみ。
    const one = renderCareerEventSignalsCompact(summaryFixture({ recentFeatures: ['es'], featureUsage: { es: '1' }, latestBands: undefined }));
    check('1 feature: 直近利用 ES', one.includes('・直近利用：ES'));
    check('1 feature: latestBands 行なし', !one.includes('最新評価帯'));
    check('1 feature: note は残る', one.includes('※参考情報'));

    // latestBands なし。
    const noBands = renderCareerEventSignalsCompact(summaryFixture({ latestBands: undefined }));
    check('latestBands なし → 評価帯行なし', !noBands.includes('最新評価帯'));

    // 全 usage bucket 種。
    const buckets = renderCareerEventSignalsCompact(summaryFixture({
      recentFeatures: ['matching', 'es', 'gd'],
      featureUsage: { matching: '4+', es: '2-3', gd: '1' },
      latestBands: undefined,
    }));
    check('bucket 4+/2-3/1 表示', buckets.includes('マッチング 4+') && buckets.includes('ES 2-3') && buckets.includes('GD 1'));

    // canonical order（latestBands は matching→presentation→gd）。
    const order = renderCareerEventSignalsCompact(summaryFixture({
      latestBands: { gd: { band: 'C', recency: '30d' }, matching: { band: 'A', recency: '7d' }, presentation: { band: 'B', recency: '7d' } },
    }));
    const bandLine = order.split('\n').find((l) => l.includes('最新評価帯')) ?? '';
    check('latestBands canonical 順（マッチング→プレゼン→GD）', bandLine.indexOf('マッチング') < bandLine.indexOf('プレゼン') && bandLine.indexOf('プレゼン') < bandLine.indexOf('GD'));

    // unknown / 破損値 → 表示しない（型を外れた untrusted 入力を renderer(unknown) へ直接渡す）。
    const brokenInput: Record<string, unknown> = {
      version: 1,
      windowDays: 30,
      recentFeatures: ['nope', 'interview', 123],
      featureUsage: { nope: 'x', interview: '2-3', es: 'BAD' },
      latestBands: { matching: { band: 'Z', recency: '7d' }, gd: { band: 'B', recency: 'weird' } },
      activeAreaCount: 2,
      lastActivityRecency: '7d',
    };
    const broken = renderCareerEventSignalsCompact(brokenInput);
    check('unknown feature 非表示', !broken.includes('nope') && !broken.includes('123'));
    check('invalid bucket 非表示（es BAD drop）', !/ES BAD|ES x/.test(broken));
    check('invalid band 非表示（matching Z drop）', !broken.includes('マッチング Z'));
    check('recency 不正でも band は表示（括弧なし）', broken.includes('GD B') && !broken.includes('GD B（'));

    // empty / null 相当 → 描画なし。
    check('undefined → 空', renderCareerEventSignalsCompact(undefined) === '');
    check('null → 空', renderCareerEventSignalsCompact(null) === '');
    check('{} → 空', renderCareerEventSignalsCompact({}) === '');
    check('version!=1 → 空', renderCareerEventSignalsCompact({ ...summaryFixture(), version: 2 }) === '');
    check('data 行なし → 空（note だけにしない）', renderCareerEventSignalsCompact(summaryFixture({ recentFeatures: [], featureUsage: {}, latestBands: undefined })) === '');

    // byte cap。
    const heavy = renderCareerEventSignalsCompact(summaryFixture({
      recentFeatures: ['matching', 'consultation', 'interview', 'es', 'presentation'],
      featureUsage: { matching: '4+', consultation: '4+', interview: '4+', es: '4+', presentation: '4+', company_research: '4+', self_analysis: '4+', gd: '4+' },
      latestBands: { matching: { band: 'A', recency: '30d' }, presentation: { band: 'B', recency: '30d' }, gd: { band: 'C', recency: '30d' } },
    }));
    const heavyBytes = Buffer.byteLength(heavy, 'utf8');
    check(`heavy <= 700 bytes（実測 ${heavyBytes}）`, heavyBytes <= 700);
    console.log(`  info  full render bytes=${Buffer.byteLength(full, 'utf8')} / heavy bytes=${heavyBytes}`);
    console.log('  info  full render:\n' + full.split('\n').map((l) => '        ' + l).join('\n'));
  }

  // ── C. PII / raw text ─────────────────────────────────────────
  console.log('[C] PII / raw text');
  {
    // summary に余分な本文/PII property を混ぜても renderer は既知 field しか読まない。
    const junky = {
      ...summaryFixture(),
      name: '山田太郎', email: 'a@b.com', university: '東京大学', companyName: '秘密社',
      metadata: { body: 'ES本文' }, prompt: 'prompt本文', transcript: 'GD発言', joinCode: 'ABC123',
      userId: USER, id: 'evt-1', clientEventId: 'cid', companyId: 'coid',
    } as unknown as CareerEventSignalSummary;
    const out = renderCareerEventSignalsCompact(junky);
    for (const m of ['山田太郎', 'a@b.com', '東京大学', '秘密社', 'ES本文', 'prompt本文', 'GD発言', 'ABC123', USER, 'evt-1', 'cid', 'coid']) {
      check(`PII/本文 非出力: ${m.slice(0, 6)}`, !out.includes(m));
    }
    check('render は正常 field のみ出力', out.includes('面接') && out.includes('※参考情報'));
  }

  // ── D. Purpose isolation（静的） ───────────────────────────────
  console.log('[D] purpose isolation（renderer/loader は consultation 限定）');
  {
    const root = process.cwd();
    const consultationRoute = readFileSync(join(root, 'app/api/career/consultation/route.ts'), 'utf8');
    check('consultation route が guard 経由 renderer を使う', /resolveConsultationEventSignalsBlock/.test(consultationRoute) && /b\.eventSignals/.test(consultationRoute) && /isConsultationEventSignalPilotEnabled/.test(consultationRoute));

    // 他の career API route に renderer / eventSignals が混入していないこと。
    const otherRoutes = [
      'app/api/career/matching/route.ts',
      'app/api/career/es/route.ts',
      'app/api/career/es-review/route.ts',
      'app/api/career/interview/complete/route.ts',
      'app/api/career/interview/turn/route.ts',
      'app/api/career/presentation/evaluate/route.ts',
      'app/api/career/gd/feedback/route.ts',
      'app/api/career/self-analysis/route.ts',
      'app/api/career/company-research/route.ts',
    ];
    for (const rel of otherRoutes) {
      const src = readFileSync(join(root, rel), 'utf8');
      check(`${rel} に signals 非混入`, !/renderCareerEventSignalsCompact|resolveConsultationEventSignalsBlock|eventSignals|loadCareerEventSignalSummary/.test(src));
    }
    // loader の production call site は consultation page のみ。
    const consultPage = readFileSync(join(root, 'app/career/consultation/page.tsx'), 'utf8');
    check('consultation page が loader を呼ぶ', /loadCareerEventSignalSummary/.test(consultPage));
    for (const rel of ['app/career/matching/page.tsx', 'app/career/es/run/page.tsx', 'app/career/interview/session/page.tsx']) {
      const src = readFileSync(join(root, rel), 'utf8');
      check(`${rel} は loader を呼ばない`, !/loadCareerEventSignalSummary/.test(src));
    }
  }

  // ── E. No-signal neutrality（renderer が空を返す＝route で filter 除去） ─────
  console.log('[E] no-signal neutrality');
  {
    // route の systemPrompt は空ブロックを filter する。renderer が '' を返す全ケースで body 不変。
    check('undefined → 空（block 除去）', renderCareerEventSignalsCompact(undefined) === '');
    check('null → 空', renderCareerEventSignalsCompact(null) === '');
    check('空 summary → 空', renderCareerEventSignalsCompact(summaryFixture({ recentFeatures: [], featureUsage: {}, latestBands: undefined })) === '');
    // route が b.eventSignals 未指定時に空文字ブロックを生む（既存 prompt golden 不変の根拠）。
    // P15-D: system prompt の組み立ては pure builder（consultationPrompt.ts）へ抽出され、Personal Memory
    //   由来の横断ブロック（matching 等）は Orchestrator 経由の crossFeatureContext に集約された。
    //   Event Signal の resolve は route が現行どおり行い（guard 経由）、builder が現行位置へ挿入する。
    //   → 空ブロック filter と「eventSignalsBlock は Personal Memory の後・OUTPUT の前」の不変条件は
    //     builder 側で検証する（Event Signal の behavior・production code は不変）。
    const routeSrc = readFileSync(join(process.cwd(), 'app/api/career/consultation/route.ts'), 'utf8');
    const builderSrc = readFileSync(join(process.cwd(), 'app/api/career/consultation/consultationPrompt.ts'), 'utf8');
    check('route が guard 経由で eventSignalsBlock を resolve する', /resolveConsultationEventSignalsBlock\(/.test(routeSrc) && /isConsultationEventSignalPilotEnabled\(/.test(routeSrc));
    check('builder が空ブロックを filter する', /\.filter\(\(s\) => s !== ''\)/.test(builderSrc));
    check('eventSignalsBlock は Personal Memory(crossFeatureContext)の後・OUTPUT の前（最下位補助）', builderSrc.indexOf('input.eventSignalsBlock,') > builderSrc.indexOf('orchestrated.crossFeatureContext,') && builderSrc.indexOf('input.eventSignalsBlock,') < builderSrc.indexOf('OUTPUT_FORMAT_INSTRUCTION,'));
  }

  // ── F. Consultation signal fixture ────────────────────────────
  console.log('[F] consultation signal fixture');
  {
    const out = renderCareerEventSignalsCompact(summaryFixture());
    check('Signal block が 1 回だけ表示', (out.match(/【参考/g) ?? []).length === 1);
    check('note が 1 回', (out.match(/※参考情報/g) ?? []).length === 1);
    check('exact count なし（数値は bucket/band のみ）', !/：\d+回|\b\d{2,}\b/.test(out.replace(/30日|24|7日/g, '')));
    check('exact timestamp なし', !/\d{4}-\d{2}-\d{2}/.test(out));
    check('能力/意欲を断定する語がない', !/能力が高い|意欲が高い|苦手|得意です/.test(out));
    check('本人入力優先が明示', out.includes('本人の入力を最優先'));
    check('次アクション補助に限定', out.includes('次の準備提案の補助'));
    check('render cap 以内（<=700B）', Buffer.byteLength(out, 'utf8') <= 700);
  }

  // ── G. Budget（no-signal / normal / heavy の delta） ───────────
  console.log('[G] budget');
  {
    const noSignal = renderCareerEventSignalsCompact(undefined);
    const normal = renderCareerEventSignalsCompact(summaryFixture());
    const heavy = renderCareerEventSignalsCompact(summaryFixture({
      recentFeatures: ['matching', 'consultation', 'interview', 'es', 'presentation'],
      featureUsage: { matching: '4+', consultation: '4+', interview: '4+', es: '4+', presentation: '4+', company_research: '4+', self_analysis: '4+', gd: '4+' },
      latestBands: { matching: { band: 'A', recency: '30d' }, presentation: { band: 'B', recency: '30d' }, gd: { band: 'C', recency: '30d' } },
    }));
    check('no-signal delta = 0（body-neutral）', noSignal === '' && Buffer.byteLength(noSignal, 'utf8') === 0);
    check('normal delta bounded (<=700B)', Buffer.byteLength(normal, 'utf8') <= 700);
    check('heavy delta bounded (<=700B)', Buffer.byteLength(heavy, 'utf8') <= 700);
    console.log(`  info  budget: no-signal=0B / normal=${Buffer.byteLength(normal, 'utf8')}B / heavy=${Buffer.byteLength(heavy, 'utf8')}B`);
  }

  console.log('');
  if (failures === 0) {
    console.log('career-event-signal-consultation-qa: ALL PASS');
    process.exit(0);
  } else {
    console.error(`career-event-signal-consultation-qa: ${failures} FAIL`);
    process.exit(1);
  }
})();

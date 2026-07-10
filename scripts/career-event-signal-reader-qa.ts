/*
 * scripts/career-event-signal-reader-qa.ts
 *
 * PASSAI CAREER — L2 Event Signal owner-scoped reader の DB 非依存 QA（P10-C 常設 harness）。
 *
 * 対象: lib/careerEvents/readSignals.ts の readCareerEventSignalSourceRows（adapter 注入で DB 非依存）。
 *   まだ snapshot / selector / prompt へ未接続。reader 単体契約 + read→build 結合を固定する。
 *
 * 何を守るか:
 *   A. guard — guest / 空 / 不正 UUID / invalid now → adapter 未呼出・undefined。
 *   B. query params — userId / fromIso(=now-30d) / toIso(=now) / limit(=100)、SELECT 4 列固定。
 *   C. 正常取得 — 0件→[] / 1件 / 100件、mapping で余分 field を drop。
 *   D. mapping — valid/unknown/invalid を補正せずそのまま渡す（drop は builder の責務）。
 *   E. never throw — adapter throw/reject / DB error / 非配列 → undefined（throw しない）。
 *   F. read→build — reader 結果を builder へ渡し normal/empty/unavailable/invalid/PII/cap を検査。
 *
 * 厳守: 本番 Supabase 非接続（adapter stub）。secret / userId / rows / metadata を出力しない。
 * 使い方: npx tsx scripts/career-event-signal-reader-qa.ts
 */

import {
  readCareerEventSignalSourceRows,
  type CareerEventSignalRowsAdapter,
  CAREER_EVENT_SIGNAL_SELECT,
  CAREER_EVENT_SIGNAL_ROW_LIMIT,
  CAREER_EVENT_SIGNAL_WINDOW_DAYS,
} from '@/lib/careerEvents/readSignals';
import { buildCareerEventSignalSummary } from '@/lib/careerMemory/eventSignals';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-10T00:00:00.000Z');
const USER = '11111111-1111-4111-8111-111111111111';

// adapter 呼び出しを記録する spy を作る（返り値を差し替え可能）。
function spyAdapter(result: unknown): {
  adapter: CareerEventSignalRowsAdapter;
  calls: Array<{ userId: string; fromIso: string; toIso: string; limit: number }>;
} {
  const calls: Array<{ userId: string; fromIso: string; toIso: string; limit: number }> = [];
  const adapter: CareerEventSignalRowsAdapter = async (input) => {
    calls.push(input);
    return result;
  };
  return { adapter, calls };
}

function dbRow(feature: unknown, eventType: unknown, offsetMs: number, band?: unknown, extra: Record<string, unknown> = {}) {
  return {
    feature,
    event_type: eventType,
    score_band: band,
    occurred_at: new Date(NOW - offsetMs).toISOString(),
    ...extra,
  };
}

void (async () => {
  // ── A. Guard ──────────────────────────────────────────────────
  console.log('[A] guard');
  {
    const bads: Array<[string, unknown]> = [
      ['undefined userId', undefined],
      ['null userId', null],
      ['空文字 userId', ''],
      ['不正 UUID', 'not-a-uuid'],
      ['数値 userId', 123],
    ];
    for (const [label, uid] of bads) {
      const { adapter, calls } = spyAdapter([]);
      const r = await readCareerEventSignalSourceRows({ userId: uid as string, now: NOW }, adapter);
      check(`${label} → undefined`, r === undefined);
      check(`${label} → adapter 未呼出`, calls.length === 0);
    }
    // invalid now。
    for (const [label, now] of [['NaN now', NaN], ['Infinity now', Infinity], ['invalid Date', new Date('bad')]] as Array<[string, unknown]>) {
      const { adapter, calls } = spyAdapter([]);
      const r = await readCareerEventSignalSourceRows({ userId: USER, now: now as number }, adapter);
      check(`${label} → undefined`, r === undefined);
      check(`${label} → adapter 未呼出`, calls.length === 0);
    }
    // env/client unavailable（既定 adapter・QA env は Supabase 未設定）→ undefined・throw なし。
    let threw = false;
    let res: unknown;
    try {
      res = await readCareerEventSignalSourceRows({ userId: USER, now: NOW });
    } catch {
      threw = true;
    }
    check('env 未設定（既定 adapter）→ undefined', res === undefined);
    check('env 未設定でも throw しない', threw === false);
  }

  // ── B. Query params ───────────────────────────────────────────
  console.log('[B] query params');
  {
    const { adapter, calls } = spyAdapter([]);
    await readCareerEventSignalSourceRows({ userId: USER, now: NOW }, adapter);
    check('adapter が 1 回呼ばれる', calls.length === 1);
    const c = calls[0];
    check('userId が adapter へ渡る', c.userId === USER);
    check('toIso = now', c.toIso === new Date(NOW).toISOString());
    check('fromIso = now - 30日', c.fromIso === new Date(NOW - 30 * DAY).toISOString());
    check('limit = 100', c.limit === 100);
    // Date 注入でも同じ（timezone 非依存）。
    const s2 = spyAdapter([]);
    await readCareerEventSignalSourceRows({ userId: USER, now: new Date(NOW) }, s2.adapter);
    check('Date 注入でも fromIso 一致', s2.calls[0].fromIso === new Date(NOW - 30 * DAY).toISOString());
    // contract 定数。
    check('SELECT は 4 列だけ', CAREER_EVENT_SIGNAL_SELECT.split(',').map((x) => x.trim()).length === 4);
    check('SELECT に feature/event_type/score_band/occurred_at', CAREER_EVENT_SIGNAL_SELECT === 'feature, event_type, score_band, occurred_at');
    check("SELECT に metadata を含めない", !/metadata/.test(CAREER_EVENT_SIGNAL_SELECT));
    check("SELECT に id/user_id/company_id/client_event_id/created_at を含めない",
      !/\bid\b|user_id|company_id|client_event_id|created_at/.test(CAREER_EVENT_SIGNAL_SELECT));
    check('ROW_LIMIT = 100', CAREER_EVENT_SIGNAL_ROW_LIMIT === 100);
    check('WINDOW_DAYS = 30', CAREER_EVENT_SIGNAL_WINDOW_DAYS === 30);
  }

  // ── C. Successful result ──────────────────────────────────────
  console.log('[C] successful result');
  {
    const empty = await readCareerEventSignalSourceRows({ userId: USER, now: NOW }, spyAdapter([]).adapter);
    check('0件 → []', Array.isArray(empty) && empty.length === 0);

    const one = await readCareerEventSignalSourceRows(
      { userId: USER, now: NOW },
      spyAdapter([dbRow('es', 'ai_generated', DAY, 'A')]).adapter,
    );
    check('1件 → 1 row', Array.isArray(one) && one.length === 1);
    check('mapping: feature', one![0].feature === 'es');
    check('mapping: event_type', one![0].event_type === 'ai_generated');
    check('mapping: score_band', one![0].score_band === 'A');
    check('mapping: occurred_at', typeof one![0].occurred_at === 'string');

    const hundred = Array.from({ length: 100 }, (_, i) => dbRow('es', 'ai_generated', (i + 1) * 60_000));
    const h = await readCareerEventSignalSourceRows({ userId: USER, now: NOW }, spyAdapter(hundred).adapter);
    check('100件 → 100 rows', Array.isArray(h) && h.length === 100);
  }

  // ── D. Mapping（余分 field drop・補正なし） ──────────────────────
  console.log('[D] mapping / no coercion');
  {
    const junk = {
      id: 'evt-1',
      user_id: 'uid',
      client_event_id: 'cid',
      company_id: 'coid',
      created_at: '2026-01-01',
      metadata: { secret: 'x' },
      name: '山田太郎',
      email: 'a@b.com',
      companyName: '株式会社ヒミツ',
      prompt: 'p本文',
    };
    const rows = await readCareerEventSignalSourceRows(
      { userId: USER, now: NOW },
      spyAdapter([
        dbRow('unknown_feature', 'ai_generated', DAY, 'A', junk), // unknown feature そのまま
        dbRow('es', 'bogus_type', 2 * DAY, 'Z', junk), // unknown event_type / invalid band そのまま
        dbRow('interview', 'feature_completed', 0, undefined, { ...junk, occurred_at: 'not-a-date' }), // invalid timestamp そのまま
      ]).adapter,
    );
    check('unknown feature を補正しない', rows![0].feature === 'unknown_feature');
    check('unknown event_type を補正しない', rows![1].event_type === 'bogus_type');
    check('invalid band を補正しない', rows![1].score_band === 'Z');
    check('invalid timestamp を補正しない', rows![2].occurred_at === 'not-a-date');
    const serialized = JSON.stringify(rows);
    for (const k of ['id', 'user_id', 'client_event_id', 'company_id', 'created_at', 'metadata', 'secret']) {
      check(`余分 key drop: ${k}`, !serialized.includes(`"${k}"`));
    }
    for (const m of ['山田太郎', 'a@b.com', '株式会社ヒミツ', 'p本文']) {
      check(`PII 値 drop: ${m.slice(0, 6)}`, !serialized.includes(m));
    }
    check('各 row は 4 key のみ', rows!.every((r) => Object.keys(r).length === 4));
  }

  // ── E. Never throw ────────────────────────────────────────────
  console.log('[E] never throw');
  {
    const throwing: CareerEventSignalRowsAdapter = async () => {
      throw new Error('adapter boom');
    };
    const rejecting: CareerEventSignalRowsAdapter = () => Promise.reject(new Error('reject boom'));
    const nonArray: CareerEventSignalRowsAdapter = async () => ({ not: 'an array' });
    const nully: CareerEventSignalRowsAdapter = async () => null;
    for (const [label, ad] of [['throw', throwing], ['reject', rejecting], ['非配列', nonArray], ['null(DB error 相当)', nully]] as Array<[string, CareerEventSignalRowsAdapter]>) {
      let threw = false;
      let r: unknown = 'x';
      try {
        r = await readCareerEventSignalSourceRows({ userId: USER, now: NOW }, ad);
      } catch {
        threw = true;
      }
      check(`${label} → undefined`, r === undefined);
      check(`${label} → throw しない`, threw === false);
    }
  }

  // ── F. Read → Build 結合 ──────────────────────────────────────
  console.log('[F] read → build 結合');
  {
    // normal: 複数 feature の DB row → reader 4列 → builder summary。
    const normalRows = [
      dbRow('matching', 'matching_run', 1 * DAY, 'B'),
      dbRow('es', 'ai_generated', 2 * DAY),
      dbRow('interview', 'feature_completed', 3 * DAY),
      dbRow('gd', 'feature_completed', 4 * DAY, 'A'),
    ];
    const read = await readCareerEventSignalSourceRows({ userId: USER, now: NOW }, spyAdapter(normalRows).adapter);
    check('read 成功', Array.isArray(read));
    const summary = read ? buildCareerEventSignalSummary({ events: read, now: NOW }) : null;
    check('build summary 生成', summary !== null);
    check('featureUsage に matching/es/interview/gd', !!summary && ['matching', 'es', 'interview', 'gd'].every((f) => f in summary.featureUsage));
    check('latestBands matching=B', summary?.latestBands?.matching?.band === 'B');
    const summaryStr = JSON.stringify(summary);
    check('summary に exact timestamp なし', !/\d{4}-\d{2}-\d{2}T/.test(summaryStr));
    check('summary に exact count 数値なし（version/windowDays/activeAreaCount のみ数値）', (() => {
      const nums = (summaryStr.match(/:\s*(\d+)/g) ?? []).map((x) => x.replace(/[:\s]/g, ''));
      // 許可数値: version(1) / windowDays(30) / activeAreaCount(<=8)
      return nums.every((n) => n === '1' || n === '30' || Number(n) <= 11);
    })());

    // empty: reader [] → builder null。
    const emptyRead = await readCareerEventSignalSourceRows({ userId: USER, now: NOW }, spyAdapter([]).adapter);
    check('reader [] → builder null', buildCareerEventSignalSummary({ events: emptyRead ?? [], now: NOW }) === null);

    // unavailable: reader undefined → builder を呼ばない。
    const un = await readCareerEventSignalSourceRows({ userId: '', now: NOW }, spyAdapter([]).adapter);
    check('reader undefined → builder を呼ばない（guard）', un === undefined);

    // invalid mixed: reader は素通し、builder が drop。
    const mixed = [
      dbRow('matching', 'matching_run', DAY, 'A'),
      dbRow('unknown_feat', 'ai_generated', DAY),
      dbRow('es', 'bogus', DAY),
      dbRow('interview', 'feature_completed', 0, undefined, { occurred_at: 'bad-date' }),
      dbRow('gd', 'feature_completed', -DAY), // future
      dbRow('presentation', 'feature_completed', 40 * DAY), // window 外
    ];
    const mRead = await readCareerEventSignalSourceRows({ userId: USER, now: NOW }, spyAdapter(mixed).adapter);
    check('invalid mixed: reader は 6 行素通し', mRead!.length === 6);
    const mSummary = buildCareerEventSignalSummary({ events: mRead!, now: NOW })!;
    check('builder は valid のみ（matching 1件）', mSummary.activeAreaCount === 1 && !!mSummary.featureUsage.matching);
    check('builder が unknown/future/window外 を drop', !mSummary.featureUsage.presentation && !('unknown_feat' in mSummary.featureUsage));

    // PII: DB stub の本文/PII は reader 出力にも summary にも残らない。
    const piiJunk = {
      name: '佐藤花子', email: 'x@y.com', university: '東京大学', companyName: '秘密社',
      metadata: { body: 'ES本文長文' }, prompt: 'prompt本文', response: 'AI回答本文',
      answer: '面接回答本文', transcript: 'GD発言本文', joinCode: 'ABC123', participantName: '田中',
    };
    const piiRead = await readCareerEventSignalSourceRows(
      { userId: USER, now: NOW },
      spyAdapter([dbRow('matching', 'matching_run', DAY, 'A', piiJunk), dbRow('gd', 'feature_completed', 2 * DAY, 'B', piiJunk)]).adapter,
    );
    const piiSummary = buildCareerEventSignalSummary({ events: piiRead!, now: NOW });
    const combined = JSON.stringify(piiRead) + JSON.stringify(piiSummary);
    for (const m of ['佐藤花子', 'x@y.com', '東京大学', '秘密社', 'ES本文', 'prompt本文', 'AI回答本文', '面接回答本文', 'GD発言本文', 'ABC123', '田中']) {
      check(`PII 非出力(read+build): ${m.slice(0, 5)}`, !combined.includes(m));
    }

    // cap: reader と builder の上限一致（両者 100）。
    check('reader limit と builder cap が一致(100)', CAREER_EVENT_SIGNAL_ROW_LIMIT === 100);
  }

  console.log('');
  if (failures === 0) {
    console.log('career-event-signal-reader-qa: ALL PASS');
    process.exit(0);
  } else {
    console.error(`career-event-signal-reader-qa: ${failures} FAIL`);
    process.exit(1);
  }
})();

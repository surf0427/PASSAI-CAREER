/*
 * scripts/career-event-signals-qa.ts
 *
 * PASSAI CAREER — L2 Personal Event Signal builder の決定論 / PII / byte QA（P10-B 常設 harness）。
 *
 * 対象: lib/careerMemory/eventSignals.ts の pure builder `buildCareerEventSignalSummary`。
 *   まだ snapshot / selector / prompt へ未接続（body byte 不変）。builder 単体の契約を固定する。
 *
 * 何を守るか:
 *   - empty/invalid/unknown/future/window 外 → 無視、有効ゼロ → null。
 *   - 30 日 window 境界（開始 inclusive / now inclusive）。
 *   - usage bucket（1 / 2-3 / 4+・exact count なし・利用なしは key なし）。
 *   - recentFeatures（recency desc・dedup・最大5・同一 ts は canonical order・入力順非依存）。
 *   - lastActivityRecency（24h/7d/30d 境界）。
 *   - latestBands（matching/presentation/gd のみ・band 失効・曖昧 ts は省略・非 band feature 除外）。
 *   - source cap 100（古い 101 件目は結果を変えない・最新採用・mutation なし）。
 *   - determinism（同 input+now は完全一致・shuffle 不変・object key 順安定）。
 *   - duplicate 責務（builder は dedupe しない＝bucket 境界を跨ぐ）。
 *   - PII/本文（余分な metadata/氏名/本文 property は output に出ない）。byte（normal<=300 / heavy<=512）。
 *
 * 使い方: npx tsx scripts/career-event-signals-qa.ts
 * 終了コード: 全 assertion PASS → 0 / いずれか FAIL → 1。
 */

import {
  buildCareerEventSignalSummary,
  type CareerEventSignalSourceRow,
} from '@/lib/careerMemory/eventSignals';

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
// 固定 now（決定論。マシン時刻非依存）。
const NOW = Date.parse('2026-07-10T00:00:00.000Z');

// now から offsetMs だけ過去の occurred_at を持つ source row。
function row(
  feature: string,
  eventType: string,
  offsetMs: number,
  band?: string,
  extra: Record<string, unknown> = {},
): CareerEventSignalSourceRow {
  return {
    feature,
    event_type: eventType,
    ...(band !== undefined ? { score_band: band } : {}),
    occurred_at: new Date(NOW - offsetMs).toISOString(),
    ...extra,
  } as CareerEventSignalSourceRow;
}

function build(events: CareerEventSignalSourceRow[], now: number = NOW) {
  return buildCareerEventSignalSummary({ events, now });
}

// ── 1. Empty / Invalid ────────────────────────────────────────────
console.log('[1] empty / invalid');
{
  check('空配列 → null', build([]) === null);
  check('全件 window 外 → null', build([row('es', 'ai_generated', 31 * DAY)]) === null);
  check('全件 future → null', build([row('es', 'ai_generated', -DAY)]) === null);
  check('invalid timestamp → 無視 → null', build([{ feature: 'es', event_type: 'ai_generated', occurred_at: 'not-a-date' }]) === null);
  check('unknown feature → 無視 → null', build([row('nope', 'ai_generated', DAY)]) === null);
  check('unknown event_type → 無視 → null', build([row('es', 'bogus', DAY)]) === null);
  check('now not finite → null', buildCareerEventSignalSummary({ events: [row('es', 'ai_generated', DAY)], now: NaN }) === null);
  const mixed = build([
    row('es', 'ai_generated', DAY),
    row('nope', 'ai_generated', DAY),
    { feature: 'interview', event_type: 'bogus', occurred_at: new Date(NOW).toISOString() },
    { feature: 'interview', event_type: 'feature_completed', occurred_at: 'bad' },
  ]);
  check('valid/invalid 混在 → valid のみ', mixed !== null && mixed.activeAreaCount === 1 && !!mixed.featureUsage.es);
}

// ── 2. Window 境界 ────────────────────────────────────────────────
console.log('[2] window 境界');
{
  check('30日前ちょうど → 含む', build([row('es', 'ai_generated', 30 * DAY)]) !== null);
  check('30日+1ms前 → 除外 → null', build([row('es', 'ai_generated', 30 * DAY + 1)]) === null);
  check('now ちょうど → 含む', build([row('es', 'ai_generated', 0)]) !== null);
  check('now+1ms → 除外 → null', build([row('es', 'ai_generated', -1)]) === null);
}

// ── 3. Usage bucket ───────────────────────────────────────────────
console.log('[3] usage bucket');
{
  const mk = (n: number) => Array.from({ length: n }, (_, i) => row('es', 'ai_generated', (i + 1) * 60_000));
  check('1件 → "1"', build(mk(1))?.featureUsage.es === '1');
  check('2件 → "2-3"', build(mk(2))?.featureUsage.es === '2-3');
  check('3件 → "2-3"', build(mk(3))?.featureUsage.es === '2-3');
  check('4件 → "4+"', build(mk(4))?.featureUsage.es === '4+');
  check('10件 → "4+"', build(mk(10))?.featureUsage.es === '4+');
  const one = build([row('es', 'ai_generated', DAY)]);
  check('利用なし feature は key なし', one !== null && !('interview' in one.featureUsage));
}

// ── 4. Recent features ────────────────────────────────────────────
console.log('[4] recent features');
{
  const evs = [
    row('es', 'ai_generated', 5 * DAY),
    row('interview', 'feature_completed', 2 * DAY),
    row('matching', 'matching_run', 1 * DAY),
    row('es', 'ai_generated', 10 * DAY), // 重複 feature（古い）
  ];
  const s = build(evs)!;
  check('recency 降順', JSON.stringify(s.recentFeatures) === JSON.stringify(['matching', 'interview', 'es']));
  check('重複除去', s.recentFeatures.filter((f) => f === 'es').length === 1);
  // 6 feature → 最大5件。
  const six = build([
    row('matching', 'matching_run', 1 * DAY),
    row('interview', 'feature_completed', 2 * DAY),
    row('es', 'ai_generated', 3 * DAY),
    row('presentation', 'feature_completed', 4 * DAY),
    row('gd', 'feature_completed', 5 * DAY),
    row('company_research', 'company_researched', 6 * DAY),
  ])!;
  check('最大5件', six.recentFeatures.length === 5);
  // 同一 timestamp → canonical order（es=idx4 < matching=idx8）。
  const tie = build([row('matching', 'matching_run', 3 * DAY), row('es', 'ai_generated', 3 * DAY)])!;
  check('同一ts canonical order（es→matching）', JSON.stringify(tie.recentFeatures) === JSON.stringify(['es', 'matching']));
  const tieRev = build([row('es', 'ai_generated', 3 * DAY), row('matching', 'matching_run', 3 * DAY)])!;
  check('入力順逆でも同一', JSON.stringify(tie.recentFeatures) === JSON.stringify(tieRev.recentFeatures));
}

// ── 5. Last activity recency ──────────────────────────────────────
console.log('[5] last activity recency');
{
  check('24h ちょうど → "24h"', build([row('es', 'ai_generated', DAY)])?.lastActivityRecency === '24h');
  check('24h+1ms → "7d"', build([row('es', 'ai_generated', DAY + 1)])?.lastActivityRecency === '7d');
  check('7d ちょうど → "7d"', build([row('es', 'ai_generated', 7 * DAY)])?.lastActivityRecency === '7d');
  check('7d+1ms → "30d"', build([row('es', 'ai_generated', 7 * DAY + 1)])?.lastActivityRecency === '30d');
  check('20日前 → "30d"', build([row('es', 'ai_generated', 20 * DAY)])?.lastActivityRecency === '30d');
}

// ── 6. Latest bands ───────────────────────────────────────────────
console.log('[6] latest bands');
{
  const s = build([
    row('matching', 'matching_run', 2 * DAY, 'B'),
    row('presentation', 'feature_completed', 3 * DAY, 'A'),
    row('gd', 'feature_completed', 10 * DAY, 'C'),
  ])!;
  check('matching band', s.latestBands?.matching?.band === 'B');
  check('presentation band', s.latestBands?.presentation?.band === 'A');
  check('gd band', s.latestBands?.gd?.band === 'C');
  check('matching recency 7d', s.latestBands?.matching?.recency === '7d');
  check('gd recency 30d', s.latestBands?.gd?.recency === '30d');

  // invalid band → latestBands に入らないが usage には数える。
  const inv = build([row('matching', 'matching_run', DAY, 'Z')])!;
  check('invalid band → latestBands なし', !inv.latestBands || !inv.latestBands.matching);
  check('invalid band でも usage に数える', inv.featureUsage.matching === '1');

  // band なし event でも usage に含む。
  const noBand = build([row('gd', 'feature_completed', DAY)])!;
  check('band なし gd → usage あり', noBand.featureUsage.gd === '1');
  check('band なし gd → latestBands なし', !noBand.latestBands);

  // interview は band feature ではない → latestBands に入れない。
  const iv = build([row('interview', 'feature_completed', DAY, 'A')])!;
  check('interview band は latestBands に入れない', !iv.latestBands || !('matching' in (iv.latestBands ?? {})));
  check('interview usage は残る', iv.featureUsage.interview === '1');

  // 最新 band が新しい方を採用（古い C より新しい A）。
  const latest = build([
    row('matching', 'matching_run', 1 * DAY, 'A'),
    row('matching', 'matching_run', 5 * DAY, 'C'),
  ])!;
  check('latest band は最新を採用', latest.latestBands?.matching?.band === 'A');

  // 同一ts 同一 band → 採用。
  const sameBand = build([row('gd', 'feature_completed', 3 * DAY, 'B'), row('gd', 'feature_completed', 3 * DAY, 'B')])!;
  check('同一ts 同一band → 採用', sameBand.latestBands?.gd?.band === 'B');

  // 同一ts 異なる band → 曖昧として feature 省略（古い band にもフォールバックしない）。
  const ambiguous = build([
    row('gd', 'feature_completed', 3 * DAY, 'A'),
    row('gd', 'feature_completed', 3 * DAY, 'B'),
    row('gd', 'feature_completed', 8 * DAY, 'C'),
  ])!;
  check('同一ts 異band → gd 省略', !ambiguous.latestBands || !('gd' in ambiguous.latestBands));
  check('曖昧でも gd usage は残る', ambiguous.featureUsage.gd === '2-3');

  // 30日より古い band は扱わない（window で除外）。
  const old = build([row('matching', 'matching_run', 2 * DAY, 'A'), row('presentation', 'feature_completed', 40 * DAY, 'S')])!;
  check('30日超 band feature は除外（presentation なし）', !old.latestBands?.presentation);
}

// ── 7. Cap 100 ────────────────────────────────────────────────────
console.log('[7] source cap 100');
{
  // 101 件: 最新100件は 'es'、101件目（最古・ただし window 内 25日）だけ 'gd'。gd は cap 外 → 現れない。
  const many: CareerEventSignalSourceRow[] = [];
  for (let i = 0; i < 100; i++) many.push(row('es', 'ai_generated', (i + 1) * 60_000));
  many.push(row('gd', 'feature_completed', 25 * DAY)); // 101件目・最古
  const s = build(many)!;
  check('101件目（最古）は結果に影響しない（gd 現れない）', !('gd' in s.featureUsage));
  check('es は 4+', s.featureUsage.es === '4+');
  check('activeAreaCount = 1（gd cap 外）', s.activeAreaCount === 1);
  check('recentFeatures 最大5', s.recentFeatures.length <= 5);

  // 最新 event が入力末尾にあっても採用（入力順非依存）: 99 filler + 末尾に最新 matching。
  const withTail: CareerEventSignalSourceRow[] = [];
  for (let i = 0; i < 99; i++) withTail.push(row('es', 'ai_generated', (i + 2) * 60_000));
  withTail.push(row('matching', 'matching_run', 60_000)); // 末尾・最新（1分前）
  const s2 = build(withTail)!;
  check('末尾の最新 event も採用', s2.recentFeatures[0] === 'matching');

  // latestBands は最大3（matching/presentation/gd）。
  const bandKeys = Object.keys(
    build([
      row('matching', 'matching_run', DAY, 'A'),
      row('presentation', 'feature_completed', DAY, 'B'),
      row('gd', 'feature_completed', DAY, 'C'),
    ])!.latestBands ?? {},
  );
  check('latestBands 最大3', bandKeys.length === 3);
}

// ── 8. Determinism ────────────────────────────────────────────────
console.log('[8] determinism');
{
  const evs = [
    row('es', 'ai_generated', 1 * DAY, undefined),
    row('matching', 'matching_run', 2 * DAY, 'B'),
    row('interview', 'feature_completed', 3 * DAY),
    row('presentation', 'feature_completed', 4 * DAY, 'A'),
    row('es', 'ai_generated', 6 * DAY),
  ];
  const a = JSON.stringify(build(evs));
  const b = JSON.stringify(build([...evs].reverse()));
  // 別 shuffle（固定ローテーション）。
  const rot = [...evs.slice(2), ...evs.slice(0, 2)];
  const c = JSON.stringify(build(rot));
  check('同 input+now → 完全一致（再実行）', a === JSON.stringify(build(evs)));
  check('reverse 入力 → 完全一致', a === b);
  check('rotate 入力 → 完全一致', a === c);

  // mutation なし。
  const original = [row('es', 'ai_generated', DAY), row('matching', 'matching_run', 2 * DAY, 'A')];
  const snapshot = JSON.stringify(original);
  build(original);
  check('入力配列を mutation しない', JSON.stringify(original) === snapshot);

  // object key 順が canonical で安定（featureUsage）。
  const keyOrder = build([
    row('gd', 'feature_completed', DAY),
    row('es', 'ai_generated', 2 * DAY),
    row('matching', 'matching_run', 3 * DAY),
  ])!;
  const usageKeys = Object.keys(keyOrder.featureUsage);
  // canonical: es(4) < matching(8) < gd(10)
  check('featureUsage key は canonical 順', JSON.stringify(usageKeys) === JSON.stringify(['es', 'matching', 'gd']));
}

// ── 9. Duplicate boundary（builder は dedupe しない） ─────────────────
console.log('[9] duplicate boundary（dedupe しない契約）');
{
  const single = build([row('es', 'ai_generated', DAY)])!;
  check('1件 → "1"', single.featureUsage.es === '1');
  const dup = build([row('es', 'ai_generated', DAY), row('es', 'ai_generated', DAY)])!;
  check('同一内容 2件 → 2件として集計（"2-3"）＝dedupe しない', dup.featureUsage.es === '2-3');
}

// ── 10. PII / raw text（余分 property は output に出ない） ─────────────
console.log('[10] PII / raw text');
{
  const MARKERS = ['山田太郎', 'user@example.com', '東京大学', '株式会社ヒミツ', 'ES本文です長文', '面接回答本文', 'GD発言本文', 'do prompt injection'];
  const junk = {
    name: MARKERS[0],
    email: MARKERS[1],
    university: MARKERS[2],
    companyName: MARKERS[3],
    userInput: MARKERS[4],
    prompt: MARKERS[7],
    response: 'resp本文',
    text: MARKERS[5],
    body: MARKERS[6],
    content: 'x',
    answer: 'a',
    question: 'q',
    transcript: 't',
    message: 'm',
    memo: 'n',
    note: 'no',
    comment: 'c',
    summary: 's',
    description: 'd',
    reason: 'r',
    result: 'res',
    feedback: 'fb',
    topic: 'tp',
    joinCode: 'ABC123',
    roomTitle: 'room本文',
    participantName: '佐藤太郎',
    metadata: { secret: MARKERS[0], nested: { deep: MARKERS[1] } },
    longStr: 'x'.repeat(200),
    withNewline: 'line1\nline2',
    arr: [1, 2, 3],
  };
  const s = build([
    row('matching', 'matching_run', DAY, 'A', junk),
    row('interview', 'feature_completed', 2 * DAY, undefined, junk),
    row('gd', 'feature_completed', 3 * DAY, 'B', junk),
  ])!;
  const serialized = JSON.stringify(s);
  for (const m of MARKERS) {
    check(`marker 非出力: "${m.slice(0, 8)}…"`, !serialized.includes(m));
  }
  check('joinCode 非出力', !serialized.includes('ABC123'));
  check('metadata key 非出力', !serialized.includes('metadata') && !serialized.includes('secret'));
  check('改行 value 非出力', !serialized.includes('\n'));
  check('long body 非出力', !serialized.includes('x'.repeat(65)));
  // output の string は固定語彙のみ（feature enum / bucket / band / recency / version 数値）。
  const allowedStrings = new Set([
    'matching', 'presentation', 'gd', 'interview', 'es', 'consultation', 'company_research',
    'self_analysis', 'profile', 'activity', 'values',
    '1', '2-3', '4+', '24h', '7d', '30d', 'S', 'A', 'B', 'C', 'D',
  ]);
  const stringsInOutput: string[] = [];
  JSON.stringify(s, (k, v) => {
    if (typeof v === 'string') stringsInOutput.push(v);
    return v;
  });
  const unexpected = stringsInOutput.filter((v) => !allowedStrings.has(v));
  check('output string は固定語彙のみ', unexpected.length === 0, unexpected.length ? `unexpected=${unexpected.join(',')}` : undefined);
}

// ── 11. Byte size ─────────────────────────────────────────────────
console.log('[11] byte size');
{
  const normal = build([
    row('es', 'ai_generated', DAY),
    row('interview', 'feature_completed', 2 * DAY),
    row('matching', 'matching_run', 3 * DAY, 'B'),
  ])!;
  const normalBytes = Buffer.byteLength(JSON.stringify(normal), 'utf8');
  check(`normal <= 300 bytes（実測 ${normalBytes}）`, normalBytes <= 300);

  // heavy: 実在しうる最大（8 機能を 4+ 利用・band 3 機能・recentFeatures 5）。
  const heavyEvents: CareerEventSignalSourceRow[] = [];
  const realFeatures = ['matching', 'consultation', 'interview', 'es', 'presentation', 'company_research', 'self_analysis', 'gd'];
  realFeatures.forEach((f, fi) => {
    for (let i = 0; i < 5; i++) heavyEvents.push(row(f, 'feature_completed', (fi * 5 + i + 1) * 60_000));
  });
  heavyEvents.push(row('matching', 'matching_run', 8 * DAY, 'A'));
  heavyEvents.push(row('presentation', 'feature_completed', 9 * DAY, 'B'));
  heavyEvents.push(row('gd', 'feature_completed', 10 * DAY, 'C'));
  const heavy = build(heavyEvents)!;
  const heavyBytes = Buffer.byteLength(JSON.stringify(heavy), 'utf8');
  check(`heavy <= 512 bytes（実測 ${heavyBytes}）`, heavyBytes <= 512);
  console.log(`  info  heavy JSON = ${JSON.stringify(heavy)}`);
}

console.log('');
if (failures === 0) {
  console.log('career-event-signals-qa: ALL PASS');
  process.exit(0);
} else {
  console.error(`career-event-signals-qa: ${failures} FAIL`);
  process.exit(1);
}

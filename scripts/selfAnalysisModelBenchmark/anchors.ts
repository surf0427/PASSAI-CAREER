/*
 * Deterministic genericness metric (Phase 15), independent of any judge.
 *
 * Idea: each fixture contains distinctive, user-specific facts. An output item that
 * cites one of them is anchored to the user's evidence; an item that cites none is,
 * by construction, advice that could be given to any job-seeker.
 *
 * Reports, per model x profile:
 *   anchoredItems / totalItems      = "evidence anchor rate"
 *   unanchored (generic) item count
 *
 * The anchor lists are drawn verbatim from the fixture content, so they are
 * identical for both arms and cannot favour either model.
 *
 * Usage: npx tsx --tsconfig tsconfig.realtime-test.json scripts/_model_ab_tmp/anchors.ts <ab.json>
 */

import { readFileSync } from 'node:fs';

const ANCHORS: Record<string, string[]> = {
  light: [
    'カフェ', '接客', 'レジ', 'ピーク', '席番号', 'ドリンク', '口頭', '提供', '待ち時間',
    '段取り', 'ホール', '経済', '飲食',
  ],
  normal: [
    'テニス', '副代表', '60', '級別', '参加率', '上級者', '初心者', '練習',
    '広告', '運用', 'テンプレ', 'スプレッドシート', '週6', '6時間',
    '個別指導', '塾', '講師', '確認テスト', '弱点', '15点', '生徒',
    'ENFJ', '商学', '営業', 'マーケ',
  ],
  heavy: [
    '自然言語処理', '研究室', 'ゼミ', '前処理', '自動化', '意図分類',
    '学生団体', '代表', '40', '定着率', '15分', '振り返り', 'プログラミング教室', '講師',
    'API', 'DB', '設計', '当番制', '障害', 'SaaS', 'スタートアップ',
    'ハッカソン', '企業賞', 'スコープ',
    '飲食', '事実確認', 'クレーム',
    '基本情報', 'TOEIC', '820', 'Python', 'TypeScript', 'PostgreSQL',
    'PdM', '運用コスト', '越境', '意思決定',
  ],
};

const ARRAY_FIELDS = [
  'strengths', 'weaknesses', 'gakuchikaIdeas', 'selfPrIdeas', 'esAngles',
  'interviewQuestions', 'nextActions', 'recommendedIndustries', 'recommendedJobs',
  'suitableEnvironment', 'motivationSources', 'stressFactors',
  'companySelectionCriteria', 'developmentPoints',
]; // keyword fields excluded: single words cannot carry an anchor fairly

type Row = {
  caseId: string; arm: string; run: number; schemaValid: boolean;
  result?: Record<string, unknown>;
};

const rows: Row[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));

type Acc = { anchored: number; total: number; runs: number; perField: Record<string, { a: number; t: number }> };
const acc: Record<string, Acc> = {};

for (const r of rows) {
  if (!r.schemaValid || !r.result) continue;
  const key = `${r.caseId}|${r.arm}`;
  acc[key] ??= { anchored: 0, total: 0, runs: 0, perField: {} };
  acc[key].runs += 1;
  const anchors = ANCHORS[r.caseId];
  for (const f of ARRAY_FIELDS) {
    const arr = (r.result[f] as string[]) ?? [];
    acc[key].perField[f] ??= { a: 0, t: 0 };
    for (const item of arr) {
      const hit = anchors.some((x) => item.includes(x));
      acc[key].total += 1;
      acc[key].perField[f].t += 1;
      if (hit) { acc[key].anchored += 1; acc[key].perField[f].a += 1; }
    }
  }
}

console.log('EVIDENCE ANCHOR RATE — share of output items citing a user-specific fact');
console.log('(keyword fields excluded; anchor lists identical for both arms)\n');
console.log('profile'.padEnd(9) + 'model'.padEnd(9) + 'runs'.padStart(5) + 'items'.padStart(7) + 'anchored'.padStart(10) + 'rate'.padStart(8) + 'generic'.padStart(9));
console.log('-'.repeat(57));
for (const c of ['light', 'normal', 'heavy']) {
  for (const m of ['sonnet', 'haiku']) {
    const a = acc[`${c}|${m}`];
    if (!a) { console.log(c.padEnd(9) + m.padEnd(9) + '  (no schema-valid runs)'); continue; }
    const rate = a.total ? (a.anchored / a.total) * 100 : 0;
    console.log(
      c.padEnd(9) + m.padEnd(9) + String(a.runs).padStart(5) + String(a.total).padStart(7) +
      String(a.anchored).padStart(10) + (rate.toFixed(1) + '%').padStart(8) +
      String(a.total - a.anchored).padStart(9),
    );
  }
}

console.log('\nPER-FIELD ANCHOR RATE (all profiles pooled)');
const pooled: Record<string, Record<string, { a: number; t: number }>> = { sonnet: {}, haiku: {} };
for (const [k, v] of Object.entries(acc)) {
  const m = k.split('|')[1];
  for (const [f, pf] of Object.entries(v.perField)) {
    pooled[m][f] ??= { a: 0, t: 0 };
    pooled[m][f].a += pf.a; pooled[m][f].t += pf.t;
  }
}
console.log('field'.padEnd(26) + 'sonnet'.padStart(10) + 'haiku'.padStart(10) + 'delta'.padStart(9));
const deltas: Array<[string, number]> = [];
for (const f of ARRAY_FIELDS) {
  const s = pooled.sonnet[f], h = pooled.haiku[f];
  if (!s || !h || !s.t || !h.t) continue;
  const sr = (s.a / s.t) * 100, hr = (h.a / h.t) * 100;
  deltas.push([f, hr - sr]);
  console.log(f.padEnd(26) + (sr.toFixed(0) + '%').padStart(10) + (hr.toFixed(0) + '%').padStart(10) + ((hr - sr).toFixed(0) + 'pp').padStart(9));
}
deltas.sort((a, b) => a[1] - b[1]);
console.log('\nFields where Haiku loses the most anchoring:');
for (const [f, d] of deltas.slice(0, 5)) console.log(`  ${f.padEnd(26)} ${d.toFixed(0)}pp`);

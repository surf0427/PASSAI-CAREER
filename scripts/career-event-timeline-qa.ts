/*
 * scripts/career-event-timeline-qa.ts
 *
 * PASSAI CAREER — mypage event timeline の表示モデル QA（P9-B 常設 harness）。
 *
 * 背景（P9-A 監査結論）:
 *   Career Event Log は write-only で、event log 専用 QA が存在しないことが弱点とされた。
 *   P9-B で本人向け read path（mypage timeline）を初めて開通するため、その **表示専用純変換**
 *   （lib/careerEvents/timeline.ts）を回帰固定し、本文・PII が UI に漏れないことを保証する。
 *
 * 何を守るか:
 *   1. feature / event_type の日本語ラベル化。
 *   2. score_band は S/A/B/C/D のみ採用（不正値は null）。
 *   3. metadata は表示側 allowlist の scalar だけ（companyCount / selectionType / interviewType /
 *      mode / charLimit / revisionCount 等）を chip 化する。
 *   4. **PII / 本文防御**: prompt / response / body / content / answer / message / text / email /
 *      name / university などの危険 key・危険 value は、metadata に混入しても UI 出力に出ない。
 *   5. 非スカラー / 長文 / 改行入り metadata は表示しない。
 *   6. industry / job_type / selection_phase の短ラベル化（長文・改行は drop）。
 *   7. occurred_at の JST 整形が決定論的（マシン TZ 非依存）。
 *   8. 表示側 allowlist が sanitize.ts の書き込み側 allowlist の部分集合であること（整合）。
 *
 * 厳守（P9-B）:
 *   - production の純関数（toEventTimelineItems / formatEventTimestamp）と sanitizeMetadata を **読むだけ**。
 *   - DB / Supabase / env / secret / API 非接続。完全決定論。
 *   - AI prompt / body / CareerMemorySnapshot は扱わない。
 *
 * 使い方: npx tsx scripts/career-event-timeline-qa.ts
 * 終了コード: 全 assertion PASS → 0 / いずれか FAIL → 1。
 */

import {
  toEventTimelineItems,
  formatEventTimestamp,
  type RecentCareerEventRow,
} from '@/lib/careerEvents/timeline';
import { sanitizeMetadata } from '@/lib/careerEvents/sanitize';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 表示側 allowlist で拾ってよい key（timeline.ts の META_DISPLAY と対で検査する）。
// 注: 'messageCount' は sanitize denylist 'message' に一致し書き込み側で必ず落ちるため表示 allowlist に含めない。
const DISPLAY_KEYS = [
  'companyCount', 'industryCount', 'jobCount', 'threadCount', 'turnCount',
  'revisionCount', 'count', 'mode', 'interviewType',
  'selectionType', 'scenario', 'sourceType', 'format', 'participationMode',
  'charLimit', 'timeLimitSec', 'durationSec',
];

// 危険 value（本文・PII を模した文字列）。UI 出力に絶対に現れてはならない。
const SECRET_MARKERS = [
  'これは面接の回答本文です長文長文',
  '山田太郎',
  '東京大学',
  'do this now prompt injection',
  'user@example.com',
  'AI が生成した応答本文です',
];

function row(overrides: Partial<RecentCareerEventRow>): RecentCareerEventRow {
  return {
    id: 'evt-1',
    event_type: 'feature_completed',
    feature: 'interview',
    industry: null,
    job_type: null,
    selection_phase: null,
    score_band: null,
    weakness_category: null,
    next_action: null,
    completion_status: 'completed',
    metadata: {},
    occurred_at: '2026-07-08T03:34:00.000Z',
    ...overrides,
  };
}

// ── 1. feature / event_type ラベル化 ─────────────────────────────────
console.log('[1] feature / event_type ラベル化');
{
  const items = toEventTimelineItems([
    row({ id: 'a', feature: 'matching', event_type: 'matching_run' }),
    row({ id: 'b', feature: 'consultation', event_type: 'consultation_asked' }),
    row({ id: 'c', feature: 'es', event_type: 'ai_generated' }),
    row({ id: 'd', feature: 'presentation', event_type: 'feature_completed' }),
    row({ id: 'e', feature: 'gd', event_type: 'feature_started' }),
    row({ id: 'f', feature: 'self_analysis', event_type: 'weakness_identified' }),
  ]);
  check('matching → マッチング', items[0].featureLabel === 'マッチング');
  check('matching_run → マッチング実行', items[0].eventTypeLabel === 'マッチング実行');
  check('consultation → 相談AI', items[1].featureLabel === '相談AI');
  check('es → ES', items[2].featureLabel === 'ES');
  check('presentation → プレゼン', items[3].featureLabel === 'プレゼン');
  check('gd → GD', items[4].featureLabel === 'GD');
  check('self_analysis → 自己分析', items[5].featureLabel === '自己分析');
  check('件数保持（6件）', items.length === 6);
}

// ── 2. score_band ─────────────────────────────────────────────────
console.log('[2] score_band');
{
  const items = toEventTimelineItems([
    row({ id: 'a', score_band: 'A' }),
    row({ id: 'b', score_band: 'Z' }),
    row({ id: 'c', score_band: '87' }),
    row({ id: 'd', score_band: null }),
  ]);
  check('valid band A 採用', items[0].scoreBand === 'A');
  check('不正 band Z → null', items[1].scoreBand === null);
  check('生スコア文字列 → null', items[2].scoreBand === null);
  check('null → null', items[3].scoreBand === null);
}

// ── 3. metadata allowlist chip 化 ─────────────────────────────────
console.log('[3] metadata allowlist chip 化');
{
  const items = toEventTimelineItems([
    row({
      metadata: {
        companyCount: 5,
        selectionType: 'main',
        interviewType: 'personal',
        mode: 'voice',
        charLimit: 400,
        revisionCount: 2,
      },
    }),
  ]);
  const chips = items[0].metaChips;
  const byKey = Object.fromEntries(chips.map((c) => [c.key, c.value]));
  check('companyCount chip', byKey.companyCount === '5');
  check('selectionType chip', byKey.selectionType === 'main');
  check('interviewType chip', byKey.interviewType === 'personal');
  check('mode chip', byKey.mode === 'voice');
  check('charLimit chip', byKey.charLimit === '400');
  check('revisionCount chip', byKey.revisionCount === '2');
  check('chip 数 = 6', chips.length === 6);
  check('各 chip に日本語ラベル', chips.every((c) => c.label.length > 0));
}

// ── 4. PII / 本文防御（危険 key・危険 value を混入させても出ない） ─────
console.log('[4] PII / 本文防御');
{
  const items = toEventTimelineItems([
    row({
      id: 'danger',
      feature: 'es',
      event_type: 'ai_generated',
      metadata: {
        // 危険 key（denylist に一致）。allowlist にも無いので二重で落ちる。
        answerText: SECRET_MARKERS[0],
        applicantName: SECRET_MARKERS[1],
        university: SECRET_MARKERS[2],
        prompt: SECRET_MARKERS[3],
        email: SECRET_MARKERS[4],
        aiResponse: SECRET_MARKERS[5],
        // 安全 key は残るべき。
        companyCount: 3,
        selectionType: 'main',
      },
    }),
  ]);
  const serialized = JSON.stringify(items);
  for (const marker of SECRET_MARKERS) {
    check(`危険 value 非出力: "${marker.slice(0, 10)}…"`, !serialized.includes(marker));
  }
  const chips = items[0].metaChips;
  check('危険 key は chip 化されない', chips.every((c) => DISPLAY_KEYS.includes(c.key)));
  check('安全 key companyCount は残る', chips.some((c) => c.key === 'companyCount'));
  check('安全 key selectionType は残る', chips.some((c) => c.key === 'selectionType'));
  check('chip 数 = 2（危険 key 全 drop）', chips.length === 2);
}

// ── 5. 非スカラー / 長文 / 改行の drop ─────────────────────────────
console.log('[5] 非スカラー / 長文 / 改行の drop');
{
  const items = toEventTimelineItems([
    row({
      metadata: {
        mode: { nested: 'x' }, // object → drop
        selectionType: ['a', 'b'], // array → drop
        format: 'a'.repeat(200), // 長文 → drop
        interviewType: 'line1\nline2', // 改行 → drop
        companyCount: 7, // 正常 → 残る
      },
    }),
  ]);
  const chips = items[0].metaChips;
  check('object 値 drop', !chips.some((c) => c.key === 'mode'));
  check('array 値 drop', !chips.some((c) => c.key === 'selectionType'));
  check('長文 value drop', !chips.some((c) => c.key === 'format'));
  check('改行 value drop', !chips.some((c) => c.key === 'interviewType'));
  check('正常 companyCount のみ残る', chips.length === 1 && chips[0].key === 'companyCount');
}

// ── 6. industry / job_type / selection_phase 短ラベル ────────────────
console.log('[6] industry / job_type / selection_phase 短ラベル');
{
  const items = toEventTimelineItems([
    row({ id: 'a', industry: 'IT・通信', job_type: 'エンジニア', selection_phase: '本選考' }),
    row({ id: 'b', industry: 'x'.repeat(200), job_type: 'multi\nline', selection_phase: '  ' }),
  ]);
  check('industry 表示', items[0].industry === 'IT・通信');
  check('job_type 表示', items[0].jobType === 'エンジニア');
  check('selection_phase 表示', items[0].selectionPhase === '本選考');
  check('長文 industry → null', items[1].industry === null);
  check('改行 job_type → null', items[1].jobType === null);
  check('空白 selection_phase → null', items[1].selectionPhase === null);
}

// ── 7. occurred_at JST 決定論整形 ─────────────────────────────────
console.log('[7] occurred_at JST 決定論整形');
{
  // 03:34 UTC → 12:34 JST。
  check('UTC→JST 整形', formatEventTimestamp('2026-07-08T03:34:00.000Z') === '2026/07/08 12:34');
  // 日跨ぎ: 23:30 UTC → 翌日 08:30 JST。
  check('日跨ぎ JST', formatEventTimestamp('2026-07-08T23:30:00.000Z') === '2026/07/09 08:30');
  check('不正 ISO → 空文字', formatEventTimestamp('not-a-date') === '');
}

// ── 8. 表示 allowlist ⊆ sanitize allowlist（整合） ───────────────────
console.log('[8] 表示 allowlist ⊆ sanitize allowlist');
{
  for (const key of DISPLAY_KEYS) {
    const sanitized = sanitizeMetadata({ [key]: 1 });
    check(`sanitize が "${key}" を保持（書き込み側 allowlist）`, sanitized[key] === 1);
  }
}

// ── 9. 異常入力の頑健性 ───────────────────────────────────────────
console.log('[9] 異常入力の頑健性');
{
  check('非配列 → []', toEventTimelineItems(null as unknown as RecentCareerEventRow[]).length === 0);
  check('空配列 → []', toEventTimelineItems([]).length === 0);
  const items = toEventTimelineItems([
    row({ id: '' }), // id 空 → drop
    row({ id: 'ok' }),
  ]);
  check('id 空行は drop', items.length === 1 && items[0].id === 'ok');
}

// ── 10. P9-C: presentation / company_research の実 event 形状 ──────────
console.log('[10] P9-C presentation / company_research fixture');
{
  // presentation: 本文（transcript / theme / feedback）は event に載らない前提。
  // metadata に本文が誤混入しても drop されることも併せて検査する。
  const [pres] = toEventTimelineItems([
    row({
      id: 'pres-1',
      feature: 'presentation',
      event_type: 'feature_completed',
      industry: 'IT・通信',
      job_type: 'エンジニア',
      score_band: 'A',
      metadata: {
        mode: 'voice',
        scenario: 'main_selection',
        format: 'individual',
        selectionType: 'main',
        // 誤混入を模した本文 key（drop されるべき）。
        transcript: 'プレゼン発表の文字起こし本文長文…',
        feedbackText: 'AIフィードバック本文…',
      },
    }),
  ]);
  check('presentation feature ラベル', pres.featureLabel === 'プレゼン');
  check('presentation event ラベル', pres.eventTypeLabel === '完了');
  check('presentation score band', pres.scoreBand === 'A');
  check('presentation industry/jobType', pres.industry === 'IT・通信' && pres.jobType === 'エンジニア');
  const presChips = Object.fromEntries(pres.metaChips.map((c) => [c.key, c.value]));
  check('presentation scenario chip', presChips.scenario === 'main_selection');
  check('presentation mode chip', presChips.mode === 'voice');
  check('presentation format chip', presChips.format === 'individual');
  check('presentation selectionType chip', presChips.selectionType === 'main');
  check(
    'presentation 本文 key は chip 化されない',
    pres.metaChips.every((c) => DISPLAY_KEYS.includes(c.key)),
  );
  check('presentation 本文 value 非出力', !JSON.stringify(pres).includes('本文'));
  check('presentation chip 数 = 4', pres.metaChips.length === 4);

  // company_research: 企業名・研究本文・review/fitAnalysis 本文は event に載らない前提。
  const [cr] = toEventTimelineItems([
    row({
      id: 'cr-1',
      feature: 'company_research',
      event_type: 'company_researched',
      industry: 'メーカー',
      score_band: null,
      metadata: {
        sourceType: 'file',
        revisionCount: 3,
        // 誤混入を模した本文/企業名 key（drop されるべき）。
        companyName: '株式会社ヒミツ',
        verifiedResearchText: '企業研究の確認済み本文…',
        interviewContextSummary: '面接文脈の要約本文…',
      },
    }),
  ]);
  check('company_research feature ラベル', cr.featureLabel === '企業研究');
  check('company_research event ラベル', cr.eventTypeLabel === '企業研究');
  check('company_research industry', cr.industry === 'メーカー');
  check('company_research score band なし', cr.scoreBand === null);
  const crChips = Object.fromEntries(cr.metaChips.map((c) => [c.key, c.value]));
  check('company_research sourceType chip', crChips.sourceType === 'file');
  check('company_research revisionCount chip', crChips.revisionCount === '3');
  check('company_research chip 数 = 2', cr.metaChips.length === 2);
  check('企業名は非出力', !JSON.stringify(cr).includes('株式会社ヒミツ'));
  check('研究本文は非出力', !JSON.stringify(cr).includes('本文'));
  check(
    'company_research 想定外 key は chip 化されない',
    cr.metaChips.every((c) => DISPLAY_KEYS.includes(c.key)),
  );

  // sanitize 整合: 新 key（scenario / sourceType）が書き込み側 allowlist を通ること。
  check('sanitize が scenario を保持', sanitizeMetadata({ scenario: 'main_selection' }).scenario === 'main_selection');
  check('sanitize が sourceType を保持', sanitizeMetadata({ sourceType: 'file' }).sourceType === 'file');
  // sanitize が本文/企業名 key を落とすこと（書き込み側の防御）。
  const san = sanitizeMetadata({
    scenario: 'main_selection',
    companyName: '株式会社ヒミツ',
    verifiedResearchText: '本文',
    interviewContextSummary: '要約本文',
    feedbackText: 'FB本文',
  });
  check('sanitize が companyName を drop', !('companyName' in san));
  check('sanitize が verifiedResearchText を drop', !('verifiedResearchText' in san));
  check('sanitize が interviewContextSummary を drop', !('interviewContextSummary' in san));
  check('sanitize が feedbackText を drop', !('feedbackText' in san));
}

console.log('');
if (failures === 0) {
  console.log('career-event-timeline-qa: ALL PASS');
  process.exit(0);
} else {
  console.error(`career-event-timeline-qa: ${failures} FAIL`);
  process.exit(1);
}

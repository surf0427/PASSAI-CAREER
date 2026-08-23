/*
 * scripts/career-event-signal-consolidation-qa.ts
 *
 * PASSAI CAREER — Consultation-only Event Signal Pilot **Series Consolidation** QA（P10-G）。
 *
 * 位置づけ:
 *   P10-B〜P10-F で個別に固定した builder / reader / loader / renderer / guard / consumer を、
 *   1 本の end-to-end 契約として **薄く横断監査** する series-level harness。個々の詳細検査は
 *   既存の 5 本（qa:careerEventSignals / …Reader / …Consultation / …Aftercare / …OperationalGuard）
 *   が担うため、本 script はそれらと重複しない「series 全体の構造・境界・証跡」に限定する:
 *     1. 各 commit 由来 production file の存在。
 *     2. 依存方向（builder→reader→loader→renderer→consumer の一方向・逆流なし）。
 *     3. owner scope / same-now / soft-timeout / timer cleanup / no-retry。
 *     4. version fail-closed / 固定語彙 / 誤推論防止 note 完全一致 / byte cap。
 *     5. client load guard / server-authoritative guard / old⇔new client-server mismatch（4 象限）。
 *     6. body-neutral / prompt-neutral（Signal OFF と Signal ON-but-none が完全一致）。
 *     7. current consultation event 非混入（loader は record より前・now は request 時刻）。
 *     8. non-consumer isolation（consultation 以外に guard/loader/renderer 非混入）。
 *     9. runbook / consolidation doc の Deployment-guard 表現（Remote kill switch と誤記しない・
 *        再デプロイ必要・production flag 現在値を断定しない）。
 *    10. [P10-G 2-B] full absolute byte 実測（compact block / eventSignals JSON property /
 *        full request body / base system prompt）を Signal OFF / ON-none / ON-heavy で測定し、
 *        delta 上限（≤700B）と OFF===none neutral を固定する。
 *
 * 厳守: 本番 Supabase / 外部 AI 非接続（reader adapter stub・fixture のみ）。
 *   secret / userId / rows / summary / prompt 本文を出力しない。production code は import のみ。
 * 使い方: npx tsx scripts/career-event-signal-consolidation-qa.ts
 */

import { readFileSync, existsSync } from 'node:fs';
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
import { buildCareerEventSignalSummary } from '@/lib/careerMemory/eventSignals';
import { buildCareerAiContext } from '@/lib/careerAi';
import { buildCareerContextForPurpose } from '@/lib/careerContext';
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

const ROOT = process.cwd();
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-10T00:00:00.000Z');
const USER = '11111111-1111-4111-8111-111111111111';
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// route が非空 block を結合する separator（systemPrompt = [...].filter(!== '').join('\n\n')）。
const PROMPT_JOIN = '\n\n';

// P10-E 正式 note（renderEventSignals.ts の NOTE と完全一致すべき固定文言）。
const CANONICAL_NOTE =
  '※参考情報です。利用量・未利用・評価帯は能力・意欲・適性・合否・弱みを意味しません。' +
  '評価帯は練習時点の目安で現在の実力ではありません。' +
  '本人の入力を最優先し、次の準備提案の補助にのみ使ってください。';

const heavySummary: CareerEventSignalSummary = {
  version: 1, windowDays: 30,
  recentFeatures: ['matching', 'consultation', 'interview', 'es', 'presentation'],
  featureUsage: { matching: '4+', consultation: '4+', interview: '4+', es: '4+', presentation: '4+', company_research: '4+', self_analysis: '4+', gd: '4+' },
  latestBands: { matching: { band: 'A', recency: '30d' }, presentation: { band: 'B', recency: '30d' }, gd: { band: 'C', recency: '30d' } },
  activeAreaCount: 8, lastActivityRecency: '24h',
};

function dbRow(feature: string, eventType: string, offsetMs: number, band?: string) {
  return { feature, event_type: eventType, score_band: band, occurred_at: new Date(NOW - offsetMs).toISOString() };
}

void (async () => {
  // ── 1. Commit 由来 production file の存在 ───────────────────────
  console.log('[1] production files (P10-B〜F)');
  {
    const files = [
      ['P10-B builder', 'lib/careerMemory/eventSignals.ts'],
      ['P10-C reader', 'lib/careerEvents/readSignals.ts'],
      ['P10-D loader', 'lib/careerMemory/loadEventSignals.ts'],
      ['P10-D renderer', 'lib/careerMemory/renderEventSignals.ts'],
      ['P10-F guard', 'lib/careerMemory/eventSignalPilotGuard.ts'],
      ['consumer route', 'app/api/career/consultation/route.ts'],
      ['consumer page', 'app/career/consultation/page.tsx'],
      ['guard runbook', 'docs/career/event_signal_consultation_pilot_guard.md'],
      ['consolidation doc', 'docs/career/event_signal_consultation_pilot.md'],
    ] as const;
    for (const [label, rel] of files) check(`${label}: ${rel} 存在`, existsSync(join(ROOT, rel)));
  }

  // ── 2. 依存方向（一方向・逆流なし） ────────────────────────────
  console.log('[2] dependency direction (builder→reader→loader→renderer→consumer)');
  {
    const builder = read('lib/careerMemory/eventSignals.ts');
    const reader = read('lib/careerEvents/readSignals.ts');
    const loader = read('lib/careerMemory/loadEventSignals.ts');
    const renderer = read('lib/careerMemory/renderEventSignals.ts');

    // builder は DB / reader / loader を知らない（pure）。import 文で判定（doc コメントは除外）。
    const importLine = (src: string, needle: RegExp) => src.split('\n').some((l) => /^\s*import\b/.test(l) && needle.test(l));
    check('builder は supabase を import しない', !importLine(builder, /supabase/i));
    check('builder は reader/loader を import しない', !importLine(builder, /readSignals|loadEventSignals/));
    // reader は builder を **呼び出さない**（型のみ type-only import）。
    check('reader は builder を値 import しない（type-only 可）', !/import\s*\{[^}]*buildCareerEventSignalSummary/.test(reader));
    check('reader は builder の型を type-only import', /import\s+type\s*\{[^}]*CareerEventSignalSourceRow/.test(reader));
    // loader は reader + builder を結合する（両方 import）。
    check('loader は reader を import', /readCareerEventSignalSourceRows/.test(loader));
    check('loader は builder を import', /buildCareerEventSignalSummary/.test(loader));
    // renderer は raw rows / reader / loader を受け取らない（summary のみ）。
    check('renderer は reader/loader を import しない', !importLine(renderer, /readSignals|loadEventSignals/));
    check('renderer は supabase を import しない', !importLine(renderer, /supabase/i));
  }

  // ── 3. owner scope / same-now / timeout / timer / no-retry ─────
  console.log('[3] owner scope / same-now / soft-timeout / timer cleanup / no-retry');
  {
    const reader = read('lib/careerEvents/readSignals.ts');
    const loader = read('lib/careerMemory/loadEventSignals.ts');
    check('reader owner filter: .eq(user_id)', /\.eq\('user_id',\s*userId\)/.test(reader));
    check('reader UUID guard（不正 userId no-op）', /UUID_RE\.test/.test(reader));
    check('reader SELECT は 4 列固定（* 禁止）', /CAREER_EVENT_SIGNAL_SELECT\s*=\s*'feature, event_type, score_band, occurred_at'/.test(reader));
    // ★ 守りたいのは client factory の名前ではなく **RLS で owner に閉じること**:
    //   anon key + user session の browser client を使い、RLS を迂回する service_role を
    //   決して使わない。Project B 分離（careerSupabase/browserClient）で factory 名が
    //   getBrowserSupabaseClient → getCareerBrowserSupabaseClient へ変わったため、
    //   名前 literal での判定は stale になっていた（security 性質は不変）。
    check(
      'reader は anon + user session の browser client を使う（RLS で owner に閉じる）',
      /getCareerBrowserSupabaseClient\s*\(/.test(reader),
    );
    check(
      'reader は service_role を使わない（RLS を迂回しない）',
      !/service_role|SERVICE_ROLE|ServiceRole/.test(reader),
    );
    check(
      'reader は受験版 Project A の client factory を使わない',
      !/(?<![A-Za-z])getBrowserSupabaseClient\s*\(/.test(reader),
    );
    // same now: loader は nowMs を 1 度計算し reader と builder の両方へ同一値を渡す。
    check('loader は nowMs を 1 度計算', /const nowMs = input\.now instanceof Date/.test(loader));
    check('loader は reader へ nowMs を渡す', /readCareerEventSignalSourceRows\(\{ userId: input\.userId, now: nowMs \}/.test(loader));
    check('loader は builder へ同じ nowMs を渡す', /buildCareerEventSignalSummary\(\{ events: rows, now: nowMs \}\)/.test(loader));
    // soft timeout: 固定 1000ms・request から変更不可・clearTimeout あり。
    check('loader timeout は固定 1000ms const', /SIGNAL_SOFT_TIMEOUT_MS = 1000/.test(loader));
    const sig = loader.slice(loader.indexOf('loadCareerEventSignalSummary('), loader.indexOf('): Promise'));
    check('loader signature に timeout param なし', sig.length > 0 && !/timeout/i.test(sig));
    check('loader timer cleanup（clearTimeout）', /clearTimeout\(timer\)/.test(loader));
    check('loader に retry ループなし', !/for\s*\(|while\s*\(|retry/i.test(loader));
  }

  // ── 4. version fail-closed / 固定語彙 / note 完全一致 / byte cap ─
  console.log('[4] version fail-closed / fixed vocabulary / note / byte cap');
  {
    const renderer = read('lib/careerMemory/renderEventSignals.ts');
    check('renderer version!==1 → 空', /if \(s\.version !== 1\) return '';/.test(renderer));
    // note 完全一致（production の NOTE と canonical が byte-identical）。
    const heavyBlock = renderCareerEventSignalsCompact(heavySummary);
    check('render block に canonical note が完全一致で含まれる', heavyBlock.includes(CANONICAL_NOTE));
    check('render block byte cap ≤700', bytes(heavyBlock) <= 700, `${bytes(heavyBlock)}B`);
    // 固定語彙のみ（生 JSON / exact timestamp なし）。
    check('render block に生 JSON なし', !/[{}\[\]]/.test(heavyBlock));
    check('render block に exact timestamp なし', !/\d{4}-\d{2}-\d{2}T/.test(heavyBlock));
    // unknown/malicious は非流出（renderer(unknown) 直接）。
    const evil = renderCareerEventSignalsCompact({
      version: 1, windowDays: 30,
      recentFeatures: ['interview', 'evil_feature', '<script>'],
      featureUsage: { interview: '2-3', 'a@b.com': '4+' },
      latestBands: { matching: { band: 'Z', recency: '7d' } },
      activeAreaCount: 1, lastActivityRecency: '7d',
    });
    check('unknown feature/HTML/email/invalid band 非流出', !/evil_feature|<script>|a@b\.com|マッチング Z/.test(evil));
  }

  // ── 5. client guard / server authoritative / mismatch 4 象限 ───
  console.log('[5] client guard / server-authoritative / old⇔new mismatch');
  {
    // flag parser: true/1/yes のみ・それ以外 fail-closed。
    check('flag: "true"/"1"/"yes" 有効', ['true', '1', 'yes', ' TRUE '].every((v) => evalConsultationEventSignalPilotEnabled(v)));
    check('flag: missing/invalid/非文字列 無効', [undefined, null, '', 'false', 'on', 1, {}].every((v) => !evalConsultationEventSignalPilotEnabled(v)));
    // client load gate: member+ON のみ。
    check('client gate: member+ON → load', shouldLoadConsultationEventSignals(USER, true));
    check('client gate: guest/OFF → no load', !shouldLoadConsultationEventSignals('', true) && !shouldLoadConsultationEventSignals(USER, false));
    // server authoritative: OFF なら client 強制 body を無視。
    check('server OFF: 強制 body 無視 → 空', resolveConsultationEventSignalsBlock(false, heavySummary) === '');
    check('server ON: valid summary → 非空', resolveConsultationEventSignalsBlock(true, heavySummary) !== '');
    // old⇔new client-server mismatch（ブラウザに古い bundle が残るケース）:
    //   古い ON client → 新しい OFF server: body に Signal が来ても server OFF は無視。
    check('mismatch: old ON client × new OFF server → block 空', resolveConsultationEventSignalsBlock(false, heavySummary) === '');
    //   新しい OFF client → 古い ON server: OFF client は body に付けない → server ON でも undefined → 空。
    check('mismatch: new OFF client(body なし) × old ON server → 空', resolveConsultationEventSignalsBlock(true, undefined) === '');
    //   ON × ON: member のみ Signal あり得る。
    check('mismatch: ON × ON → 非空（valid summary 時）', resolveConsultationEventSignalsBlock(true, heavySummary) !== '');
    //   OFF × OFF: 完全 neutral。
    check('mismatch: OFF × OFF → 空', resolveConsultationEventSignalsBlock(false, undefined) === '');
  }

  // ── 6. body-neutral / prompt-neutral（OFF と ON-none が一致） ──
  console.log('[6] body-neutral / prompt-neutral');
  {
    const offBlock = resolveConsultationEventSignalsBlock(false, heavySummary);
    const noneBlock = resolveConsultationEventSignalsBlock(true, undefined);
    check('OFF block === "" ', offBlock === '');
    check('ON-none block === "" ', noneBlock === '');
    check('OFF と ON-none は byte 一致（0B）', bytes(offBlock) === bytes(noneBlock) && bytes(offBlock) === 0);
    // P15-D: system prompt 組み立ては pure builder（consultationPrompt.ts）へ抽出。Personal Memory 由来の
    //   横断ブロック（matching 等）は Orchestrator の crossFeatureContext に集約。builder の filter が空 block を
    //   除去し、eventSignalsBlock を現行位置（Personal Memory の後・OUTPUT の前）に置く（behavior 不変）。
    const builderSrc = read('app/api/career/consultation/consultationPrompt.ts');
    check('builder が空 block を filter 除去', /\.filter\(\(s\) => s !== ''\)/.test(builderSrc));
    check('eventSignalsBlock は Personal Memory(crossFeatureContext)後・OUTPUT 前（最下位補助）', builderSrc.indexOf('input.eventSignalsBlock,') > builderSrc.indexOf('orchestrated.crossFeatureContext,') && builderSrc.indexOf('input.eventSignalsBlock,') < builderSrc.indexOf('OUTPUT_FORMAT_INSTRUCTION,'));
    // client の conditional spread（eventSignals は undefined 時に body へ付かない）。
    const pageSrc = read('app/career/consultation/page.tsx');
    check('client: eventSignals は truthy 時のみ spread', /\.\.\.\(eventSignals \? \{ eventSignals \} : \{\}\)/.test(pageSrc));
  }

  // ── 7. current consultation event 非混入 ──────────────────────
  console.log('[7] current consultation event non-mixing');
  {
    const pageSrc = read('app/career/consultation/page.tsx');
    // loader は fetch より前（request 時刻の Signal）・recordCareerEvent は応答成功後。
    const iLoad = pageSrc.indexOf('loadCareerEventSignalSummary(');
    const iFetch = pageSrc.indexOf("fetch('/api/career/consultation'");
    const iRecord = pageSrc.indexOf('recordCareerEvent(');
    check('loader は fetch より前に呼ばれる', iLoad > 0 && iFetch > 0 && iLoad < iFetch);
    check('recordCareerEvent は fetch(応答)より後', iRecord > iFetch);
    check('loader は now=Date.now()（request 時刻）', /loadCareerEventSignalSummary\(\{ userId, now: Date\.now\(\) \}\)/.test(pageSrc));
    // 現在の consultation_asked は応答後 record のため、この request の reader window には入らない。
    check('page コメントに current 非混入の明示', /この request には含まれない|応答成功後に記録/.test(pageSrc));
  }

  // ── 8. non-consumer isolation ─────────────────────────────────
  console.log('[8] non-consumer isolation (consultation only)');
  {
    const otherRoutes = [
      'app/api/career/matching/route.ts', 'app/api/career/es/deep/route.ts', 'app/api/career/es/organize/route.ts', 'app/api/career/es-review/route.ts',
      'app/api/career/interview/complete/route.ts', 'app/api/career/interview/turn/route.ts',
      'app/api/career/presentation/evaluate/route.ts', 'app/api/career/gd/feedback/route.ts',
      'app/api/career/self-analysis/route.ts', 'app/api/career/company-research/route.ts',
    ];
    const sigRe = /eventSignalPilotGuard|resolveConsultationEventSignalsBlock|renderCareerEventSignalsCompact|loadCareerEventSignalSummary|eventSignals/;
    for (const rel of otherRoutes) check(`${rel} に signals/guard 非混入`, !sigRe.test(read(rel)));
    const pages = [
      'app/career/matching/page.tsx', 'app/career/es/new/page.tsx', 'app/career/es/draft/[draftId]/page.tsx', 'app/career/es/[id]/page.tsx', 'app/career/interview/session/page.tsx',
      'app/career/presentation/session/page.tsx', 'app/career/gd/session/page.tsx', 'app/career/self-analysis/run/page.tsx',
    ];
    for (const rel of pages) check(`${rel} に guard/loader 非混入`, !/eventSignalPilotGuard|loadCareerEventSignalSummary/.test(read(rel)));
    // consultation のみ guard を通電。
    check('consultation page が guard を使う', /eventSignalPilotGuard/.test(read('app/career/consultation/page.tsx')));
    check('consultation route が guard を使う', /eventSignalPilotGuard/.test(read('app/api/career/consultation/route.ts')));
    // shared snapshot / selector に Signal 非昇格。
    check('selector に Signal 非混入（shared snapshot 汚染なし）', !/eventSignal|EventSignal/.test(read('lib/careerMemory/selector.ts')));
  }

  // ── 9. runbook / consolidation doc の Deployment-guard 表現 ────
  console.log('[9] operational-guard wording (deployment guard, not remote kill switch)');
  {
    for (const rel of ['docs/career/event_signal_consultation_pilot_guard.md', 'docs/career/event_signal_consultation_pilot.md']) {
      const doc = read(rel);
      check(`${rel}: "Deployment guard" と明記`, /Deployment guard/.test(doc));
      check(`${rel}: "Remote kill switch ではない" と明記`, /Remote kill switch ではない/.test(doc));
      check(`${rel}: 再 build / 再 deploy が必要`, /再 ?build|再 ?deploy|再デプロイ/.test(doc));
      check(`${rel}: default fail-closed（OFF）`, /fail-closed|default.*(OFF|無効)|未設定.*無効/.test(doc));
      // 誤解を招く「即時停止 / リアルタイム / 再デプロイ不要」を使わない。
      check(`${rel}: "即時停止" と書かない`, !/即時停止|リアルタイム停止|再デプロイ不要/.test(doc));
      // production の現在 flag 値を断定しない。
      check(`${rel}: production flag 現在値を断定しない`, !/現在.*(本番|production).*(ON|有効)である|本番は現在 ?ON/.test(doc));
    }
  }

  // ── 10. [2-B] full absolute byte 実測 ─────────────────────────
  console.log('[10] full absolute byte evidence (OFF / ON-none / ON-heavy)');
  {
    // (a) compact Event Signal block。
    const blockOff = resolveConsultationEventSignalsBlock(false, heavySummary); // ''
    const blockNone = resolveConsultationEventSignalsBlock(true, undefined);    // ''
    const blockHeavy = resolveConsultationEventSignalsBlock(true, heavySummary);
    const blkOff = bytes(blockOff), blkNone = bytes(blockNone), blkHeavy = bytes(blockHeavy);

    // (b) request body の eventSignals JSON property（client の conditional spread を再現）。
    //   full request body は message + history(≤10×1000) + cross-feature snapshot が支配的で
    //   localStorage 由来のため決定論 fixture では近似。ここでは「Signal が body に足す絶対 byte」を厳密測定。
    const HISTORY = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'あ'.repeat(1000),
    }));
    const baseBody: Record<string, unknown> = { message: 'い'.repeat(1000), history: HISTORY };
    const bodyOff = JSON.stringify(baseBody);                                   // eventSignals なし
    const bodyNone = JSON.stringify({ ...baseBody });                           // undefined は spread されない
    const bodyHeavy = JSON.stringify({ ...baseBody, eventSignals: heavySummary });
    const eventSignalsProp = bytes(JSON.stringify(heavySummary)); // property 値のみ
    const bodyDeltaHeavy = bytes(bodyHeavy) - bytes(bodyOff);      // key + value + 区切り

    // (c) base consultation system prompt（exported builder 経由・route-private consts を除く）。
    //   COMMANDER_PERSONA / OUTPUT_FORMAT_INSTRUCTION は route.ts の module-private const のため
    //   外部から import 不能 → full prompt 絶対値は測定不能。代わりに base orchestrated prompt を
    //   anchor とし、Signal が prompt へ足す絶対 byte（PROMPT_JOIN + block）を厳密測定する。
    const baseCtx = buildCareerAiContext({ featureKey: 'career-consultation', profile: null, activity: null, values: null, userInput: '' });
    const basePrompt = buildCareerContextForPurpose('consultation', baseCtx).systemPrompt;
    const basePromptBytes = bytes(basePrompt);
    const promptDeltaOff = blockOff ? bytes(PROMPT_JOIN) + blkOff : 0;
    const promptDeltaNone = blockNone ? bytes(PROMPT_JOIN) + blkNone : 0;
    const promptDeltaHeavy = blockHeavy ? bytes(PROMPT_JOIN) + blkHeavy : 0;

    // ── assertions ──
    check('compact block: OFF=0B', blkOff === 0);
    check('compact block: ON-none=0B', blkNone === 0);
    check('compact block: ON-heavy ≤700B', blkHeavy <= 700, `${blkHeavy}B`);
    check('eventSignals property ≤700B', eventSignalsProp <= 700, `${eventSignalsProp}B`);
    check('request body: OFF === ON-none（byte 一致）', bytes(bodyOff) === bytes(bodyNone));
    check('request body heavy delta ≤700B', bodyDeltaHeavy <= 700, `${bodyDeltaHeavy}B`);
    check('system prompt delta: OFF=0B', promptDeltaOff === 0);
    check('system prompt delta: ON-none=0B', promptDeltaNone === 0);
    check('system prompt delta: heavy ≤702B（block+join）', promptDeltaHeavy <= 702, `${promptDeltaHeavy}B`);
    check('OFF と ON-none は prompt delta 一致（neutral）', promptDeltaOff === promptDeltaNone);

    // ── evidence table（info 出力・secret / prompt 本文なし） ──
    console.log('  info  ── full absolute byte 実測（UTF-8）──');
    console.log(`  info  | 計測対象                         | OFF   | ON-none | ON-heavy | Delta |`);
    console.log(`  info  | compact Event Signal block       | 0     | 0       | ${String(blkHeavy).padEnd(8)} | ${blkHeavy} |`);
    console.log(`  info  | eventSignals JSON property       | 0     | 0       | ${String(eventSignalsProp).padEnd(8)} | ${eventSignalsProp} |`);
    console.log(`  info  | full request body (fixture)      | ${String(bytes(bodyOff)).padEnd(5)} | ${String(bytes(bodyNone)).padEnd(7)} | ${String(bytes(bodyHeavy)).padEnd(8)} | ${bodyDeltaHeavy} |`);
    console.log(`  info  | base system prompt (no user data)| ${String(basePromptBytes).padEnd(5)} | ${String(basePromptBytes).padEnd(7)} | ${String(basePromptBytes + promptDeltaHeavy).padEnd(8)} | ${promptDeltaHeavy} |`);
    console.log('  info  request body fixture = message(1000) + history(10×1000)。cross-feature snapshot は');
    console.log('  info    localStorage 由来のため非決定論 → 絶対値は近似。Signal delta は厳密測定。');
    console.log('  info  full system prompt 絶対値は route-private const（COMMANDER_PERSONA / OUTPUT_FORMAT）');
    console.log('  info    が import 不能のため測定不能。base orchestrated prompt を anchor に Signal delta を厳密測定。');
  }

  console.log('');
  if (failures === 0) {
    console.log('career-event-signal-consolidation-qa: ALL PASS');
    process.exit(0);
  } else {
    console.error(`career-event-signal-consolidation-qa: ${failures} FAIL`);
    process.exit(1);
  }
})();

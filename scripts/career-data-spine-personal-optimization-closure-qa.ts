/*
 * scripts/career-data-spine-personal-optimization-closure-qa.ts
 *
 * PASSAI CAREER — Personal Optimization Closure QA（POC-1 〜 POC-14）。
 *   dev-only・DI fake・実 Supabase 非接続・実 AI call なし。
 *
 * POC-1  すべての LIVE purpose が明示分類を持つ（call graph を authority にする）
 * POC-2  live purpose が Canary + auth を暗黙 bypass しない
 * POC-3  migrated purpose の server-capable source は server-derived にできる
 * POC-4  unverified source は **その semantic block だけ** bridge に落ちる
 * POC-5  server / memory / bridge を跨いだ semantic duplicate が無い
 * POC-6  non-canary は新しい source table read を起こさない
 * POC-7  server-authoritative source は偽造 client claim に依存しない
 * POC-8  client-only source は structural bridge として明示分類されている
 * POC-9  Event Signal が分離されたままである
 * POC-10 `es_generation` の分類が実 call graph と一致する（＝完全に消えている）
 * POC-11 retire 後に dead purpose の参照が残っていない
 * POC-12 history / context budget が有界のまま
 * POC-13 全 flag OFF で現行 production 互換の経路が保たれる
 * POC-14 service role / PII logging / D-R1 回帰が無い
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-data-spine-personal-optimization-closure-qa.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAREER_CONTEXT_PURPOSES,
  type CareerContextPurpose,
} from '@/lib/careerContext/purpose';
import {
  CAREER_SOURCE_KINDS,
  CAREER_SOURCE_AUTHORITY,
  CAREER_SOURCE_TABLES,
  EMPTY_CAREER_SOURCE_BUNDLE,
  emptySourceStatuses,
  requiresSourceSync,
  type CareerSourceBundle,
  type CareerSourceKind,
  type CareerSourceReadOutcome,
} from '@/lib/careerSourceData/types';
import {
  loadRequestSourceSnapshot,
  clearRequestSourceSnapshot,
  loadedKindsForRequest,
} from '@/lib/careerSourceData/requestSnapshot.server';
import {
  loadVerifiedCrossFeatureSources,
  type CrossFeatureSourceDeps,
} from '@/lib/careerServerContext/crossFeatureSources.server';
import { loadPurposeServerContext } from '@/lib/careerServerContext/purposeContext.server';
import { buildServerContextCanaryConfig } from '@/lib/careerServerContext/canaryGate';
import { computeSourceSyncRevisions } from '@/lib/careerSourceSync/revision';
import {
  serializeSourceSyncSignal,
  CAREER_SOURCE_SYNC_HEADER,
} from '@/lib/careerSourceSync/signal';
import { resolveMatchingContextInputs } from '@/app/api/career/matching/resolveContextInputs';
import { resolvePresentationContextInputs } from '@/app/api/career/presentation/resolveContextInputs';
import { resolveSelfAnalysisContextInputs } from '@/app/api/career/self-analysis/resolveContextInputs';
import { resolveConsultationContextInputs } from '@/app/api/career/consultation/resolveContextInputs';
import { buildSelfAnalysisPastSummaries } from '@/lib/careerSelfAnalysis/pastLogSummary';
import { personalMemorySectionsForPurpose } from '@/lib/careerMemory/personalMemoryPromptContext';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerGdRoomLog } from '@/types/careerGd';

const ROOT = process.cwd();

/** コメント行を除いた「実コード」だけを返す（retire 記録のコメントを誤検知しないため）。 */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
// ★ 合成 UUID。実 canary user の UUID は repo へ hardcode しない（env/operator 制御のまま）。
const CANARY = '11111111-1111-4111-8111-111111111111';
const OTHER = '00000000-0000-4000-8000-000000000001';

let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// ─────────────────────────────────────────────────────────────────
// purpose classification manifest（call graph が authority。manifest は「主張」）
// ─────────────────────────────────────────────────────────────────
type Classification =
  | 'FULL_SERVER'
  | 'HYBRID'
  | 'LEGACY'
  | 'INTENTIONALLY_CONTEXT_FREE'
  | 'ORPHAN'
  | 'DORMANT_INTENTIONAL';

type PurposeClaim = {
  purpose: CareerContextPurpose;
  classification: Classification;
  /** live callsite（repo-relative）。空 = live callsite なし。 */
  callsites: string[];
};

const PURPOSE_MANIFEST: PurposeClaim[] = [
  { purpose: 'consultation', classification: 'HYBRID', callsites: ['app/api/career/consultation/consultationPrompt.ts'] },
  { purpose: 'interview_practice', classification: 'FULL_SERVER', callsites: ['app/api/career/interview/interviewPrompt.ts'] },
  { purpose: 'company_research_review', classification: 'FULL_SERVER', callsites: ['app/api/career/company-research/route.ts'] },
  { purpose: 'presentation_feedback', classification: 'FULL_SERVER', callsites: ['app/api/career/presentation/presentationPrompt.ts'] },
  { purpose: 'matching', classification: 'HYBRID', callsites: ['app/api/career/matching/route.ts'] },
  { purpose: 'self_analysis', classification: 'FULL_SERVER', callsites: ['lib/careerSelfAnalysis/summaryPrompt.ts'] },
  { purpose: 'self_analysis_deep_dive', classification: 'FULL_SERVER', callsites: ['app/api/career/self-analysis/deepDivePrompt.ts'] },
  // Data Spine connection: ES 添削を Orchestrator へ接続した（route が base + 公式情報を結合）。
  //   es/deep・es/organize は「材料未選択時のみ」es_review policy を借りて背景 context を組む。
  { purpose: 'es_review', classification: 'FULL_SERVER', callsites: ['app/api/career/es-review/route.ts', 'app/api/career/es/resolveFallbackContext.ts'] },
  // ES 深掘り質問生成。企業依存設問でのみ Company Official を背景に載せるため、
  //   usage note を purpose 単位で分ける必要があり es_review とは別 purpose にしている。
  { purpose: 'es_deep_dive', classification: 'FULL_SERVER', callsites: ['app/api/career/es/resolveCompanyOfficial.ts'] },
  { purpose: 'interview_complete', classification: 'DORMANT_INTENTIONAL', callsites: [] },
  // STEP-GD-31: GD を Data Spine へ接続した。gd_feedback は DORMANT から **live** へ昇格。
  //   単一 callsite（gdSpinePrompt）が multi 評価 / solo 評価 / お題生成の 3 route から共有される。
  //   server 側の Layer 1 read（resolveContextInputs）で base + cross-feature を解決するため FULL_SERVER。
  { purpose: 'gd_feedback', classification: 'FULL_SERVER', callsites: ['app/api/career/gd/gdSpinePrompt.ts'] },
  { purpose: 'mypage_summary', classification: 'DORMANT_INTENTIONAL', callsites: [] },
];

/** purpose ごとの server-capable source（migrated purpose のみ）。 */
const PURPOSE_SOURCES: Partial<Record<CareerContextPurpose, readonly CareerSourceKind[]>> = {
  interview_practice: ['profile', 'activity', 'values', 'self_analysis', 'es', 'matching', 'consultation', 'company_research'],
  consultation: ['profile', 'activity', 'values', 'self_analysis', 'es', 'interview', 'presentation', 'company_research', 'matching', 'gd_room'],
  company_research_review: ['profile', 'activity', 'values', 'self_analysis', 'matching'],
  matching: ['profile', 'activity', 'values', 'self_analysis', 'es', 'interview', 'consultation', 'gd_room'],
  presentation_feedback: ['profile', 'activity', 'values', 'self_analysis', 'es', 'interview', 'matching', 'consultation'],
  self_analysis: ['profile', 'activity', 'values', 'self_analysis'],
  // STEP-GD-31: GD 評価が使う最小集合（base 3 + 自己分析 + 過去 GD）。
  gd_feedback: ['profile', 'activity', 'values', 'self_analysis', 'gd_room'],
  self_analysis_deep_dive: ['profile', 'activity', 'values', 'self_analysis'],
  // ES 添削: base 3 + 自己分析（横断ログは読まない）。
  es_review: ['profile', 'activity', 'values', 'self_analysis'],
};

// ─────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────
const SELF_LOG = {
  id: 'sa-1', createdAt: '2026-07-02T00:00:00.000Z', userInput: '',
  result: { summary: 'SELF_OK', strengths: ['s1'], careerDirection: 'DIR' },
} as unknown as CareerSelfAnalysisLog;

const GD_ROOM_LOG = {
  id: 'room-1', roomId: 'room-1', participantId: 'p1',
  createdAt: '2026-07-02T00:00:00.000Z',
  evaluation: { total: 20, comment: 'GD_ROOM_OK' },
  ranking: [], matchingHints: { hints: [], summary: '' },
  consultationSummary: 'GD_ROOM_SUMMARY',
} as unknown as CareerGdRoomLog;

const BUNDLE = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  profile: { name: 'N', grade: 'B3' },
  activity: { focusedActivities: [{ title: 'ACT_OK' }] },
  values: {
    selections: { priorities: ['p'], avoidances: [], industries: [], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] },
    notes: { priorities: '', avoidances: '', industries: '', jobTypes: '', workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '' },
    overallNote: '',
  },
  selfAnalysisLogs: [SELF_LOG],
  gdRoomLogs: [GD_ROOM_LOG],
} as unknown as CareerSourceBundle;

function reqWith(kinds: readonly CareerSourceKind[], bundle = BUNDLE): Request {
  const header = serializeSourceSyncSignal(computeSourceSyncRevisions(bundle, kinds));
  return new Request('https://example.test/x', { headers: { [CAREER_SOURCE_SYNC_HEADER]: header } });
}

function deps(opts: {
  spy?: { loads: number; kinds: CareerSourceKind[][] };
  purposes?: CareerContextPurpose[];
  userId?: string;
  bundle?: CareerSourceBundle;
}): CrossFeatureSourceDeps {
  return {
    loadCanaryConfig: () =>
      buildServerContextCanaryConfig(opts.purposes ?? [...CAREER_CONTEXT_PURPOSES], CANARY),
    loadSources: async (kinds, authorize) => {
      if (authorize && !authorize(opts.userId ?? CANARY)) {
        return {
          bundle: EMPTY_CAREER_SOURCE_BUNDLE,
          meta: { outcome: 'unauthorized', statuses: emptySourceStatuses(), durationMs: null },
        } as CareerSourceReadOutcome;
      }
      if (opts.spy) { opts.spy.loads += 1; opts.spy.kinds.push([...kinds]); }
      const statuses = emptySourceStatuses();
      for (const k of kinds) statuses[k] = 'ok';
      return {
        bundle: opts.bundle ?? BUNDLE,
        meta: { outcome: 'ok', statuses, durationMs: 1 },
      } as CareerSourceReadOutcome;
    },
  };
}

const ctxLoader = (o: Parameters<typeof deps>[0] = {}) =>
  ((purpose: never, kinds: never, req?: Request) =>
    loadPurposeServerContext(purpose, kinds, req, (p, k, rq) =>
      loadVerifiedCrossFeatureSources(p, k, rq, deps(o)),
    )) as never;

/** repo 全体から live callsite を探す（docs / scripts は除く＝production call graph）。 */
function findLiveCallsites(purpose: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      const src = readFileSync(full, 'utf8');
      // 実行される呼び出しだけを数える（型定義 / registry / 対応表は数えない）。
      if (new RegExp(`buildCareerContextForPurpose\\(\\s*['"]${purpose}['"]`).test(src)) {
        hits.push(full.slice(ROOT.length + 1));
      }
    }
  };
  for (const d of ['app', 'lib']) walk(join(ROOT, d));
  return hits.sort();
}

async function main() {
  console.log('=== career-data-spine-personal-optimization-closure-qa ===');

  // ── POC-1 ───────────────────────────────────────────────────────
  console.log('[POC-1] すべての LIVE purpose が明示分類を持つ');
  {
    const claimed = new Set(PURPOSE_MANIFEST.map((m) => m.purpose));
    for (const p of CAREER_CONTEXT_PURPOSES) {
      check(claimed.has(p), `${p}: manifest に分類がある`);
    }
    check(
      PURPOSE_MANIFEST.every((m) => CAREER_CONTEXT_PURPOSES.includes(m.purpose)),
      'manifest に存在しない purpose が含まれていない（retire 後の残骸なし）',
    );
    // ★ 分類は call graph と一致していること（manifest 単独では真とみなさない）。
    for (const m of PURPOSE_MANIFEST) {
      const actual = findLiveCallsites(m.purpose);
      const live = m.classification !== 'ORPHAN' && m.classification !== 'DORMANT_INTENTIONAL';
      check(
        live ? actual.length > 0 : actual.length === 0,
        `${m.purpose}: 分類(${m.classification}) と実 callsite(${actual.length}) が整合`,
        actual.join(','),
      );
      if (live) {
        for (const c of m.callsites) {
          check(actual.includes(c), `${m.purpose}: 宣言した callsite ${c} が実在する`);
        }
      }
    }
  }

  // ── POC-2 ───────────────────────────────────────────────────────
  console.log('[POC-2] live purpose が Canary + auth を暗黙 bypass しない');
  {
    const resolvers = readdirSync(join(ROOT, 'app/api/career'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join('app/api/career', e.name, 'resolveContextInputs.ts'))
      .filter((p) => existsSync(join(ROOT, p)));
    check(resolvers.length >= 6, `purpose resolver が検出できる（${resolvers.length} 件）`);
    for (const rel of resolvers) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      check(/loadPurposeServerContext/.test(src), `${rel}: 共有 canary 経路を通る`);
      check(!/isServerContextCanaryUser|CANARY_USER_IDS/.test(src), `${rel}: canary gate を自前実装しない`);
      check(!/serviceRole|SERVICE_ROLE/.test(src), `${rel}: service role なし`);
      check(!/b\.userId|body\.userId/.test(src), `${rel}: client 由来 userId を使わない`);
    }
  }

  // ── POC-3 ───────────────────────────────────────────────────────
  console.log('[POC-3] migrated purpose の server-capable source が server-derived になる');
  {
    for (const [purpose, kinds] of Object.entries(PURPOSE_SOURCES) as [CareerContextPurpose, CareerSourceKind[]][]) {
      const r = await loadVerifiedCrossFeatureSources(purpose, kinds, reqWith(kinds), deps({}));
      check(r.status === 'full_server', `${purpose}: 全 source が server（${r.status}）`);
      for (const k of kinds) check(r.origin[k] === 'server', `${purpose}/${k}: server`);
    }
    // 実 resolver でも server 由来になること。
    const m = await resolveMatchingContextInputs({ gdRoomSignals: [] }, reqWith(PURPOSE_SOURCES.matching!), ctxLoader());
    check(m.origins.base === 'server' && m.origins.selfAnalysis === 'server', 'matching resolver: base/selfAnalysis が server');
    check(m.origins.gdRoomSignals === 'server', 'matching resolver: gdRoom が server（class 2）');
    const p = await resolvePresentationContextInputs({}, reqWith(PURPOSE_SOURCES.presentation_feedback!), ctxLoader());
    check(p.origins.base === 'server' && p.origins.selfAnalysis === 'server', 'presentation resolver: server 由来');
    const sa = await resolveSelfAnalysisContextInputs(
      'self_analysis', { pastSummaries: [] }, reqWith(PURPOSE_SOURCES.self_analysis!), ctxLoader(),
    );
    check(sa.origins.base === 'server' && sa.origins.pastSummaries === 'server', 'self_analysis resolver: server 由来');
    check(
      JSON.stringify(sa.pastSummaries) === JSON.stringify(buildSelfAnalysisPastSummaries(BUNDLE.selfAnalysisLogs)),
      'self_analysis parity: pastSummaries が client と同一 pure 関数の出力',
    );
  }

  // ── POC-4 ───────────────────────────────────────────────────────
  console.log('[POC-4] unverified source は該当 semantic block だけ bridge に落ちる');
  {
    const kinds = PURPOSE_SOURCES.presentation_feedback!;
    const claims = computeSourceSyncRevisions(BUNDLE, kinds);
    claims.self_analysis = 'v1:deadbeef';
    const req = new Request('https://example.test/x', {
      headers: { [CAREER_SOURCE_SYNC_HEADER]: serializeSourceSyncSignal(claims) },
    });
    const r = await resolvePresentationContextInputs(
      { selfAnalysis: { summary: 'BRIDGE_SELF' } }, req, ctxLoader(),
    );
    check(r.origins.selfAnalysis === 'bridge', 'mismatch した self_analysis のみ bridge');
    check(r.origins.base === 'server', 'base は server のまま（section isolation）');
    check((r.selfAnalysis as { summary?: string })?.summary === 'BRIDGE_SELF', 'bridge 値が使われる');
  }

  // ── POC-5 ───────────────────────────────────────────────────────
  console.log('[POC-5] server / memory / bridge を跨いだ semantic duplicate が無い');
  {
    // (a) Personal Memory を注入する purpose の集合（AI coverage slice で 5 purpose へ拡張）。
    //   ★ 非注入は「未実装」ではなく設計判断:
    //     gd_feedback              … 採点根拠は transcript のみ / budget 最小
    //     self_analysis(_deep_dive)… 自己参照ループ回避（Layer 1 の過去ログのみ）
    //     es_deep_dive             … extras を渡す live 経路が無い（ES の Layer 2 は es_review 経由）
    //     matching                 … PII 契約 + deferral 維持
    //   allowlist と live callsite の一致は career-personal-memory-ai-coverage-qa が固定する。
    const EXPECTED_MEMORY_PURPOSES = [
      'interview_practice',
      'consultation',
      'company_research_review',
      'es_review',
      'presentation_feedback',
    ];
    const memoryPurposes = CAREER_CONTEXT_PURPOSES.filter(
      (p) => personalMemorySectionsForPurpose(p).length > 0,
    );
    check(
      memoryPurposes.length === EXPECTED_MEMORY_PURPOSES.length &&
        memoryPurposes.every((p) => EXPECTED_MEMORY_PURPOSES.includes(p)),
      `Personal Memory 対象 purpose が想定どおり（${memoryPurposes.join(',')}）`,
    );
    // (b) Memory を実際に prompt へ載せる route は dedupe を通す。
    const cr = readFileSync(join(ROOT, 'app/api/career/company-research/route.ts'), 'utf8');
    check(/dedupePersonalMemorySections\(/.test(cr), 'company_research_review: dedupe を通す');
    check(/self_analysis:\s*selfAnalysisBlock !== ''/.test(cr), 'dedupe presence が「実際に描画するか」ベース');
    // (c) resolver は field ごとに server か bridge の **どちらか一方**しか出力しない。
    for (const rel of readdirSync(join(ROOT, 'app/api/career'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join('app/api/career', e.name, 'resolveContextInputs.ts'))
      .filter((p) => existsSync(join(ROOT, p)))) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      check(!/\.concat\(|\[\s*\.\.\.server[A-Za-z]*,\s*\.\.\.(bridge|fallback)/.test(src),
        `${rel}: server と bridge を連結しない`);
    }
    // (d) consultation は Personal Memory を prompt へ載せない（bridge と重複するため / D-S5）。
    const consult = readFileSync(join(ROOT, 'app/api/career/consultation/route.ts'), 'utf8');
    check(!/loadPersonalMemorySectionsForPrompt/.test(consult), 'consultation: Personal Memory を注入しない');
  }

  // ── POC-6 ───────────────────────────────────────────────────────
  console.log('[POC-6] non-canary は新しい source table read を起こさない');
  {
    for (const [purpose, kinds] of Object.entries(PURPOSE_SOURCES) as [CareerContextPurpose, CareerSourceKind[]][]) {
      const spy = { loads: 0, kinds: [] as CareerSourceKind[][] };
      const r = await loadVerifiedCrossFeatureSources(
        purpose, kinds, reqWith(kinds), deps({ spy, userId: OTHER }),
      );
      check(spy.loads === 0, `${purpose}: non-canary → table read ゼロ`);
      check(r.status === 'user_not_canary', `${purpose}: user_not_canary`);
    }
    // purpose OFF → I/O ゼロ。
    const spy2 = { loads: 0, kinds: [] as CareerSourceKind[][] };
    const off = await loadVerifiedCrossFeatureSources(
      'matching', PURPOSE_SOURCES.matching!, reqWith(PURPOSE_SOURCES.matching!), deps({ spy: spy2, purposes: [] }),
    );
    check(spy2.loads === 0 && off.status === 'purpose_disabled', 'purpose OFF → I/O ゼロ');
  }

  // ── POC-7 ───────────────────────────────────────────────────────
  console.log('[POC-7] server-authoritative source は偽造 client claim に依存しない');
  {
    check(CAREER_SOURCE_AUTHORITY.gd_room === 'server_authoritative', 'gd_room は class 2');
    check(!requiresSourceSync('gd_room'), 'gd_room は Source-Sync を要求しない');
    for (const k of CAREER_SOURCE_KINDS) {
      if (k === 'gd_room') continue;
      check(requiresSourceSync(k), `${k}: class 1（Source-Sync 必要）`);
    }
    // (a) claim が **完全に欠落**していても gd_room は server 由来になる。
    const kinds: CareerSourceKind[] = ['gd_room'];
    const noClaim = await loadVerifiedCrossFeatureSources(
      'matching', kinds, new Request('https://example.test/x'), deps({}),
    );
    check(noClaim.origin.gd_room === 'server', 'claim 無しでも gd_room は server（正しい authority）');
    // (b) **偽造 claim** を送っても結果が変わらない（client が影響できない）。
    const forged = new Request('https://example.test/x', {
      headers: { [CAREER_SOURCE_SYNC_HEADER]: 'v1:gd_room=deadbeef' },
    });
    const withForged = await loadVerifiedCrossFeatureSources('matching', kinds, forged, deps({}));
    check(withForged.origin.gd_room === 'server', '偽造 claim でも gd_room の採用は変わらない');
    // (c) ただし authorization は免除されない。
    const notCanary = await loadVerifiedCrossFeatureSources(
      'matching', kinds, new Request('https://example.test/x'), deps({ userId: OTHER }),
    );
    check(notCanary.origin.gd_room === 'bridge' && notCanary.status === 'user_not_canary',
      'class 2 でも canary gate は効く（authorization は免除されない）');
    // (d) owner-scoped read であること（server reader が userId で絞る）。
    const reader = readFileSync(join(ROOT, 'lib/careerSourceData/serverReader.server.ts'), 'utf8');
    check(/CAREER_SOURCE_TABLES\.gd_room/.test(reader), 'gd_room を共有 reader 経由で読む');
    check(!/serviceRole|SERVICE_ROLE/.test(reader), 'reader は service role を使わない（owner-scoped RLS のみ）');
    check(CAREER_SOURCE_TABLES.gd_room === 'career_gd_room_results', 'gd_room の table が正しい');
  }

  // ── POC-8 ───────────────────────────────────────────────────────
  console.log('[POC-8] client-only source が structural bridge として明示されている');
  {
    check(!(CAREER_SOURCE_KINDS as readonly string[]).includes('gd'), 'solo gd は source kind に無い');
    // ★ ここで守るのは「solo GD は **server 側 Data Spine の source ではない**」という
    //   structural bridge の性質であって、「solo GD がどこにも永続化されない」ことではない。
    //
    //   旧実装は「schema に solo GD の table が無い」「mirror module が無い」を根拠にして
    //   いたが、その後 solo GD は他機能（ES / 面接 / プレゼン）と同水準の耐久性を持つよう
    //   owner-scoped な durable mirror（career_gd_solo_results / lib/supabase/careerGdSolo.ts）
    //   を **意図的に**獲得した。存在しないことを根拠にする形はもう成立しない。
    //
    //   永続化そのもの（DDL / natural key / GRANT 最小権限 / restore 経路）は
    //   scripts/career-gd-company-and-solo-persistence-qa.ts が専任で固定しているため
    //   ここでは重複して検証しない。本 QA は Data Spine 境界だけを見る。
    check(
      !Object.values(CAREER_SOURCE_TABLES).some((t) => /gd_solo|career_gd_results\b/.test(String(t))),
      'solo GD の table が Data Spine の source table 表に無い（server context が読まない）',
      Object.values(CAREER_SOURCE_TABLES).join(','),
    );
    const serverReaderSrc = readFileSync(
      join(ROOT, 'lib/careerSourceData/serverReader.server.ts'), 'utf8',
    );
    check(
      !/career_gd_solo/.test(serverReaderSrc),
      '共有 server reader が solo GD の table を読まない（structural bridge のまま）',
    );
    // 観測語彙で safety fallback と区別される。
    const obs = readFileSync(join(ROOT, 'lib/careerDataSpineCanary/observation.ts'), 'utf8');
    check(/not_server_capable/.test(obs), 'structural bridge 用の観測値がある');
    check(/CANARY_STRUCTURAL_BRIDGE_SOURCES/.test(obs), 'structural bridge source が列挙されている');
    // consultation / matching が実際にそれを報告する。
    for (const rel of [
      'app/api/career/consultation/resolveContextInputs.ts',
      'app/api/career/matching/resolveContextInputs.ts',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      check(/markStructuralBridges\(\['gd_solo'\]\)/.test(src), `${rel}: solo gd を structural bridge として観測`);
    }
  }

  // ── POC-9 ───────────────────────────────────────────────────────
  console.log('[POC-9] Event Signal が分離されたまま');
  {
    for (const rel of [
      'lib/careerServerContext/purposeContext.server.ts',
      'lib/careerServerContext/crossFeatureSources.server.ts',
      'lib/careerSourceData/requestSnapshot.server.ts',
      'lib/careerSourceData/serverReader.server.ts',
      'lib/careerMemory/selector.ts',
      'lib/careerContext/orchestrator.ts',
    ]) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      check(!/eventSignal|EventSignal|careerEvents/.test(code), `${rel}: Event Signal 非依存`);
    }
    // consultation route は現行位置で独立に resolve する（selector 入力へ混ぜない）。
    const consult = readFileSync(join(ROOT, 'app/api/career/consultation/route.ts'), 'utf8');
    check(/resolveConsultationEventSignalsBlock\(/.test(consult), 'consultation: Event Signal は route が独立 resolve');
    const cResolver = readFileSync(join(ROOT, 'app/api/career/consultation/resolveContextInputs.ts'), 'utf8');
    check(!/eventSignal|EventSignal/i.test(cResolver.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')),
      'consultation resolver: Event Signal を selector 入力へ混ぜない');
  }

  // ── POC-10 / POC-11 ─────────────────────────────────────────────
  console.log('[POC-10/POC-11] es_generation の retire が call graph と一致する');
  {
    check(!(CAREER_CONTEXT_PURPOSES as readonly string[]).includes('es_generation'), 'purpose enum から消えている');
    check(findLiveCallsites('es_generation').length === 0, 'live callsite ゼロ');
    check(!existsSync(join(ROOT, 'lib/careerMemory/renderers/esGenerationCrossFeature.ts')), 'orphan renderer が削除されている');
    // production code に参照が残っていない（Layer 5 の string-keyed vocabulary は別系統）。
    const stale: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        // Layer 5（careerCompanyKnowledge）は CareerContextPurpose と非結合の
        // string-keyed vocabulary（`company_research` 等）を持つ別 subsystem。対象外。
        if (full.includes('careerCompanyKnowledge')) continue;
        // ★ 実コードのみを見る。retire を記録したコメントは意図的に残す（履歴の可読性）。
        const src = codeOnly(readFileSync(full, 'utf8'));
        if (/es_generation|EsGenerationCrossFeature|esGenerationCrossFeature/.test(src)) {
          stale.push(full.slice(ROOT.length + 1));
        }
      }
    };
    for (const d of ['app', 'lib']) walk(join(ROOT, d));
    check(stale.length === 0, 'production code に es_generation 参照が残っていない', stale.join(','));
    // ★ Layer 5 の vocabulary が CareerContextPurpose と非結合であることを固定する
    //   （暗黙依存を作らないための明示 assertion）。
    const l5 = readFileSync(join(ROOT, 'lib/careerCompanyKnowledge/policy.ts'), 'utf8');
    check(/Record<string,/.test(l5), 'Layer 5 allowlist は string-keyed（purpose enum と非結合）');
    check(/company_research:/.test(l5), 'Layer 5 は独自 vocabulary を使う（company_research_review ではない）');
  }

  // ── POC-12 ──────────────────────────────────────────────────────
  console.log('[POC-12] history / context budget が有界のまま');
  {
    const many = Array.from({ length: 50 }, (_, i) => ({
      ...(SELF_LOG as unknown as Record<string, unknown>), id: `sa-${i}`,
    })) as unknown as CareerSelfAnalysisLog[];
    const bigBundle = { ...BUNDLE, selfAnalysisLogs: many } as CareerSourceBundle;
    const kinds = PURPOSE_SOURCES.self_analysis!;
    const sa = await resolveSelfAnalysisContextInputs(
      'self_analysis', { pastSummaries: [] }, reqWith(kinds, bigBundle),
      ctxLoader({ bundle: bigBundle }),
    );
    check(sa.pastSummaries.length <= 3, `pastSummaries が有界（${sa.pastSummaries.length} 件）`);

    const manyGd = Array.from({ length: 30 }, (_, i) => ({
      ...(GD_ROOM_LOG as unknown as Record<string, unknown>), id: `room-${i}`, roomId: `room-${i}`,
    })) as unknown as CareerGdRoomLog[];
    const gdBundle = { ...BUNDLE, gdRoomLogs: manyGd } as CareerSourceBundle;
    const c = await resolveConsultationContextInputs(
      {
        selfAnalysisHistory: [], esHistory: [], interviewHistory: [],
        presentationHistory: [], companyResearch: [], matching: [], gdRoom: [],
      },
      reqWith(PURPOSE_SOURCES.consultation!, gdBundle),
      ctxLoader({ bundle: gdBundle }),
    );
    check(c.gdRoom.length <= 3, `gdRoom signals が有界（${c.gdRoom.length} 件）`);
    check(c.selfAnalysisHistory.length <= 3, `selfAnalysisHistory が有界（${c.selfAnalysisHistory.length} 件）`);
  }

  // ── POC-13 ──────────────────────────────────────────────────────
  console.log('[POC-13] 全 flag OFF で現行 production 互換');
  {
    for (const [purpose, kinds] of Object.entries(PURPOSE_SOURCES) as [CareerContextPurpose, CareerSourceKind[]][]) {
      const spy = { loads: 0, kinds: [] as CareerSourceKind[][] };
      const r = await loadVerifiedCrossFeatureSources(
        purpose, kinds, reqWith(kinds), deps({ spy, purposes: [] }),
      );
      check(spy.loads === 0, `${purpose}: flag OFF → I/O ゼロ`);
      check(kinds.every((k) => r.origin[k] === 'bridge'), `${purpose}: 全 source が bridge（従来経路）`);
    }
    // resolver も bridge 値をそのまま返す。
    const m = await resolveMatchingContextInputs(
      { selfAnalysis: { summary: 'BRIDGE' }, gdRoomSignals: [{ x: 1 }] },
      reqWith(PURPOSE_SOURCES.matching!),
      ctxLoader({ purposes: [] }),
    );
    check((m.selfAnalysis as { summary?: string })?.summary === 'BRIDGE', 'flag OFF: bridge 値が保持される');
    check(m.gdRoomSignals.length === 1, 'flag OFF: gdRoom も bridge 値のまま');
  }

  // ── POC-14 ──────────────────────────────────────────────────────
  console.log('[POC-14] service role / PII logging / D-R1 回帰が無い');
  {
    const spineFiles = [
      'lib/careerSourceData/serverReader.server.ts',
      'lib/careerSourceData/requestSnapshot.server.ts',
      'lib/careerServerContext/crossFeatureSources.server.ts',
      'lib/careerServerContext/purposeContext.server.ts',
      'lib/careerDataSpineCanary/counters.server.ts',
      'lib/careerDataSpineCanary/observation.ts',
      'lib/careerDataSpineCanary/sourceObservation.ts',
    ];
    for (const rel of spineFiles) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      check(!/serviceRole|SERVICE_ROLE/.test(code), `${rel}: service role なし`);
      check(!/console\.(log|warn|error|info)/.test(code), `${rel}: log を出さない`);
      check(!/LEGACY_D_R1|CAREER_PERSONAL_MEMORY_LEGACY/.test(code), `${rel}: D-R1 経路なし`);
    }
    // D-R1 の env / code path が repo から消えていること。
    let dr1 = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        // ★ 実コードのみ（「削除済み」と記録したコメントは残ってよい）。
        if (/CAREER_PERSONAL_MEMORY_LEGACY_D_R1/.test(codeOnly(readFileSync(full, 'utf8')))) dr1 += 1;
      }
    };
    for (const d of ['app', 'lib']) walk(join(ROOT, d));
    check(dr1 === 0, 'D-R1 env が production code に存在しない');
    // request snapshot が識別子を meta / 戻り値へ出さない。
    // ★ 静的 regex ではなく **実際の戻り値**で検証する（userId が外へ出ないこと）。
    const probeReq = new Request('https://example.test/pii-probe');
    clearRequestSourceSnapshot(probeReq);
    const probeLoad = (async (kinds: readonly CareerSourceKind[], _n?: unknown, authorize?: (u: string) => boolean) => {
      authorize?.(CANARY);
      const st = emptySourceStatuses();
      for (const k of kinds) st[k] = 'ok';
      return { bundle: BUNDLE, meta: { outcome: 'ok', statuses: st, durationMs: 1 } } as CareerSourceReadOutcome;
    }) as never;
    await loadRequestSourceSnapshot(['profile'], probeReq, undefined, probeLoad);
    const cached = await loadRequestSourceSnapshot(['profile'], probeReq, undefined, probeLoad);
    const metaJson = JSON.stringify(cached.meta);
    check(!metaJson.includes(CANARY), '★ snapshot の meta に userId が出ない');
    check(!/userId|user_id/.test(metaJson), 'meta に userId 相当の key が無い');
    check(
      !JSON.stringify(loadedKindsForRequest(probeReq)).includes(CANARY),
      '観測 helper も userId を返さない',
    );
  }

  // ── POC-15（追加）: request-local snapshot の重複 read 排除 ──────
  console.log('[POC-extra] 1 request / 1 Layer 1 snapshot（`D-S13`）');
  {
    const calls: CareerSourceKind[][] = [];
    const fakeLoad = (async (kinds: readonly CareerSourceKind[], _now?: unknown, authorize?: (u: string) => boolean) => {
      if (authorize && !authorize(CANARY)) {
        return { bundle: EMPTY_CAREER_SOURCE_BUNDLE, meta: { outcome: 'unauthorized', statuses: emptySourceStatuses(), durationMs: null } } as CareerSourceReadOutcome;
      }
      calls.push([...kinds]);
      const statuses = emptySourceStatuses();
      for (const k of kinds) statuses[k] = 'ok';
      return { bundle: BUNDLE, meta: { outcome: 'ok', statuses, durationMs: 1 } } as CareerSourceReadOutcome;
    }) as never;

    const req = new Request('https://example.test/snapshot');
    clearRequestSourceSnapshot(req);
    await loadRequestSourceSnapshot(['profile', 'activity', 'values', 'self_analysis'], req, undefined, fakeLoad);
    check(calls.length === 1, '1 回目: read 発生');
    // 2 番目の consumer（Personal Memory）が同じ kind を要求 → 追加 read なし。
    const second = await loadRequestSourceSnapshot(['profile', 'self_analysis'], req, undefined, fakeLoad);
    check(calls.length === 1, '★ 同じ kind の再 read が発生しない（重複 Layer 1 read 排除）');
    check(second.bundle.profile !== null && second.bundle.selfAnalysisLogs.length === 1, 'cache から正しい値が返る');
    check(second.bundle.esLogs.length === 0, '未要求 kind は空のまま返る');
    // 未読 kind を要求 → **不足分だけ** read する。
    await loadRequestSourceSnapshot(['profile', 'es'], req, undefined, fakeLoad);
    check(calls.length === 2 && calls[1].length === 1 && calls[1][0] === 'es', '不足 kind だけを追加 read する');
    check(loadedKindsForRequest(req).includes('es'), 'snapshot に追記される');
    // ★ cache hit でも authorize は再評価される（緩い gate の結果を厳しい gate が受け取らない）。
    const denied = await loadRequestSourceSnapshot(['profile'], req, () => false, fakeLoad);
    check(denied.meta.outcome === 'unauthorized', '★ cache hit でも authorize deny が効く');
    check(denied.bundle.profile === null, 'deny 時にデータを返さない');
    check(calls.length === 2, 'deny で追加 read も発生しない');
    // request が違えば cache は共有されない。
    const other = new Request('https://example.test/other');
    await loadRequestSourceSnapshot(['profile'], other, undefined, fakeLoad);
    check(calls.length === 3, '別 request では cache を共有しない');
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-data-spine-personal-optimization-closure-qa: ALL PASS'
      : `career-data-spine-personal-optimization-closure-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();

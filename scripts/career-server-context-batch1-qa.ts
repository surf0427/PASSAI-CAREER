/*
 * scripts/career-server-context-batch1-qa.ts
 *
 * PASSAI CAREER — Server Context Expansion Batch 1 QA（consultation / company_research_review）。
 *   dev-only・DI fake・実 Supabase 非接続。
 *
 * Q1 canary + purpose ON + sync verified → server context used
 * Q2 non-canary                          → server source table read ゼロ / bridge
 * Q3 sync mismatch                       → mismatch 由来の personal context を使わない
 * Q4 signal absent                       → safe fallback
 * Q5 mirror unreadable                   → safe fallback
 * Q6 purpose OFF                         → 既存挙動（I/O ゼロ）
 * Q7 Event Signal が Personal Memory へ混ざらない
 * Q8 Event Signal → matching/ability 推論の辺が増えていない
 *
 * R1 canary + verified                   → server-driven Personal Memory / context
 * R2 non-canary                          → 既存の安全な挙動
 * R3 memory stale + source verified      → rebuild
 * R4 source mismatch                     → 該当 section を veto
 * R5 ★ server context と request-body の二重注入が無い
 * R6 all flags OFF                       → 現行 production 互換
 *
 * D1-D3 dedupe 純関数の契約
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-server-context-batch1-qa.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadServerBaseContext,
  type ServerBaseContextDeps,
} from '@/lib/careerServerContext/baseContext.server';
import { buildServerContextCanaryConfig } from '@/lib/careerServerContext/canaryGate';
import { dedupePersonalMemorySections } from '@/lib/careerMemory/personalMemoryDedupe';
import {
  loadPersonalMemorySectionsForPrompt,
  type PersonalMemoryReadServerDeps,
} from '@/lib/careerMemory/persistence/personalMemoryReadServer.server';
import { buildPersonalMemoryReadGateConfig } from '@/lib/careerMemory/persistence/readGate';
import { projectSectionFromSource } from '@/lib/careerMemory/persistence/sourceProjection';
import { renderPersonalMemoryForPurpose } from '@/lib/careerMemory/personalMemoryPromptContext';
import { computeSourceSyncRevisions } from '@/lib/careerSourceSync/revision';
import {
  parseSourceSyncSignal,
  serializeSourceSyncSignal,
  EMPTY_SOURCE_SYNC_SIGNAL,
  type CareerSourceSyncSignal,
} from '@/lib/careerSourceSync/signal';
import {
  EMPTY_CAREER_SOURCE_BUNDLE,
  emptySourceStatuses,
  type CareerSourceBundle,
  type CareerSourceReadOutcome,
  type CareerSourceReadStatus,
} from '@/lib/careerSourceData/types';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

const ROOT = process.cwd();
// ★ 合成 UUID。実 canary user の UUID は repo へ hardcode しない（env/operator 制御のまま）。
const CANARY = '11111111-1111-4111-8111-111111111111';
const OTHER = '00000000-0000-4000-8000-000000000001';

let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const BUNDLE = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  profile: { name: 'N', grade: 'B3', preferences: [{ university: 'UNIV_OK' }] },
  activity: { focusedActivities: [{ title: 'ACT_OK' }] },
  values: {
    selections: { priorities: ['p'], avoidances: [], industries: [], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] },
    notes: { priorities: '', avoidances: '', industries: '', jobTypes: '', workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '' },
    overallNote: '',
  },
  selfAnalysisLogs: [{ id: 'sa-1', createdAt: '2026-07-02T00:00:00.000Z', userInput: '', result: { summary: 'SELF_OK' } } as unknown as CareerSelfAnalysisLog],
} as unknown as CareerSourceBundle;

/** mirror 側だけ違う（profile drift）。mirror 固有マーカーで leak を精密検出する。 */
const MIRROR_DRIFT = {
  ...(BUNDLE as object),
  profile: { name: 'N', grade: 'B4', preferences: [{ university: 'MIRROR_ONLY_STALE' }] },
} as unknown as CareerSourceBundle;

const syncOf = (b: CareerSourceBundle): CareerSourceSyncSignal =>
  parseSourceSyncSignal(serializeSourceSyncSignal(computeSourceSyncRevisions(b)));

function src(bundle: CareerSourceBundle, status: CareerSourceReadStatus = 'ok'): CareerSourceReadOutcome {
  const st = emptySourceStatuses();
  for (const k of Object.keys(st) as (keyof typeof st)[]) st[k] = status;
  return { bundle, meta: { outcome: status === 'error' ? 'error' : 'ok', statuses: st, durationMs: 0 } };
}

type Spy = { loads: number; tableReads: number; authorized: boolean | null };
const newSpy = (): Spy => ({ loads: 0, tableReads: 0, authorized: null });

function ctxDeps(opts: {
  purposes?: readonly string[];
  requestUser?: string;
  bundle?: CareerSourceBundle;
  status?: CareerSourceReadStatus;
  spy: Spy;
}): ServerBaseContextDeps {
  const { purposes = ['consultation', 'company_research_review'], requestUser = CANARY, bundle = BUNDLE, status = 'ok', spy } = opts;
  return {
    loadCanaryConfig: () => buildServerContextCanaryConfig(purposes as never, CANARY),
    loadSources: async (kinds, authorize) => {
      spy.loads++;
      if (authorize) {
        const ok = authorize(requestUser);
        spy.authorized = ok;
        if (!ok) {
          return { bundle: EMPTY_CAREER_SOURCE_BUNDLE, meta: { outcome: 'unauthorized', statuses: emptySourceStatuses(), durationMs: 0 } };
        }
      }
      spy.tableReads += kinds.length;
      return src(bundle, status);
    },
  };
}

function pmDeps(opts: { userId?: string; rows?: unknown[]; source?: CareerSourceReadOutcome; enabled?: boolean }): PersonalMemoryReadServerDeps {
  const { userId = CANARY, rows = [], source = src(BUNDLE), enabled = true } = opts;
  return {
    isEnabled: () => enabled,
    loadGateConfig: () => buildPersonalMemoryReadGateConfig('true', CANARY),
    loadSourceConfig: () => ({ rebuildOnStaleEnabled: true }),
    loadSources: async () => source,
    now: () => 0,
    createReader: async () => ({
      async getUserId() { return userId; },
      async selectSections() { return { rows, error: null }; },
    }),
  };
}

async function main() {
  // ══════════════ consultation ══════════════
  console.log('[Q1] consultation: canary + purpose ON + verified → server context used');
  {
    const spy = newSpy();
    const r = await loadServerBaseContext('consultation', syncOf(BUNDLE), ctxDeps({ spy }));
    check(r.reason === 'server_source' && r.context !== null, `server context 採用（got ${r.reason}）`);
    check(JSON.stringify(r.context?.profile).includes('UNIV_OK'), 'Layer 1 由来の profile');
  }

  console.log('[Q2] consultation: non-canary → table read ゼロ / bridge');
  {
    const spy = newSpy();
    const r = await loadServerBaseContext('consultation', syncOf(BUNDLE), ctxDeps({ spy, requestUser: OTHER }));
    check(r.context === null && r.reason === 'user_not_canary', `bridge（got ${r.reason}）`);
    check(spy.tableReads === 0, '★ server source table read ゼロ');
  }

  console.log('[Q3] consultation: sync mismatch → mismatch 由来 context を使わない');
  {
    const spy = newSpy();
    const r = await loadServerBaseContext('consultation', syncOf(BUNDLE), ctxDeps({ spy, bundle: MIRROR_DRIFT }));
    check(r.context === null && r.reason === 'sync_unverified', `veto（got ${r.reason}）`);
    check(!JSON.stringify(r.context ?? {}).includes('MIRROR_ONLY_STALE'), '★ stale mirror 内容が出ない');
  }

  console.log('[Q4] consultation: signal absent → safe fallback');
  {
    const spy = newSpy();
    const r = await loadServerBaseContext('consultation', EMPTY_SOURCE_SYNC_SIGNAL, ctxDeps({ spy }));
    check(r.context === null && r.reason === 'sync_unverified', `bridge（got ${r.reason}）`);
  }

  console.log('[Q5] consultation: mirror unreadable → safe fallback');
  {
    for (const status of ['error', 'truncated'] as const) {
      const spy = newSpy();
      const r = await loadServerBaseContext('consultation', syncOf(BUNDLE), ctxDeps({ spy, status }));
      check(r.context === null && r.reason === 'source_unavailable', `${status} → bridge`);
    }
  }

  console.log('[Q6] consultation: purpose OFF → 既存挙動（I/O ゼロ）');
  {
    const spy = newSpy();
    const r = await loadServerBaseContext('consultation', syncOf(BUNDLE), ctxDeps({ spy, purposes: [] }));
    check(r.context === null && r.reason === 'flag_off', 'flag_off');
    check(spy.loads === 0, 'Source read を呼ばない');
  }

  console.log('[Q7] Event Signal が Personal Memory / server context へ混ざらない');
  {
    for (const rel of [
      'lib/careerServerContext/purposeContext.server.ts',
      'lib/careerServerContext/crossFeatureSources.server.ts',
      'lib/careerServerContext/baseContext.server.ts',
      'lib/careerMemory/persistence/personalMemoryReadServer.server.ts',
      'lib/careerMemory/personalMemoryDedupe.ts',
    ]) {
      const code = readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      check(!/eventSignal|EventSignal|careerEvents/.test(code), `${rel}: Event Signal 非依存（D-L3）`);
    }
    // consultation route では Event Signal は独立 block のまま（base 解決とは別経路）。
    const route = readFileSync(join(ROOT, 'app/api/career/consultation/route.ts'), 'utf8');
    check(/resolveConsultationEventSignalsBlock\(/.test(route), 'Event Signal は従来どおり route が独立に resolve');
    check(!/personalMemory[^D]/.test(route.replace(/\/\/.*$/gm, '')), 'consultation は Personal Memory を注入しない（重複回避）');
  }

  console.log('[Q8] Event Signal → matching / ability 推論の辺が増えていない');
  {
    for (const rel of ['lib/careerMatching', 'app/api/career/matching']) {
      const dir = join(ROOT, rel);
      let hit = false;
      try {
        const walk = (d: string): void => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!/\.tsx?$/.test(e.name)) continue;
            if (/loadCareerEventSignalSummary|eventSignals/.test(readFileSync(p, 'utf8'))) hit = true;
          }
        };
        walk(dir);
      } catch { /* dir may not exist */ }
      check(!hit, `${rel}: Event Signal を読まない（D-L4）`);
    }
  }

  // ══════════════ company_research_review ══════════════
  console.log('[R1] company_research: canary + verified → server-driven path');
  {
    const spy = newSpy();
    const ctx = await loadServerBaseContext('company_research_review', syncOf(BUNDLE), ctxDeps({ spy }));
    check(ctx.reason === 'server_source', `base context server 化（got ${ctx.reason}）`);
    const P = projectSectionFromSource('self_analysis', BUNDLE)!;
    const row = { section_key: 'self_analysis', schema_version: 1, source_revision: P.sourceRevision, source_updated_at: P.sourceUpdatedAt, generated_at: '2026-07-25T00:00:00.000Z', status: 'fresh', payload: P.section.payload };
    const mem = await loadPersonalMemorySectionsForPrompt('company_research_review', syncOf(BUNDLE), pmDeps({ rows: [row] }));
    check(mem.sections.length > 0, 'Personal Memory も server-driven に取得できる');
  }

  console.log('[R2] company_research: non-canary → 既存の安全な挙動');
  {
    const spy = newSpy();
    const ctx = await loadServerBaseContext('company_research_review', syncOf(BUNDLE), ctxDeps({ spy, requestUser: OTHER }));
    check(ctx.context === null && spy.tableReads === 0, 'bridge / table read ゼロ');
    const mem = await loadPersonalMemorySectionsForPrompt('company_research_review', syncOf(BUNDLE), pmDeps({ userId: OTHER }));
    check(mem.sections.length === 0 && mem.meta.gate === 'denied', 'Personal Memory も denied');
  }

  console.log('[R3] company_research: memory stale + source verified → rebuild');
  {
    const P = projectSectionFromSource('self_analysis', BUNDLE)!;
    const stale = { section_key: 'self_analysis', schema_version: 1, source_revision: 'v1:content:stale000', source_updated_at: P.sourceUpdatedAt, generated_at: '2026-07-25T00:00:00.000Z', status: 'fresh', payload: P.section.payload };
    const mem = await loadPersonalMemorySectionsForPrompt('company_research_review', syncOf(BUNDLE), pmDeps({ rows: [stale] }));
    check(mem.meta.origins.self_analysis === 'rebuilt', `rebuild（got ${mem.meta.origins.self_analysis}）`);
  }

  console.log('[R4] company_research: source mismatch → 該当 section を veto');
  {
    const mem = await loadPersonalMemorySectionsForPrompt('company_research_review', syncOf(BUNDLE), pmDeps({ source: src(MIRROR_DRIFT) }));
    // profile drift → base のみ mismatch。self_analysis は一致するので使える（section isolation）。
    check(mem.meta.vetoed.base === 'mismatch', `base を veto（got ${mem.meta.vetoed.base}）`);
    check(!mem.sections.some((s) => s.sectionKey === 'base'), 'base section が使われない');
    check(!JSON.stringify(mem.sections).includes('MIRROR_ONLY_STALE'), '★ mismatch 由来の内容が漏れない');
    check(mem.sections.some((s) => s.sectionKey === 'self_analysis'), 'verified な self_analysis は使える（全部捨てない）');
  }

  console.log('[R5] ★ server context と request-body の二重注入が無い');
  {
    const P_BASE = projectSectionFromSource('base', BUNDLE)!;
    const P_SELF = projectSectionFromSource('self_analysis', BUNDLE)!;
    const sections = [P_BASE.section, P_SELF.section];

    // bridge が base + selfAnalysis を描画するケース（company_research の実状）。
    const both = dedupePersonalMemorySections(sections, { base: true, self_analysis: true });
    check(both.sections.length === 0, 'bridge がある section は memory を落とす');
    check(both.suppressed.sort().join(',') === 'base,self_analysis', `suppressed=${both.suppressed.join(',')}`);
    check(renderPersonalMemoryForPurpose('company_research_review', both.sections).block === '', '重複時の memory block は空');

    // bridge に自己分析が無いケース → memory が gap を埋める。
    const gap = dedupePersonalMemorySections(sections, { base: true, self_analysis: false });
    check(gap.sections.length === 1 && gap.sections[0].sectionKey === 'self_analysis', 'gap は memory が埋める');
    const block = renderPersonalMemoryForPurpose('company_research_review', gap.sections).block;
    check(block !== '' && !block.includes('大学'), 'base 由来（大学等）は block に出ない＝重複しない');

    // 実 route が dedupe を通していること（静的 guard）。
    const route = readFileSync(join(ROOT, 'app/api/career/company-research/route.ts'), 'utf8');
    check(/dedupePersonalMemorySections\(/.test(route), 'route が dedupe を通す');
    check(/base:\s*true/.test(route), 'base は常に bridge 側とみなす');
    check(/self_analysis:\s*selfAnalysisBlock !== ''/.test(route), 'self_analysis は実描画の有無で判定');
  }

  console.log('[R6] all flags OFF → 現行 production 互換');
  {
    const spy = newSpy();
    const ctx = await loadServerBaseContext('company_research_review', syncOf(BUNDLE), ctxDeps({ spy, purposes: [] }));
    check(ctx.context === null && ctx.reason === 'flag_off' && spy.loads === 0, 'server context 不使用・I/O ゼロ');
    const mem = await loadPersonalMemorySectionsForPrompt('company_research_review', syncOf(BUNDLE), pmDeps({ enabled: false }));
    check(mem.sections.length === 0 && mem.meta.read === 'skipped', 'Personal Memory 不使用・I/O ゼロ');
  }

  console.log('[D1-D3] dedupe 純関数の契約');
  {
    const P_BASE = projectSectionFromSource('base', BUNDLE)!;
    check(dedupePersonalMemorySections([], { base: true }).sections.length === 0, '空入力 → 空');
    check(dedupePersonalMemorySections(null, { base: true }).sections.length === 0, 'null → 空（never-throw）');
    check(dedupePersonalMemorySections([P_BASE.section], {}).sections.length === 1, 'presence 未指定 → 落とさない（gap を埋める）');
    check(dedupePersonalMemorySections([P_BASE.section], { base: false }).sections.length === 1, 'false → 落とさない');
    check(dedupePersonalMemorySections([P_BASE.section], { base: true }).sections.length === 0, 'true → 落とす');
  }

  console.log('[S1] 静的 guard: 両 route の canary / identity 境界');
  {
    for (const rel of ['app/api/career/consultation/route.ts', 'app/api/career/company-research/route.ts']) {
      const code = readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      // Batch 2: 共有 resolver は purpose 別 resolveContextInputs（base + cross-feature を 1 read）。
      check(/resolve\w*ContextInputs\(/.test(code), `${rel}: 共有 resolver 経由`);
      check(/profile:\s*ctx\.profile/.test(code), `${rel}: resolver 由来を prompt へ渡す`);
      // `b.profile` が残ってよいのは **resolver への引数**としてだけ（prompt へ直接渡さない）。
      const bodyProfileUses = code.match(/profile:\s*b\.profile/g)?.length ?? 0;
      const insideResolverArg = (code.match(/resolve\w*ContextInputs\(\s*\{[^}]*profile:\s*b\.profile/g) ?? []).length;
      check(
        bodyProfileUses === insideResolverArg,
        `${rel}: request body を prompt へ直接渡さない（body 参照 ${bodyProfileUses} / resolver 引数 ${insideResolverArg}）`,
      );
      check(!/serviceRole|SERVICE_ROLE/.test(code), `${rel}: service role なし`);
      check(!/b\.userId|body\.userId/.test(code), `${rel}: client 由来 userId を使わない`);
    }
    const resolver = readFileSync(join(ROOT, 'lib/careerServerContext/purposeContext.server.ts'), 'utf8');
    check(/^import 'server-only';$/m.test(resolver), "resolver は server-only");
    check(!/NODE_ENV/.test(resolver), 'default-ON / NODE_ENV bypass なし');
  }

  console.log('');
  console.log(failures === 0 ? 'career-server-context-batch1-qa: ALL PASS' : `career-server-context-batch1-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

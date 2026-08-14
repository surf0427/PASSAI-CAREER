/*
 * scripts/career-personal-memory-read-server-qa.ts
 *
 * PASSAI CAREER — Personal Memory server read path QA（dev-only・DI fake・実 Supabase 非接続）。
 *   P17-M1 で導入し、NEXT-3（server 再算出 freshness）/ NEXT-4（rebuild-on-stale）で拡張。
 *
 * loadPersonalMemorySectionsForPrompt を注入 deps（fake reader / fake source loader）で検証する。
 * 実 client / auth / DB / Supabase には一切接続しない:
 *   [1]  対象外 purpose → skipped・createReader も呼ばない（I/O ゼロ）。
 *   [2]  master OFF → skipped・createReader を呼ばない（追加 I/O ゼロ・client 生成なし）。
 *   [3]  createReader が null（env/config 無）→ disabled/skipped。
 *   [4]  未認証 / anonymous（getUserId=null）→ denied・DB read も Source read もしない。
 *   [5]  gate deny（allowlist 外）→ denied・DB read も Source read もしない。
 *   [6]  永続 read error かつ Source も読めない → allowed/error・sections 空（fail-open）。
 *   [7]  invalid / schema 不一致 row → prompt から除外。
 *   [8]  D-S2: D-R1 を復活させる production 経路が存在しない / [8b] 安全な rollback（feature OFF）。
 *   [9]  never-throw: reader が throw しても従来 prompt（sections 空）を維持。
 *   [10] meta は安全 field のみ（本文 / UUID / env を含まない構造）。
 *   [11] NEXT-3: 永続 revision が server 再算出 revision と一致 → fresh（origin='persisted'）。
 *   [12] NEXT-3: 永続 revision が不一致（Source が進んだ）→ 永続 payload を使わない。
 *   [13] NEXT-4: stale / missing → Layer 1 から request-local rebuild（origin='rebuilt'）。
 *   [14] NEXT-4: rebuild 無効時は stale を採用しない（Memory 無しへ fail-open）。
 *   [15] NEXT-3: Source read error / truncated → fresh と断定しない・rebuild もしない。
 *   [16] NEXT-3: 読む Source は purpose の section 由来のみ（不要 Source へ I/O しない）。
 *   [17] 永続 read error でも Source が読めていれば rebuild で救う（fail-open の質）。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-personal-memory-read-server-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadPersonalMemorySectionsForPrompt,
  type PersonalMemoryReadServerDeps,
  type PersonalMemoryServerReader,
} from '@/lib/careerMemory/persistence/personalMemoryReadServer.server';
import { buildPersonalMemoryReadGateConfig } from '@/lib/careerMemory/persistence/readGate';
import { computeSourceSyncRevisions } from '@/lib/careerSourceSync/revision';
import {
  parseSourceSyncSignal,
  serializeSourceSyncSignal,
} from '@/lib/careerSourceSync/signal';
import { buildPersonalMemoryServerSourceConfig } from '@/lib/careerMemory/persistence/serverSourceFlag';
import { projectSectionFromSource } from '@/lib/careerMemory/persistence/sourceProjection';
import {
  EMPTY_CAREER_SOURCE_BUNDLE,
  emptySourceStatuses,
  type CareerSourceBundle,
  type CareerSourceKind,
  type CareerSourceReadOutcome,
  type CareerSourceReadStatus,
} from '@/lib/careerSourceData/types';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

let failures = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};

const CANARY_UID = '11111111-1111-1111-1111-111111111111';
const OTHER_UID = '99999999-9999-9999-9999-999999999999';

// ── Layer 1 Source fixture（server が読む想定の原本） ──────────────────
const SOURCE_BUNDLE: CareerSourceBundle = {
  profile: {
    name: '山田太郎',
    grade: 'B3',
    graduationYear: '2027',
    preferences: [{ university: '東京大学', faculty: '工学部' }],
    targetIndustries: ['IT'],
    targetJobs: ['エンジニア'],
    strengths: ['実行力'],
  } as unknown as CareerSourceBundle['profile'],
  activity: { focusedActivities: [{ title: '長期インターン' }] } as unknown as CareerSourceBundle['activity'],
  values: {
    selections: {
      priorities: ['成長'], avoidances: [], industries: ['IT'], jobTypes: [],
      workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [],
    },
    notes: {
      priorities: '', avoidances: '', industries: '', jobTypes: '',
      workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '',
    },
    overallNote: '',
  } as unknown as CareerSourceBundle['values'],
  selfAnalysisLogs: [
    {
      id: 'sa-1',
      createdAt: '2026-07-02T00:00:00.000Z',
      userInput: '',
      result: { summary: '所感', careerDirection: 'd', strengths: ['計画性'] },
    } as unknown as CareerSelfAnalysisLog,
  ],
  esLogs: [],
  interviewResults: [],
  matchingLogs: [],
  companyResearchLogs: [],
  presentationResults: [],
  consultationThreads: [],
  gdRoomLogs: [],
};

// server 再算出の期待値（production と同じ projection を使う）。
const EXPECTED_BASE = projectSectionFromSource('base', SOURCE_BUNDLE)!;
const EXPECTED_SELF = projectSectionFromSource('self_analysis', SOURCE_BUNDLE)!;

// 永続 row（section_key / revision / payload を差し替え可能）。
const row = (over: Record<string, unknown> = {}) => ({
  section_key: 'base',
  schema_version: 1,
  source_revision: EXPECTED_BASE.sourceRevision,
  source_updated_at: EXPECTED_BASE.sourceUpdatedAt,
  generated_at: '2026-07-10T00:00:00.000Z',
  status: 'fresh',
  payload: EXPECTED_BASE.section.payload,
  ...over,
});
const selfRow = (over: Record<string, unknown> = {}) =>
  row({
    section_key: 'self_analysis',
    source_revision: EXPECTED_SELF.sourceRevision,
    source_updated_at: EXPECTED_SELF.sourceUpdatedAt,
    payload: EXPECTED_SELF.section.payload,
    ...over,
  });

type Spy = {
  createReader: number;
  getUserId: number;
  selectSections: number;
  loadSources: number;
  sourceKinds: CareerSourceKind[];
};
const newSpy = (): Spy => ({
  createReader: 0, getUserId: 0, selectSections: 0, loadSources: 0, sourceKinds: [],
});

// D-R2: 「client canonical == mirror」を証明する signal（bundle から生成 = verified 相当）。
function syncOf(bundle: CareerSourceBundle) {
  return parseSourceSyncSignal(serializeSourceSyncSignal(computeSourceSyncRevisions(bundle)));
}
const VERIFIED = () => syncOf(SOURCE_BUNDLE);

function sourceOutcome(
  bundle: CareerSourceBundle,
  status: CareerSourceReadStatus = 'ok',
  kinds?: readonly CareerSourceKind[],
): CareerSourceReadOutcome {
  const statuses = emptySourceStatuses();
  for (const k of kinds ?? (Object.keys(statuses) as CareerSourceKind[])) statuses[k] = status;
  return {
    bundle,
    meta: { outcome: status === 'error' ? 'error' : 'ok', statuses, durationMs: 0 },
  };
}

function makeDeps(opts: {
  enabled?: boolean;
  allowlist?: string;
  reader?: PersonalMemoryServerReader | null | 'throw';
  spy: Spy;
  rebuild?: boolean;
  sources?: CareerSourceReadOutcome;
}): PersonalMemoryReadServerDeps {
  const {
    enabled = true, allowlist = CANARY_UID, reader, spy,
    rebuild = true, sources,
  } = opts;
  return {
    isEnabled: () => enabled,
    loadGateConfig: () => buildPersonalMemoryReadGateConfig('true', allowlist),
    loadSourceConfig: () => ({ rebuildOnStaleEnabled: rebuild }),
    loadSources: async (kinds) => {
      spy.loadSources++;
      spy.sourceKinds = [...kinds];
      return sources ?? sourceOutcome(SOURCE_BUNDLE);
    },
    now: () => 0,
    createReader: async () => {
      spy.createReader++;
      if (reader === 'throw') throw new Error('reader boom');
      return reader === undefined ? defaultReader(spy) : reader;
    },
  };
}

function defaultReader(
  spy: Spy,
  over: Partial<PersonalMemoryServerReader> = {},
): PersonalMemoryServerReader {
  return {
    async getUserId() { spy.getUserId++; return CANARY_UID; },
    async selectSections() { spy.selectSections++; return { rows: [row()], error: null }; },
    ...over,
  };
}

const rowsReader = (spy: Spy, rows: unknown[] | null, error: unknown = null) =>
  defaultReader(spy, {
    async selectSections() { spy.selectSections++; return { rows, error }; },
  });

async function main() {
  console.log('[1] 対象外 purpose → skipped・createReader を呼ばない（I/O ゼロ）');
  {
    const spy = newSpy();
    const r = await loadPersonalMemorySectionsForPrompt('matching', VERIFIED(), makeDeps({ spy }));
    check(r.sections.length === 0 && r.meta.read === 'skipped' && r.meta.gate === 'disabled', 'matching → skipped/disabled/空');
    check(spy.createReader === 0 && spy.loadSources === 0, 'createReader / loadSources 未呼び出し');
  }

  console.log('[2] master OFF → skipped・createReader を呼ばない');
  {
    const spy = newSpy();
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ enabled: false, spy }));
    check(r.meta.read === 'skipped' && r.meta.gate === 'disabled', 'master OFF → skipped/disabled');
    check(spy.createReader === 0 && spy.loadSources === 0, 'createReader / loadSources 未呼び出し');
  }

  console.log('[3] createReader null（env/config 無）→ disabled/skipped');
  {
    const spy = newSpy();
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader: null, spy }));
    check(r.meta.gate === 'disabled' && r.sections.length === 0, 'reader null → disabled/空');
    check(spy.createReader === 1 && spy.getUserId === 0 && spy.loadSources === 0, 'createReader 1 回・getUserId / loadSources 未呼び出し');
  }

  console.log('[4] 未認証 / anonymous（getUserId=null）→ denied・read しない');
  {
    const spy = newSpy();
    const reader = defaultReader(spy, { async getUserId() { spy.getUserId++; return null; } });
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader, spy }));
    check(r.meta.gate === 'denied' && r.sections.length === 0, 'unauth → denied/空');
    check(spy.selectSections === 0 && spy.loadSources === 0, 'DB read / Source read 未呼び出し');
  }

  console.log('[5] gate deny（allowlist 外 user）→ denied・read しない');
  {
    const spy = newSpy();
    const reader = defaultReader(spy, { async getUserId() { spy.getUserId++; return OTHER_UID; } });
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ allowlist: CANARY_UID, reader, spy }));
    check(r.meta.gate === 'denied' && r.sections.length === 0, 'allowlist 外 → denied/空');
    check(spy.selectSections === 0 && spy.loadSources === 0, 'DB read / Source read 未呼び出し');
  }

  console.log('[6] 永続 read error かつ Source も読めない → allowed/error・fail-open');
  {
    const spy = newSpy();
    const reader = rowsReader(spy, null, { code: '42P01', message: 'relation does not exist' });
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader, spy, sources: sourceOutcome(EMPTY_CAREER_SOURCE_BUNDLE, 'error') }),
    );
    check(r.meta.gate === 'allowed' && r.meta.read === 'error' && r.sections.length === 0, 'read error → allowed/error/空（fail-open）');
  }

  console.log('[7] invalid / schema 不一致 row → prompt から除外');
  {
    const spy = newSpy();
    // Source read も失敗させ、rebuild で救われない純粋な「invalid row 除外」を見る。
    const reader = rowsReader(spy, [
      'GARBAGE',                                       // malformed
      row({ payload: 'not-object' }),                  // invalid payload
      row({ section_key: 'es' }),                      // 対象外 section（purpose 許可外）
      row({ schema_version: 2 }),                      // unsupported schema
    ]);
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader, spy, sources: sourceOutcome(EMPTY_CAREER_SOURCE_BUNDLE, 'error') }),
    );
    check(r.sections.length === 0, 'invalid rows → 全除外');
  }

  console.log('[8] ★ D-S2: D-R1 を復活させる production 経路が存在しない');
  {
    // (a) config builder はどんな入力でも「検証なしで永続 Memory を使う」設定を作れない。
    for (const raw of [undefined, null, '', 'true', '1', 'YES ', 'legacy', 'on', 'D-R1', 42, {}]) {
      const cfg = buildPersonalMemoryServerSourceConfig(raw);
      const keys = Object.keys(cfg).sort().join(',');
      check(keys === 'rebuildOnStaleEnabled', `config keys = ${keys}（freshness を切る key が無い）`);
    }
    // (b) rebuild を切っても「古い Memory を使う」側へは倒れない（Memory 無しになるだけ）。
    const spy = newSpy();
    const stalePayload = { ...EXPECTED_BASE.section.payload, activity: { presentSections: ['旧'], highlights: ['旧ハイライト'] } };
    const reader = rowsReader(spy, [row({ source_revision: 'v1:content:stale000', payload: stalePayload })]);
    const r = await loadPersonalMemorySectionsForPrompt(
      'company_research_review', VERIFIED(), makeDeps({ reader, spy, rebuild: false }),
    );
    check(r.sections.length === 0, 'rebuild OFF → stale を採用せず Memory 無し（degradation to less context）');
    check(!JSON.stringify(r.sections).includes('旧ハイライト'), 'stale payload が漏れない');

    // (c) Source read は常に行われる（skip する経路が無い）。
    const spy2 = newSpy();
    await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ spy: spy2 }));
    check(spy2.loadSources === 1, 'Source read を飛ばす経路が無い（常に検証する）');

    // (d) 静的 guard: production code に LEGACY_D_R1 / legacy 経路が残っていない。
    const srcFiles = [
      'lib/careerMemory/persistence/personalMemoryReadServer.server.ts',
      'lib/careerMemory/persistence/serverSourceFlag.ts',
      'lib/careerMemory/persistence/serverSourceFlagConfig.server.ts',
    ];
    for (const rel of srcFiles) {
      const code = readFileSync(join(process.cwd(), rel), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      check(!/LEGACY_D_R1/.test(code), `${rel}: LEGACY_D_R1 env を読まない`);
      check(!/resolveLegacySections|sourceFreshnessEnabled/.test(code), `${rel}: legacy 分岐が無い`);
    }
    // origin union に 'legacy' が残っていない。
    const serverSrc = readFileSync(join(process.cwd(), srcFiles[0]), 'utf8');
    check(!/'legacy'/.test(serverSrc), "PersonalMemorySectionOrigin から 'legacy' が消えている");
  }

  console.log('[8b] ★ D-S2: 安全な rollback（feature OFF）が従来挙動を保つ');
  {
    // master flag OFF = 推奨 rollback。I/O ゼロ・Memory 無し・throw なし。
    const spy = newSpy();
    const r = await loadPersonalMemorySectionsForPrompt(
      'company_research_review', VERIFIED(), makeDeps({ enabled: false, spy }),
    );
    check(r.sections.length === 0 && r.meta.read === 'skipped', 'master OFF → Memory 無しで従来 prompt');
    check(spy.createReader === 0 && spy.loadSources === 0, 'master OFF → 追加 I/O ゼロ');
    check(Object.keys(r.meta.vetoed).length === 0, 'master OFF → veto すら発生しない（純粋に無効）');
  }

  console.log('[9] never-throw: reader が throw しても従来 prompt（空）を維持');
  {
    const spy = newSpy();
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader: 'throw', spy }));
    check(r.sections.length === 0, 'throw → 空 sections（never-throw boundary）');
  }

  console.log('[10] meta 安全性: 危険 field を持たない');
  {
    const spy = newSpy();
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ spy }));
    const keys = Object.keys(r.meta).sort().join(',');
    check(
      keys === 'gate,origins,read,readDurationMs,sectionCount,sourceRead,vetoed',
      `meta keys = ${keys}`,
    );
    // D-R2: vetoed は enum のみ（section_key → 'unreadable'|'unclaimed'|'mismatch'）。
    const allowedVerdicts = new Set(['unreadable', 'unclaimed', 'mismatch']);
    check(
      Object.values(r.meta.vetoed).every((v) => allowedVerdicts.has(v as string)),
      'meta.vetoed は既知 enum のみ',
    );
    const json = JSON.stringify(r.meta);
    check(!json.includes(CANARY_UID) && !json.includes('山田太郎') && !json.includes('東京大学'), 'meta に UUID / PII / 本文が入らない');
  }

  console.log('[11] NEXT-3: 永続 revision === server 再算出 revision → fresh（persisted）');
  {
    const spy = newSpy();
    const reader = rowsReader(spy, [row(), selfRow()]);
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader, spy }));
    check(spy.loadSources === 1, 'Source read 1 回');
    check(r.meta.sourceRead === 'ok', "meta.sourceRead === 'ok'");
    check(r.sections.length === 2, `base + self の 2 section: got ${r.sections.length}`);
    check(r.meta.origins.base === 'persisted' && r.meta.origins.self_analysis === 'persisted', "origins は 'persisted'");
  }

  console.log('[12] NEXT-3: 永続 revision 不一致（Source が進んだ）→ 永続 payload を採用しない');
  {
    const spy = newSpy();
    const stalePayload = { ...EXPECTED_BASE.section.payload, activity: { presentSections: ['旧データ'], highlights: ['旧ハイライト'] } };
    const reader = rowsReader(spy, [row({ source_revision: 'v1:content:stale000', payload: stalePayload })]);
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader, spy, rebuild: false }),
    );
    check(r.sections.length === 0, 'rebuild 無効時、stale 永続 payload は prompt に載らない');
    const json = JSON.stringify(r.sections);
    check(!json.includes('旧ハイライト'), 'stale payload が漏れない');
  }

  console.log('[13] NEXT-4: stale / missing → Layer 1 から request-local rebuild');
  {
    // stale（revision 不一致）
    const spyA = newSpy();
    const readerA = rowsReader(spyA, [row({ source_revision: 'v1:content:stale000' })]);
    const a = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader: readerA, spy: spyA }));
    check(a.meta.origins.base === 'rebuilt', "stale → origin='rebuilt'");
    check(
      JSON.stringify(a.sections.find((s) => s.sectionKey === 'base')?.payload) ===
        JSON.stringify(EXPECTED_BASE.section.payload),
      'rebuilt payload は Layer 1 からの決定的 projection と一致',
    );

    // missing（行なし）
    const spyB = newSpy();
    const readerB = rowsReader(spyB, []);
    const b = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader: readerB, spy: spyB }));
    check(b.sections.length === 2 && b.meta.origins.base === 'rebuilt' && b.meta.origins.self_analysis === 'rebuilt', 'missing → 両 section を rebuild');
  }

  console.log('[14] NEXT-4: rebuild 無効 → stale を採用しない（Memory 無しへ fail-open）');
  {
    const spy = newSpy();
    const reader = rowsReader(spy, []);
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader, spy, rebuild: false }),
    );
    check(r.sections.length === 0 && r.meta.read === 'empty', 'rebuild 無効 + missing → 空');
  }

  console.log('[15] NEXT-3: Source read error / truncated → fresh と断定しない');
  {
    for (const status of ['error', 'truncated'] as const) {
      const spy = newSpy();
      // 永続 row は「本来 fresh になるはず」の正しい revision を持つ。
      const reader = rowsReader(spy, [row(), selfRow()]);
      const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader, spy, sources: sourceOutcome(SOURCE_BUNDLE, status) }),
      );
      check(r.sections.length === 0, `source=${status} → fresh と断定せず Memory 不使用`);
    }
  }

  console.log('[16] NEXT-3: 読む Source は purpose の section 由来のみ');
  {
    const spy = newSpy();
    await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ spy }));
    const kinds = [...spy.sourceKinds].sort().join(',');
    // company_research_review の許可 section = base + self_analysis
    check(kinds === 'activity,profile,self_analysis,values', `Source kinds = ${kinds}`);
    check(!spy.sourceKinds.includes('es') && !spy.sourceKinds.includes('interview'), '不要 Source（es / interview）へ I/O しない');
  }

  console.log('[17] 永続 read error でも Source が読めていれば rebuild で救う');
  {
    const spy = newSpy();
    const reader = rowsReader(spy, null, { code: '42P01', message: 'relation does not exist' });
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', VERIFIED(), makeDeps({ reader, spy }));
    check(r.meta.read === 'ok' && r.sections.length === 2, '永続 read error + Source ok → rebuild で 2 section');
    check(Object.values(r.meta.origins).every((o) => o === 'rebuilt'), "origins は全て 'rebuilt'");
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-read-server-qa: ALL PASS' : `career-personal-memory-read-server-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

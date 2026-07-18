/*
 * scripts/career-personal-memory-read-server-qa.ts
 *
 * PASSAI CAREER — P17-M1: Personal Memory server read path QA（dev-only・DI fake・実 Supabase 非接続）。
 *
 * loadPersonalMemorySectionsForPrompt を注入 deps（fake reader）で検証する。実 client / auth / DB は使わない:
 *   - 対象外 purpose → skipped・createReader も呼ばない（I/O ゼロ）。
 *   - master OFF → skipped・createReader を呼ばない（追加 I/O ゼロ・client 生成なし）。
 *   - createReader が null（env/config 無）→ disabled/skipped。
 *   - 未認証 / anonymous（getUserId=null）→ denied・selectFresh を呼ばない。
 *   - gate deny（allowlist 外）→ denied・selectFresh を呼ばない（read しない）。
 *   - selectFresh error（table 不在 / network 相当）→ allowed/error・sections 空（fail-open）。
 *   - invalid / stale / 非 fresh row → prompt から除外（readAdapter 検証）。
 *   - valid fresh row → allowed/ok・fresh section を返す。重複 section は 1 件。
 *   - never-throw: reader が throw しても従来 prompt（sections 空）を維持。
 *   - meta は安全 field のみ（本文 / UUID を含まない構造）。
 *
 * 使い方: npx tsx scripts/career-personal-memory-read-server-qa.ts
 */

import {
  loadPersonalMemorySectionsForPrompt,
  type PersonalMemoryReadServerDeps,
  type PersonalMemoryServerReader,
} from '@/lib/careerMemory/persistence/personalMemoryReadServer.server';
import { buildPersonalMemoryReadGateConfig } from '@/lib/careerMemory/persistence/readGate';

let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };

const CANARY_UID = '11111111-1111-1111-1111-111111111111';
const OTHER_UID = '99999999-9999-9999-9999-999999999999';

// readAdapter を通過する valid base payload（read-contract QA と同形）。
const BASE_PAYLOAD = {
  profile: { university: '東京大学', faculty: '工学部', grade: 'B3', graduationYear: '2027', targetIndustries: ['IT'], targetJobs: ['エンジニア'], targetCompanies: ['A社'], jobHuntingStatus: '準備中', strengths: ['実行力'], weaknesses: ['心配性'], preferredLocations: ['東京'] },
  activity: { presentSections: ['学業'], highlights: ['長期インターン'] },
  values: { priorities: ['成長'], avoidances: [], industries: ['IT'], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] },
};
const SELF_PAYLOAD = {
  meta: { feature: 'self_analysis', sourceCount: 1, latestAt: '2026-07-02', warnings: [] },
  latest: [{ createdAt: '2026-07-02', summary: '所感', careerDirection: 'd', strengths: ['計画性'], weaknesses: [], valueKeywords: [], strengthKeywords: [], recommendedIndustries: ['IT'], recommendedJobs: [], companySelectionCriteria: [], gakuchikaIdeas: ['g'], nextActions: [] }],
  longTerm: { consistentStrengths: [], industryShift: [] },
};
const freshRow = (over: Record<string, unknown> = {}) => ({
  section_key: 'base', schema_version: 1, source_revision: 'v1:content:base0001',
  source_updated_at: '2026-07-02T00:00:00.000Z', generated_at: '2026-07-10T00:00:00.000Z',
  status: 'fresh', payload: BASE_PAYLOAD, ...over,
});

type Spy = { createReader: number; getUserId: number; selectFresh: number };

function makeDeps(opts: {
  enabled?: boolean;
  allowlist?: string;
  reader?: PersonalMemoryServerReader | null | 'throw';
  spy: Spy;
}): PersonalMemoryReadServerDeps {
  const { enabled = true, allowlist = CANARY_UID, reader, spy } = opts;
  return {
    isEnabled: () => enabled,
    loadGateConfig: () => buildPersonalMemoryReadGateConfig('true', allowlist),
    now: () => 0,
    createReader: async () => {
      spy.createReader++;
      if (reader === 'throw') throw new Error('reader boom');
      return reader === undefined ? defaultReader(spy) : reader;
    },
  };
}

function defaultReader(spy: Spy, over: Partial<PersonalMemoryServerReader> = {}): PersonalMemoryServerReader {
  return {
    async getUserId() { spy.getUserId++; return CANARY_UID; },
    async selectFresh() { spy.selectFresh++; return { rows: [freshRow()], error: null }; },
    ...over,
  };
}

async function main() {
  console.log('[1] 対象外 purpose → skipped・createReader を呼ばない（I/O ゼロ）');
  {
    const spy: Spy = { createReader: 0, getUserId: 0, selectFresh: 0 };
    const r = await loadPersonalMemorySectionsForPrompt('matching', makeDeps({ spy }));
    check(r.sections.length === 0 && r.meta.read === 'skipped' && r.meta.gate === 'disabled', 'matching → skipped/disabled/空');
    check(spy.createReader === 0, 'createReader 未呼び出し（client 生成なし）');
  }

  console.log('[2] master OFF → skipped・createReader を呼ばない');
  {
    const spy: Spy = { createReader: 0, getUserId: 0, selectFresh: 0 };
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', makeDeps({ enabled: false, spy }));
    check(r.meta.read === 'skipped' && r.meta.gate === 'disabled', 'master OFF → skipped/disabled');
    check(spy.createReader === 0, 'createReader 未呼び出し');
  }

  console.log('[3] createReader null（env/config 無）→ disabled/skipped');
  {
    const spy: Spy = { createReader: 0, getUserId: 0, selectFresh: 0 };
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', makeDeps({ reader: null, spy }));
    check(r.meta.gate === 'disabled' && r.sections.length === 0, 'reader null → disabled/空');
    check(spy.createReader === 1 && spy.getUserId === 0, 'createReader 1 回・getUserId 未呼び出し');
  }

  console.log('[4] 未認証 / anonymous（getUserId=null）→ denied・selectFresh を呼ばない');
  {
    const spy: Spy = { createReader: 0, getUserId: 0, selectFresh: 0 };
    const reader = defaultReader(spy, { async getUserId() { spy.getUserId++; return null; } });
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', makeDeps({ reader, spy }));
    check(r.meta.gate === 'denied' && r.sections.length === 0, 'unauth → denied/空');
    check(spy.selectFresh === 0, 'selectFresh 未呼び出し（read しない）');
  }

  console.log('[5] gate deny（allowlist 外 user）→ denied・selectFresh を呼ばない');
  {
    const spy: Spy = { createReader: 0, getUserId: 0, selectFresh: 0 };
    const reader = defaultReader(spy, { async getUserId() { spy.getUserId++; return OTHER_UID; } });
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', makeDeps({ allowlist: CANARY_UID, reader, spy }));
    check(r.meta.gate === 'denied' && r.sections.length === 0, 'allowlist 外 → denied/空');
    check(spy.selectFresh === 0, 'selectFresh 未呼び出し');
  }

  console.log('[6] selectFresh error（table 不在 / network 相当）→ allowed/error・fail-open');
  {
    const spy: Spy = { createReader: 0, getUserId: 0, selectFresh: 0 };
    const reader = defaultReader(spy, { async selectFresh() { spy.selectFresh++; return { rows: null, error: { code: '42P01', message: 'relation does not exist' } }; } });
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', makeDeps({ reader, spy }));
    check(r.meta.gate === 'allowed' && r.meta.read === 'error' && r.sections.length === 0, 'read error → allowed/error/空（fail-open）');
  }

  console.log('[7] invalid / 非 fresh row → prompt から除外');
  {
    const spy: Spy = { createReader: 0, getUserId: 0, selectFresh: 0 };
    const reader = defaultReader(spy, { async selectFresh() {
      spy.selectFresh++;
      return { rows: [
        'GARBAGE',                                            // malformed
        freshRow({ payload: 'not-object' }),                  // invalid payload
        freshRow({ section_key: 'es', payload: BASE_PAYLOAD }), // section↔payload 不一致
        freshRow({ schema_version: 2 }),                      // unsupported schema
      ], error: null };
    } });
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', makeDeps({ reader, spy }));
    check(r.meta.gate === 'allowed' && r.meta.read === 'empty' && r.sections.length === 0, 'invalid rows → 全除外・empty');
  }

  console.log('[8] valid fresh row → allowed/ok・section を返す（重複は 1 件）');
  {
    const spy: Spy = { createReader: 0, getUserId: 0, selectFresh: 0 };
    const reader = defaultReader(spy, { async selectFresh() {
      spy.selectFresh++;
      return { rows: [
        freshRow(),
        freshRow(),                                                                    // 重複 base
        freshRow({ section_key: 'self_analysis', source_revision: 'v1:content:self01', payload: SELF_PAYLOAD }),
      ], error: null };
    } });
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', makeDeps({ reader, spy }));
    check(r.meta.gate === 'allowed' && r.meta.read === 'ok', 'valid fresh → allowed/ok');
    check(r.sections.length === 2, `section 2 件（base + self、重複 base は 1 件）: got ${r.sections.length}`);
    check(r.sections.every((s) => s.sectionKey === 'base' || s.sectionKey === 'self_analysis'), 'base/self のみ');
    check(r.meta.sectionCount === r.sections.length, 'meta.sectionCount 整合');
  }

  console.log('[9] never-throw: reader が throw しても従来 prompt（空）を維持');
  {
    const spy: Spy = { createReader: 0, getUserId: 0, selectFresh: 0 };
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', makeDeps({ reader: 'throw', spy }));
    check(r.sections.length === 0, 'throw → 空 sections（never-throw boundary）');
  }

  console.log('[10] meta 安全性: 危険 field を持たない（gate/read/sectionCount/readDurationMs のみ）');
  {
    const spy: Spy = { createReader: 0, getUserId: 0, selectFresh: 0 };
    const r = await loadPersonalMemorySectionsForPrompt('company_research_review', makeDeps({ spy }));
    const keys = Object.keys(r.meta).sort().join(',');
    check(keys === 'gate,read,readDurationMs,sectionCount', `meta keys = ${keys}`);
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-read-server-qa: ALL PASS' : `career-personal-memory-read-server-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

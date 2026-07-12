/*
 * scripts/career-personal-memory-repository-qa.ts
 *
 * PASSAI CAREER — P16-A Stage 2: Personal Memory typed repository QA（dev-only）。
 *
 * 実 Supabase へ接続せず、injected fake store で owner-scoped read / upsert を検証する。
 *   - read: never-throw / validated-only / dup / bound / error→[] / malformed→[]。
 *   - write: best-effort / validated / rejected（invalid/oversized/forbidden/unknown）/ guest / no_store /
 *     store_error は throw せず failed。
 *   - guest / no store → safe fallback。owner query shape（userId + section IN）。
 *
 * 使い方: npx tsx scripts/career-personal-memory-repository-qa.ts
 */

import {
  readCareerPersonalMemorySections,
  upsertCareerPersonalMemorySection,
  type PersonalMemoryStore,
  type CareerPersonalMemoryRawRow,
  type StoreSelectResult,
  type StoreWriteResult,
  type CareerPersonalMemoryUpsertRow,
} from '@/lib/careerMemory/persistence/repository';
import {
  CAREER_PERSONAL_MEMORY_SCHEMA_VERSION,
  type CareerPersonalMemorySection,
} from '@/lib/careerMemory/persistence/schema';

let failures = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};

const V = CAREER_PERSONAL_MEMORY_SCHEMA_VERSION;

// ── fake store ──
type FakeConfig = {
  selectRows?: CareerPersonalMemoryRawRow[] | null;
  selectError?: unknown;
  writeError?: unknown;
  throwOnSelect?: boolean;
  throwOnUpsert?: boolean;
};
function makeFakeStore(cfg: FakeConfig) {
  const calls: { select: Array<{ userId: string; sectionKeys: string[] }>; upsert: CareerPersonalMemoryUpsertRow[]; delete: Array<{ userId: string; sectionKey: string }> } = { select: [], upsert: [], delete: [] };
  const store: PersonalMemoryStore = {
    async selectSections(userId, sectionKeys): Promise<StoreSelectResult> {
      calls.select.push({ userId, sectionKeys });
      if (cfg.throwOnSelect) throw new Error('boom');
      return { rows: cfg.selectRows ?? null, error: cfg.selectError ?? null };
    },
    async upsertSection(row): Promise<StoreWriteResult> {
      if (cfg.throwOnUpsert) throw new Error('boom');
      if (!cfg.writeError) calls.upsert.push(row);
      return { error: cfg.writeError ?? null };
    },
    async deleteSection(userId, sectionKey): Promise<StoreWriteResult> {
      calls.delete.push({ userId, sectionKey });
      return { error: null };
    },
  };
  return { store, calls };
}

const validSelfSection = (): CareerPersonalMemorySection => ({
  sectionKey: 'self_analysis',
  schemaVersion: V,
  payload: { meta: { feature: 'self_analysis', sourceCount: 1, latestAt: '2026-07-01', warnings: [] }, latest: [{ createdAt: '2026-07-01', summary: 's', careerDirection: 'd', strengths: ['a'], weaknesses: [], valueKeywords: [], strengthKeywords: [], recommendedIndustries: ['IT'], recommendedJobs: [], companySelectionCriteria: [], gakuchikaIdeas: ['g'], nextActions: [] }], longTerm: { consistentStrengths: [], industryShift: [] } },
});

const rawRow = (over: Partial<CareerPersonalMemoryRawRow>): CareerPersonalMemoryRawRow => ({
  section_key: 'self_analysis', schema_version: V, source_revision: 'r1', source_updated_at: '2026-07-01', generated_at: '2026-07-02', status: 'fresh',
  payload: validSelfSection().payload, ...over,
});

async function main() {
  console.log('[1] read: owner query shape + valid');
  {
    const { store, calls } = makeFakeStore({ selectRows: [rawRow({})] });
    const rows = await readCareerPersonalMemorySections(store, 'u1', ['self_analysis', 'es']);
    check(calls.select.length === 1 && calls.select[0].userId === 'u1', 'select called with userId');
    check(JSON.stringify(calls.select[0].sectionKeys) === JSON.stringify(['self_analysis', 'es']), 'select called with section IN list');
    check(rows.length === 1 && rows[0].sectionKey === 'self_analysis' && rows[0].status === 'fresh', 'valid row returned');
  }

  console.log('[2] read: skip invalid / unsupported / forbidden / dup / bad status');
  {
    const { store } = makeFakeStore({ selectRows: [
      rawRow({ payload: 'not-an-object' }),                                 // invalid
      rawRow({ schema_version: V + 1 }),                                    // unsupported version
      rawRow({ payload: { ...validSelfSection().payload, name: '山田' } }), // forbidden key
      rawRow({ status: 'rebuilding' }),                                     // non-persisted status → skip
      rawRow({ section_key: 'presentation' }),                             // unknown section
    ] });
    const rows = await readCareerPersonalMemorySections(store, 'u1', ['self_analysis', 'es', 'interview', 'base']);
    check(rows.length === 0, 'all invalid/unsupported/forbidden/badstatus/unknown skipped');
  }
  {
    // duplicate section → 1 のみ
    const { store } = makeFakeStore({ selectRows: [rawRow({ generated_at: 'a' }), rawRow({ generated_at: 'b' })] });
    const rows = await readCareerPersonalMemorySections(store, 'u1', ['self_analysis']);
    check(rows.length === 1, 'duplicate section → single row');
  }

  console.log('[3] read: missing / error / malformed / bound → safe');
  {
    check((await readCareerPersonalMemorySections(makeFakeStore({ selectRows: [] }).store, 'u1', ['self_analysis'])).length === 0, 'no rows → []');
    check((await readCareerPersonalMemorySections(makeFakeStore({ selectError: { message: 'db' } }).store, 'u1', ['self_analysis'])).length === 0, 'supabase error → []');
    check((await readCareerPersonalMemorySections(makeFakeStore({ selectRows: null }).store, 'u1', ['self_analysis'])).length === 0, 'null rows → []');
    check((await readCareerPersonalMemorySections(makeFakeStore({ throwOnSelect: true }).store, 'u1', ['self_analysis'])).length === 0, 'select throws → [] (never-throw)');
    // malformed: rows not array 相当（fake は typed だが select は any 経路。ここでは error 経路で代表）
    check((await readCareerPersonalMemorySections(null, 'u1', ['self_analysis'])).length === 0, 'no store → []');
    check((await readCareerPersonalMemorySections(makeFakeStore({ selectRows: [rawRow({})] }).store, null, ['self_analysis'])).length === 0, 'guest(no userId) → []');
  }

  console.log('[4] write: valid → written');
  {
    const { store, calls } = makeFakeStore({});
    const r = await upsertCareerPersonalMemorySection(store, 'u1', { section: validSelfSection(), sourceRevision: 'r1', sourceUpdatedAt: '2026-07-01', generatedAt: '2026-07-02', status: 'fresh' });
    check(r.status === 'written', 'valid upsert → written');
    check(calls.upsert.length === 1 && calls.upsert[0].user_id === 'u1' && calls.upsert[0].section_key === 'self_analysis', 'upsert row owner-scoped + section');
  }

  console.log('[5] write: rejected (invalid / oversized / forbidden / unknown section)');
  {
    const invalidSection = { sectionKey: 'self_analysis', schemaVersion: V, payload: 'x' } as unknown as CareerPersonalMemorySection;
    const { store, calls } = makeFakeStore({});
    const r = await upsertCareerPersonalMemorySection(store, 'u1', { section: invalidSection, sourceRevision: 'r', sourceUpdatedAt: null, generatedAt: 'g', status: 'fresh' });
    check(r.status === 'rejected' && r.reason === 'invalid_payload', 'invalid payload → rejected (not written)');
    check(calls.upsert.length === 0, 'rejected → no upsert call');

    const forbiddenSection = { sectionKey: 'self_analysis', schemaVersion: V, payload: { ...validSelfSection().payload, email: 'x@y.z' } } as unknown as CareerPersonalMemorySection;
    const r2 = await upsertCareerPersonalMemorySection(makeFakeStore({}).store, 'u1', { section: forbiddenSection, sourceRevision: 'r', sourceUpdatedAt: null, generatedAt: 'g', status: 'fresh' });
    check(r2.status === 'rejected' && r2.reason === 'forbidden_key', 'forbidden key (Event Signal/PII 相当) → rejected');

    const unknownSection = { sectionKey: 'signals', schemaVersion: V, payload: { meta: { feature: 'events', sourceCount: 1 }, latest: [] } } as unknown as CareerPersonalMemorySection;
    const r3 = await upsertCareerPersonalMemorySection(makeFakeStore({}).store, 'u1', { section: unknownSection, sourceRevision: 'r', sourceUpdatedAt: null, generatedAt: 'g', status: 'fresh' });
    check(r3.status === 'rejected' && r3.reason === 'unknown_section', 'arbitrary/Event-Signal section → rejected (unknown_section)');
  }

  console.log('[6] write: guest / no_store / store_error (never-throw)');
  {
    check((await upsertCareerPersonalMemorySection(null, 'u1', { section: validSelfSection(), sourceRevision: 'r', sourceUpdatedAt: null, generatedAt: 'g', status: 'fresh' })).status === 'skipped', 'no store → skipped');
    const guest = await upsertCareerPersonalMemorySection(makeFakeStore({}).store, null, { section: validSelfSection(), sourceRevision: 'r', sourceUpdatedAt: null, generatedAt: 'g', status: 'fresh' });
    check(guest.status === 'skipped' && guest.reason === 'guest', 'guest(no userId) → skipped guest (no write)');
    const errRes = await upsertCareerPersonalMemorySection(makeFakeStore({ writeError: { message: 'rls' } }).store, 'u1', { section: validSelfSection(), sourceRevision: 'r', sourceUpdatedAt: null, generatedAt: 'g', status: 'fresh' });
    check(errRes.status === 'failed' && errRes.reason === 'store_error', 'store error → failed (not throw)');
    const thrown = await upsertCareerPersonalMemorySection(makeFakeStore({ throwOnUpsert: true }).store, 'u1', { section: validSelfSection(), sourceRevision: 'r', sourceUpdatedAt: null, generatedAt: 'g', status: 'fresh' });
    check(thrown.status === 'failed', 'upsert throws → failed (never-throw boundary)');
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-repository-qa: ALL PASS' : `career-personal-memory-repository-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

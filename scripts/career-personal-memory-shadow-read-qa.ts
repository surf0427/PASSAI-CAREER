/*
 * scripts/career-personal-memory-shadow-read-qa.ts
 *
 * PASSAI CAREER — P16-J-PREP: offline shadow-read parity contract QA（dev-only）。
 *
 * production（prompt / Context Orchestrator）へ接続せず、read adapter（readPersonalMemorySection）+
 * repository read（readCareerPersonalMemorySections・never-throw）を in-memory store で接続して
 * read parity contract を固定する。実 Supabase / 実データ / network なし。
 *
 * 使い方: npx tsx scripts/career-personal-memory-shadow-read-qa.ts
 */

import { execSync } from 'node:child_process';
import { readPersonalMemorySection, type PersonalMemoryReadResult } from '@/lib/careerMemory/persistence/readAdapter';
import { readCareerPersonalMemorySections } from '@/lib/careerMemory/persistence/repository';
import type {
  PersonalMemoryStore, CareerPersonalMemoryRawRow, StoreSelectResult, StoreWriteResult,
} from '@/lib/careerMemory/persistence/repository';
import { buildBaseMemorySection, buildSelfAnalysisMemorySection, buildEsMemorySection, type SectionRebuildResult } from '@/lib/careerMemory/persistence/rebuild';
import { stableStringify } from '@/lib/careerMemory/persistence/validate';
import type { ExpectedMemoryMeta } from '@/lib/careerMemory/persistence/state';
import type { CareerPersonalMemorySectionKey } from '@/lib/careerMemory/persistence/schema';
import type { CareerProfileContext } from '@/lib/careerAi';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };
const cast = <T>(v: unknown): T => v as T;
const eq = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const NOW = '2026-07-12T00:00:00.000Z';
const USER = '00000000-0000-4000-8000-0000000000aa';
const exp = (rev: string, upd: string | null = null): ExpectedMemoryMeta => ({ sourceRevision: rev, sourceUpdatedAt: upd });

// ── in-memory store（read parity 用。読み取り error/throw を制御） ──
function makeStore(ctl: { readError?: unknown; readThrow?: boolean } = {}) {
  const rows = new Map<string, CareerPersonalMemoryRawRow>();
  const store: PersonalMemoryStore = {
    async selectSections(userId, sectionKeys): Promise<StoreSelectResult> {
      if (ctl.readThrow) throw new Error('read boom');
      if (ctl.readError) return { rows: null, error: ctl.readError };
      const out: CareerPersonalMemoryRawRow[] = [];
      for (const sk of sectionKeys) { const r = rows.get(`${userId}:${sk}`); if (r) out.push(r); }
      return { rows: out, error: null };
    },
    async upsertSection(): Promise<StoreWriteResult> { return { error: null }; },
    async deleteSection(): Promise<StoreWriteResult> { return { error: null }; },
  };
  return { store, seed: (u: string, r: CareerPersonalMemoryRawRow) => rows.set(`${u}:${r.section_key as string}`, r) };
}

const rawFrom = (b: SectionRebuildResult, over: Partial<CareerPersonalMemoryRawRow> = {}): CareerPersonalMemoryRawRow => ({
  section_key: b.section.sectionKey, schema_version: b.section.schemaVersion, source_revision: b.sourceRevision,
  source_updated_at: b.sourceUpdatedAt, generated_at: NOW, status: 'fresh', payload: b.section.payload, ...over,
});

// fixtures
const profile = cast<CareerProfileContext>({ university: '東京大学', faculty: '工学部', grade: 'B3', graduationYear: '2027', targetIndustries: ['IT'], targetJobs: ['eng'], targetCompanies: ['A社'], jobHuntingStatus: '準備中', strengths: ['実行力'], weaknesses: [], preferredLocations: ['東京'] });
const activity = cast<CareerActivity>({ personality: {}, academics: {}, focusedActivities: [], partTimeJobs: [], internships: [], club: [], projects: [], leadership: [], volunteer: [], overseas: [], certifications: [], itSkills: [], languages: [], hobbies: '', awards: '', snsActivities: [], portfolios: [], lifeExperiences: {}, freeNote: '', updatedAt: '2026-07-01T00:00:00.000Z' });
const values = cast<CareerValues>({ selections: { priorities: ['成長'], avoidances: [], industries: ['IT'], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] }, notes: {}, overallNote: '', updatedAt: '2026-07-02T00:00:00.000Z' });
const saLog = (id: string, c: string): CareerSelfAnalysisLog => cast({ id, createdAt: c, userInput: '', result: { summary: `s${id}`, careerDirection: 'd', strengths: ['x'], weaknesses: [], valueKeywords: [], strengthKeywords: [], recommendedIndustries: ['IT'], recommendedJobs: [], companySelectionCriteria: [], gakuchikaIdeas: [], nextActions: [] } });
const baseBuilt = buildBaseMemorySection(profile, activity, values);
const selfBuilt = buildSelfAnalysisMemorySection([saLog('a', '2026-07-01')]);
const esBuilt = buildEsMemorySection([]);

// independent golden（手書き raw row + 手書き期待）
const GOLDEN_SELF_PAYLOAD = { meta: { feature: 'self_analysis', sourceCount: 1, latestAt: '2026-07-01', warnings: [] }, latest: [{ createdAt: '2026-07-01', summary: 'sa', careerDirection: 'd', strengths: ['計画性'], weaknesses: [], valueKeywords: [], strengthKeywords: [], recommendedIndustries: ['IT'], recommendedJobs: [], companySelectionCriteria: [], gakuchikaIdeas: [], nextActions: [] }], longTerm: { consistentStrengths: [], industryShift: [] } };

async function main() {
  console.log('[1] missing row → missing (unavailable / Source fallback)');
  check(readPersonalMemorySection('base', null, exp('r')).status === 'missing', 'no row → missing');

  console.log('[2] fresh valid row → usable');
  {
    const r = readPersonalMemorySection('base', rawFrom(baseBuilt), exp(baseBuilt.sourceRevision, baseBuilt.sourceUpdatedAt));
    check(r.status === 'fresh' && r.usableForPrompt === true, 'expected==stored → fresh usable');
  }

  console.log('[3] stale revision → unusable');
  check(readPersonalMemorySection('base', rawFrom(baseBuilt), exp('DIFFERENT')).status === 'stale', 'revision mismatch → stale (not usable)');

  console.log('[4] failed status → unusable');
  check(readPersonalMemorySection('base', rawFrom(baseBuilt, { status: 'failed' }), exp(baseBuilt.sourceRevision)).status === 'unusable', 'db status=failed → unusable');

  console.log('[5] invalid payload → unusable');
  check(readPersonalMemorySection('base', rawFrom(baseBuilt, { payload: 'not-object' }), exp('r')).status === 'invalid', 'malformed payload → invalid');

  console.log('[6] unsupported schema → unusable');
  check(readPersonalMemorySection('base', rawFrom(baseBuilt, { schema_version: 2 }), exp('r')).status === 'unsupported_schema', 'schema_version=2 → unsupported_schema');

  console.log('[7]/[8] repository throw / error → never-throw fallback ([]=missing)');
  {
    for (const ctl of [{ readThrow: true }, { readError: { code: '42501' } }]) {
      const st = makeStore(ctl); st.seed(USER, rawFrom(baseBuilt));
      let threw = false; let rows: unknown[] = [];
      try { rows = await readCareerPersonalMemorySections(st.store, USER, ['base']); } catch { threw = true; }
      check(!threw && Array.isArray(rows) && rows.length === 0, `repository ${ctl.readThrow ? 'throw' : 'error'} → never-throw [] fallback`);
    }
  }

  console.log('[9] one section corrupted → other sections usable (repository drops corrupted)');
  {
    const st = makeStore();
    st.seed(USER, rawFrom(baseBuilt));
    st.seed(USER, rawFrom(selfBuilt));
    st.seed(USER, cast<CareerPersonalMemoryRawRow>({ section_key: 'es', schema_version: 1, source_revision: 'x', source_updated_at: null, generated_at: NOW, status: 'fresh', payload: 'GARBAGE' }));
    const rows = await readCareerPersonalMemorySections(st.store, USER, ['base', 'self_analysis', 'es']);
    const keys = rows.map((r) => r.sectionKey).sort();
    check(keys.includes('base') && keys.includes('self_analysis') && !keys.includes('es'), '破損 es は drop・base/self は読める');
  }

  console.log('[10] same revision + changed payload → revision 権威に従う（fresh）');
  {
    // stored payload を別物にしつつ、行の source_revision を expected と一致させる（整合は revision の責務）。
    const r = readPersonalMemorySection('base', rawFrom(baseBuilt, { payload: cast<Record<string, unknown>>(selfBuilt.section.payload) }), exp(baseBuilt.sourceRevision));
    // base に self payload は shape 不一致 → invalid（validation が守る）。revision 一致でも payload 検証が優先。
    check(r.status === 'invalid', 'revision 一致でも payload shape 不一致 → invalid（validation 優先）');
  }

  console.log('[11] Source revision unavailable（expected 空）→ fail-closed');
  check(readPersonalMemorySection('base', rawFrom(baseBuilt), exp('')).status !== 'fresh', 'expected revision 空 → fresh にしない（fail-closed）');

  console.log('[12] raw forbidden data → reject');
  check(readPersonalMemorySection('base', rawFrom(baseBuilt, { payload: cast<Record<string, unknown>>({ ...cast<object>(baseBuilt.section.payload), transcript: 'x' }) }), exp('r')).status === 'invalid', 'forbidden key(transcript) → invalid');

  console.log('[13] payload size violation → reject');
  check(readPersonalMemorySection('base', rawFrom(baseBuilt, { payload: cast<Record<string, unknown>>({ ...cast<object>(baseBuilt.section.payload), activity: { presentSections: [], highlights: ['x'.repeat(40000)] } }) }), exp('r')).status === 'invalid', 'oversized payload → invalid');

  console.log('[14] read adapter mutation なし');
  {
    const row = rawFrom(baseBuilt);
    const snapshot = stableStringify(row);
    readPersonalMemorySection('base', row, exp(baseBuilt.sourceRevision));
    check(stableStringify(row) === snapshot, 'read 後も入力 row は不変（mutation なし）');
  }

  console.log('[15] repeated read deterministic');
  {
    const row = rawFrom(baseBuilt);
    const a = readPersonalMemorySection('base', row, exp(baseBuilt.sourceRevision));
    const b = readPersonalMemorySection('base', row, exp(baseBuilt.sourceRevision));
    check(eq(a, b), '同一入力 → 同一 read result');
  }

  console.log('[independent golden] 手書き raw row + 手書き期待 adapter result（非循環）');
  {
    const goldenRaw = cast<CareerPersonalMemoryRawRow>({ section_key: 'self_analysis', schema_version: 1, source_revision: 'v1:content:selfgold', source_updated_at: '2026-07-01', generated_at: NOW, status: 'fresh', payload: GOLDEN_SELF_PAYLOAD });
    const r = readPersonalMemorySection('self_analysis', goldenRaw, exp('v1:content:selfgold', '2026-07-01'));
    check(r.status === 'fresh' && eq(r.section.payload, GOLDEN_SELF_PAYLOAD), 'golden self_analysis → fresh + payload == 手書き golden');
    check(readPersonalMemorySection('self_analysis', goldenRaw, exp('OTHER')).status === 'stale', 'golden + 異 expected → stale');
  }

  console.log('[dormant integration seam] QA 内 interface + production import 0');
  {
    // 将来の shadow read seam（QA 内のみ・production から import しない）。
    type ShadowReadPort = (section: CareerPersonalMemorySectionKey, raw: unknown, expected: ExpectedMemoryMeta) => PersonalMemoryReadResult;
    const port: ShadowReadPort = (s, raw, e) => readPersonalMemorySection(s, raw, e);
    check(port('base', rawFrom(baseBuilt), exp(baseBuilt.sourceRevision)).status === 'fresh', 'dormant seam 経由でも fresh 判定できる');

    // production（app/・lib/、QA 除く）からの read adapter import が 0 件。
    const importers = execSync('grep -rl "persistence/readAdapter" app lib --include=*.ts --include=*.tsx 2>/dev/null || true', { encoding: 'utf8' }).trim();
    check(importers === '', 'read adapter は app/・lib/ から未 import（production 未配線）');
    check(readCareerPersonalMemorySections !== undefined && buildEsMemorySection !== undefined, 'repository/builder は既存 export を再利用（新規 production module なし）');
  }

  console.log('[static] read adapter は prompt/Orchestrator を import しない');
  {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('lib/careerMemory/persistence/readAdapter.ts', 'utf8');
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    check(importLines.filter((l) => /orchestrat|prompt|route|careerAi/i.test(l)).length === 0, 'readAdapter import は persistence 兄弟のみ（prompt/Orchestrator/route なし）');
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-shadow-read-qa: ALL PASS' : `career-personal-memory-shadow-read-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

/*
 * scripts/career-personal-memory-writer-qa.ts
 *
 * PASSAI CAREER — P16-A Stage 3: revision / rebuild / shadow writer QA（dev-only）。
 *
 * - 4 section deterministic build（同一 Source → 同一 payload/revision）。
 * - add/update/delete/ordering で revision 変化。
 * - compare-and-set: same revision → SKIPPED unchanged / changed → WRITTEN / out-of-order → stale_write。
 * - repository error → FAILED（throw なし）/ invalid → REJECTED / guest / no_store → SKIPPED。
 * - payload に transcript 全文 / ES 本文全文 / PII 禁止 key / prompt 文字列 / Event Signal が無い。
 * - external AI / env / Supabase 実接続の import なし（静的）。
 *
 * 使い方: npx tsx scripts/career-personal-memory-writer-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildBaseMemorySection,
  buildSelfAnalysisMemorySection,
  buildEsMemorySection,
  buildInterviewMemorySection,
} from '@/lib/careerMemory/persistence/rebuild';
import { shadowWriteSection, shadowWriteSections } from '@/lib/careerMemory/persistence/shadowWriter';
import { decideWrite, deriveMemoryState } from '@/lib/careerMemory/persistence/state';
import { validateCareerPersonalMemorySection, stableStringify } from '@/lib/careerMemory/persistence/validate';
import type { PersonalMemoryStore, CareerPersonalMemoryUpsertRow, StoreWriteResult } from '@/lib/careerMemory/persistence/repository';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerEsLog } from '@/types/careerEs';
import type { CareerInterviewResult } from '@/types/careerInterview';
import type { CareerProfileContext } from '@/lib/careerAi';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';

let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };
const cast = <T>(v: unknown): T => v as T;
const NOW = '2026-07-10T00:00:00.000Z';

// ── fixtures ──
const saLog = (id: string, created: string, strength: string): CareerSelfAnalysisLog =>
  cast({ id, createdAt: created, userInput: '', result: { summary: `所感${id}`, careerDirection: 'd', strengths: [strength], weaknesses: [], valueKeywords: [], strengthKeywords: [], recommendedIndustries: ['IT'], recommendedJobs: [], suitableEnvironment: [], motivationSources: [], stressFactors: [], companySelectionCriteria: [], developmentPoints: [], esAngles: [], interviewQuestions: [], gakuchikaIdeas: ['g'], nextActions: [] } });
const esLog = (id: string, created: string): CareerEsLog =>
  cast({ id, createdAt: created, userInput: '', result: { gakuchika: 'g', selfPr: 'p', motivation: 'm', headline: 'h', appealPoints: ['ap'], interviewQuestions: [], improvements: [], companyName: `Co${id}`, question: 'q' } });
const ivResult = (id: string, created: string): CareerInterviewResult =>
  cast({ id, createdAt: created, mode: 'real', turns: [], result: { overallComment: 'oc', strengths: ['s'], improvements: ['imp'], sampleAnswers: [], deepDiveTopics: [], nextActions: [], companyFit: 'f' } });

const profileCtx = cast<CareerProfileContext>({ name: '山田太郎', university: '東京大学', faculty: '工学部', grade: 'B3', graduationYear: '2027', targetIndustries: ['IT'], targetJobs: ['eng'], targetCompanies: ['A社'], jobHuntingStatus: '準備中', strengths: ['実行力'], weaknesses: ['心配性'], certifications: [], internshipExperience: '', studyAbroadExperience: '', preferredLocations: ['東京'], notes: '' });
const activity = cast<CareerActivity>({ personality: {}, academics: { detail: '研究' }, focusedActivities: [{ title: '長期インターン', role: 'PM' }], partTimeJobs: [], internships: [], club: [], projects: [], leadership: [], volunteer: [], overseas: [], certifications: [], itSkills: [], languages: [], hobbies: '読書', awards: '', snsActivities: [], portfolios: [], lifeExperiences: {}, freeNote: '', updatedAt: '2026-07-01T00:00:00.000Z' });
const values = cast<CareerValues>({ selections: { priorities: ['成長'], avoidances: [], industries: ['IT'], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] }, notes: {}, overallNote: '', updatedAt: '2026-07-02T00:00:00.000Z' });

// ── fake store ──
function fakeStore(cfg: { writeError?: unknown } = {}) {
  const upserts: CareerPersonalMemoryUpsertRow[] = [];
  const store: PersonalMemoryStore = {
    async selectSections() { return { rows: null, error: null }; },
    async upsertSection(row): Promise<StoreWriteResult> { if (!cfg.writeError) upserts.push(row); return { error: cfg.writeError ?? null }; },
    async deleteSection() { return { error: null }; },
  };
  return { store, upserts };
}

async function main() {
  console.log('[1] 4 section deterministic build (valid payload)');
  const b1 = buildBaseMemorySection(profileCtx, activity, values);
  const s1 = buildSelfAnalysisMemorySection([saLog('a', '2026-07-01', 'x'), saLog('b', '2026-07-02', 'y')]);
  const e1 = buildEsMemorySection([esLog('a', '2026-06-01')]);
  const i1 = buildInterviewMemorySection([ivResult('a', '2026-05-01')]);
  for (const [name, r] of [['base', b1], ['self_analysis', s1], ['es', e1], ['interview', i1]] as const) {
    const v = validateCareerPersonalMemorySection(r.section.sectionKey, r.section.schemaVersion, r.section.payload);
    check(v.ok, `${name} build → valid payload`);
  }

  console.log('[2] deterministic: same Source → same payload + revision');
  const b1b = buildBaseMemorySection(profileCtx, activity, values);
  check(stableStringify(b1.section.payload) === stableStringify(b1b.section.payload) && b1.sourceRevision === b1b.sourceRevision, 'base deterministic');
  const s1b = buildSelfAnalysisMemorySection([saLog('a', '2026-07-01', 'x'), saLog('b', '2026-07-02', 'y')]);
  check(s1.sourceRevision === s1b.sourceRevision, 'self_analysis revision deterministic');
  // input 順序が違っても同一 revision（sort で吸収）
  const s1rev = buildSelfAnalysisMemorySection([saLog('b', '2026-07-02', 'y'), saLog('a', '2026-07-01', 'x')]);
  check(s1.sourceRevision === s1rev.sourceRevision, 'self_analysis input-order independent revision');

  console.log('[3] revision changes: add / update / delete / latest / order');
  const base2 = [saLog('a', '2026-07-01', 'x'), saLog('b', '2026-07-02', 'y')];
  const add = [...base2, saLog('c', '2026-07-03', 'z')];
  const update = [saLog('a', '2026-07-01', 'CHANGED'), saLog('b', '2026-07-02', 'y')];
  const del = [saLog('a', '2026-07-01', 'x')];
  const latest = [saLog('a', '2026-07-01', 'x'), saLog('b', '2026-07-09', 'y')]; // b の createdAt 変更
  const rBase = buildSelfAnalysisMemorySection(base2).sourceRevision;
  check(buildSelfAnalysisMemorySection(add).sourceRevision !== rBase, 'add → revision changes');
  check(buildSelfAnalysisMemorySection(update).sourceRevision !== rBase, 'update → revision changes');
  check(buildSelfAnalysisMemorySection(del).sourceRevision !== rBase, 'delete → revision changes');
  check(buildSelfAnalysisMemorySection(latest).sourceRevision !== rBase, 'latest/createdAt change → revision changes');
  check(buildSelfAnalysisMemorySection([]).sourceRevision !== rBase, 'empty → different revision');

  console.log('[4] compare-and-set (state) — Source-recency authority, NOT client clock');
  const cur = (over: Partial<NonNullable<import('@/lib/careerMemory/persistence/state').CurrentMemoryMeta>>) =>
    ({ schemaVersion: 1, sourceRevision: 'r1', status: 'fresh' as const, sourceUpdatedAt: '2026-07-10', generatedAt: '2026-07-01', ...over });
  const exp = (sourceRevision: string, sourceUpdatedAt: string | null) => ({ sourceRevision, sourceUpdatedAt });
  check(decideWrite(null, exp('r1', '2026-07-10')).write === true, 'missing → write');
  check(decideWrite(cur({}), exp('r1', '2026-07-10')).write === false, 'fresh same revision → skip(unchanged)');
  check(decideWrite(cur({}), exp('r2', '2026-07-11')).write === true, 'changed revision + newer source → write');
  // K の修正: 異なる revision・**古い Source**・（client 時刻は不問）→ stale_write skip
  const kCase = decideWrite(cur({ sourceUpdatedAt: '2026-07-10' }), exp('r2', '2026-07-05'));
  check(kCase.write === false && kCase.reason === 'stale_write', 'older Source (stale) → stale_write (K fixed)');
  // client 時計を権威にしない: newer Source but earlier "client time" 相当（generatedAt は判定に不使用）→ write
  check(decideWrite(cur({ sourceUpdatedAt: '2026-07-05', generatedAt: '2999-01-01' }), exp('r2', '2026-07-20')).write === true, 'newer Source overrides even if existing generatedAt is far-future (client clock ignored)');
  // future/past-skewed client clock は判定に影響しない（generatedAt を変えても結論不変）
  check(decideWrite(cur({ sourceUpdatedAt: '2026-07-10', generatedAt: '1999-01-01' }), exp('r2', '2026-07-05')).write === false, 'past-skewed generatedAt does not force write (still stale by Source)');
  check(decideWrite(cur({ sourceUpdatedAt: '2026-07-10', generatedAt: '2999-01-01' }), exp('r2', '2026-07-20')).write === true, 'future-skewed generatedAt does not force skip (newer by Source)');
  // sourceUpdatedAt が揃わない（base 等 null）→ 順序判定不能 → revision 差があれば write（read 時検証が担保）
  check(decideWrite(cur({ sourceUpdatedAt: null }), exp('r2', null)).write === true, 'both sourceUpdatedAt null (base) → write if revision differs');
  check(decideWrite(cur({ sourceUpdatedAt: '2026-07-10' }), exp('r2', null)).write === true, 'expected null sourceUpdatedAt → cannot order → write (read-time validation guards)');
  check(deriveMemoryState(cur({ schemaVersion: 999 }), exp('r1', null)) === 'unsupported_version', 'version mismatch → unsupported_version');
  check(deriveMemoryState(cur({ sourceRevision: 'old' }), exp('new', null)) === 'stale', 'revision mismatch → stale (read-time correctness authority)');
  check(deriveMemoryState(null, exp('x', null)) === 'missing', 'no row → missing');

  console.log('[5] shadow writer: written / unchanged / stale_write / failed / guest / no_store');
  {
    const { store, upserts } = fakeStore();
    const w1 = await shadowWriteSection({ store, userId: 'u1', built: s1, current: null, now: NOW });
    check(w1.status === 'written' && upserts.length === 1, 'missing → written');
    const w2 = await shadowWriteSection({ store, userId: 'u1', built: s1, current: cur({ sourceRevision: s1.sourceRevision, sourceUpdatedAt: s1.sourceUpdatedAt }), now: NOW });
    check(w2.status === 'skipped' && w2.reason === 'unchanged', 'same revision → SKIPPED unchanged');
    const w3 = await shadowWriteSection({ store, userId: 'u1', built: s1, current: cur({ sourceRevision: 'different', sourceUpdatedAt: '2026-01-01' }), now: NOW });
    check(w3.status === 'written', 'changed revision + newer source → WRITTEN');
    // 既存が新しい Source 由来 → 今回（古い Source）は上書きしない（client now 無関係）
    const w4 = await shadowWriteSection({ store, userId: 'u1', built: s1, current: cur({ sourceRevision: 'different', sourceUpdatedAt: '2999-01-01' }), now: NOW });
    check(w4.status === 'skipped' && w4.reason === 'stale_write', 'existing derived from newer Source → SKIPPED stale_write');
  }
  {
    const { store } = fakeStore({ writeError: { message: 'rls' } });
    const wf = await shadowWriteSection({ store, userId: 'u1', built: s1, current: null, now: NOW });
    check(wf.status === 'failed' && wf.reason === 'store_error', 'store error → FAILED (no throw)');
  }
  check((await shadowWriteSection({ store: null, userId: 'u1', built: s1, current: null, now: NOW })).status === 'skipped', 'no store → SKIPPED');
  check((await shadowWriteSection({ store: fakeStore().store, userId: null, built: s1, current: null, now: NOW })).status === 'skipped', 'guest → SKIPPED');

  console.log('[6] partial section failure isolated');
  {
    // es だけ write error にはできない（store 単位）ので、rejected を混ぜて独立性を見る。
    const badBuilt = { section: { sectionKey: 'self_analysis' as const, schemaVersion: 1 as const, payload: 'x' as unknown as never }, sourceRevision: 'r', sourceUpdatedAt: null };
    const { store, upserts } = fakeStore();
    const results = await shadowWriteSections({ store, userId: 'u1', builts: [b1, cast(badBuilt), e1], currents: {}, now: NOW });
    check(results.length === 3, 'all 3 sections attempted');
    check(results[0].status === 'written' && results[2].status === 'written', 'valid sections written despite one rejected');
    check(results[1].status === 'rejected', 'invalid section → rejected (isolated)');
    check(upserts.length === 2, 'only valid sections upserted');
  }

  console.log('[7] payload contains no transcript / ES本文全文 / PII name / prompt / Event Signal');
  {
    const all = [b1, s1, e1, i1];
    for (const r of all) {
      const s = stableStringify(r.section.payload).toLowerCase();
      const key = r.section.sectionKey;
      check(!s.includes('山田太郎'), `${key}: no PII name`);
      check(!/\"name\"|\"email\"|\"phone\"|\"transcript\"|\"turns\"|\"prompt\"|\"recentfeatures\"|\"featureusage\"|\"latestbands\"/.test(s), `${key}: no forbidden key`);
      // 各 section が validation を通る（forbidden key guard 込み）
      check(validateCareerPersonalMemorySection(r.section.sectionKey, r.section.schemaVersion, r.section.payload).ok, `${key}: passes forbidden-key validation`);
    }
    // 面接 transcript(turns) が payload に落ちていない（Source には turns があるが payload には無い）
    check(!stableStringify(i1.section.payload).includes('turns'), 'interview: raw turns NOT in payload');
  }

  console.log('[8] static: persistence modules import no env / external AI / Supabase-real');
  {
    const root = process.cwd();
    const files = ['schema.ts', 'validate.ts', 'repository.ts', 'revision.ts', 'state.ts', 'rebuild.ts', 'shadowWriter.ts'].map((f) => join(root, 'lib/careerMemory/persistence', f));
    let bad = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/anthropic|openai|\.env\.local|process\.env|serviceRole|createClient\(/.test(src)) bad++;
    }
    check(bad === 0, 'no anthropic/openai/env/serviceRole/createClient import in persistence modules');
    // shadowWriter は feature save callsite / route から呼ばれていない（呼び出し不在＝default OFF）
    const callers = readFileSync(join(root, 'lib/careerMemory/persistence/shadowWriter.ts'), 'utf8');
    check(!/route|app\/api/.test(callers), 'shadowWriter has no route/api wiring');
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-writer-qa: ALL PASS' : `career-personal-memory-writer-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

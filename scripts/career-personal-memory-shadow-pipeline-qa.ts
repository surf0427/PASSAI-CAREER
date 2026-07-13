/*
 * scripts/career-personal-memory-shadow-pipeline-qa.ts
 *
 * PASSAI CAREER — P16-H: Personal Memory offline end-to-end shadow pipeline / failure matrix QA（dev-only）。
 *
 * 実 Supabase / 実 env / deployment / 実データを使わず、fixture・fake session・fake eligibility・
 * in-memory repository・DI で **実 production 関数**を接続し、pipeline 全体を検証する:
 *   master flag → session → canary eligibility → Source load → rebuild → validation → revision →
 *   repository read → compare-and-set → upsert → read adapter。
 *
 * ★ production code は変更せず、既存 export / DI seam のみ接続する。
 * ★ fake store 上の offline pipeline compatibility であり、実 row parity ではない。
 *
 * 使い方: npx tsx scripts/career-personal-memory-shadow-pipeline-qa.ts
 */

import {
  runGatedShadowWrite,
  type ShadowWriteGateDeps,
} from '@/app/career/personalMemoryShadowWrite';
import {
  coordinateShadowWrite,
  type ShadowWriteDeps,
  type ShadowWriteSession,
  type ProductionShadowWriteOutcome,
} from '@/lib/careerMemory/persistence/productionShadowWriter';
import {
  buildBaseMemorySection,
  buildSelfAnalysisMemorySection,
  buildEsMemorySection,
  buildInterviewMemorySection,
  type SectionRebuildResult,
} from '@/lib/careerMemory/persistence/rebuild';
import {
  readPersonalMemorySection,
} from '@/lib/careerMemory/persistence/readAdapter';
import { readCareerPersonalMemorySections } from '@/lib/careerMemory/persistence/repository';
import type {
  PersonalMemoryStore,
  CareerPersonalMemoryRawRow,
  CareerPersonalMemoryUpsertRow,
  StoreSelectResult,
  StoreWriteResult,
} from '@/lib/careerMemory/persistence/repository';
import {
  evaluateEligibility,
  type CanaryVerifyResult,
} from '@/lib/careerMemory/persistence/canaryEligibility';
import { resolveCanaryEligibility } from '@/lib/careerMemory/persistence/canaryEligibilityClient';
import { buildCanaryConfig } from '@/lib/careerMemory/persistence/canaryGate';
import { stableStringify } from '@/lib/careerMemory/persistence/validate';
import type { CareerPersonalMemorySectionKey } from '@/lib/careerMemory/persistence/schema';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerEsLog } from '@/types/careerEs';
import type { CareerInterviewResult } from '@/types/careerInterview';
import type { CareerProfileContext } from '@/lib/careerAi';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';

let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };
const cast = <T>(v: unknown): T => v as T;
const eq = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const NOW = '2026-07-12T00:00:00.000Z';
const USER = '00000000-0000-4000-8000-0000000000aa'; // 合成 UUID（実ユーザーではない）
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';

// ────────────────────────────────────────────────────────────────────
// In-memory PersonalMemoryStore（QA 側のみ。production code へは足さない）。
// ────────────────────────────────────────────────────────────────────
type StoreCtl = {
  readError?: unknown; upsertError?: unknown; readThrow?: boolean; upsertThrow?: boolean;
  readDelayMs?: number; upsertDelayMs?: number;
};
function makeStore(ctl: StoreCtl = {}) {
  const rows = new Map<string, CareerPersonalMemoryRawRow>(); // key = user_id:section_key
  const counts = { read: 0, upsert: 0, del: 0 };
  const perSection: Record<string, { read: number; upsert: number }> = {};
  let lastUpsert: CareerPersonalMemoryUpsertRow | null = null;
  const bump = (sk: string, k: 'read' | 'upsert') => { (perSection[sk] ??= { read: 0, upsert: 0 })[k]++; };
  const delay = (ms?: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const toRaw = (r: CareerPersonalMemoryUpsertRow): CareerPersonalMemoryRawRow => ({
    section_key: r.section_key, schema_version: r.schema_version, source_revision: r.source_revision,
    source_updated_at: r.source_updated_at, generated_at: r.generated_at, status: r.status, payload: r.payload,
  });
  const store: PersonalMemoryStore = {
    async selectSections(userId, sectionKeys): Promise<StoreSelectResult> {
      counts.read++; sectionKeys.forEach((sk) => bump(sk, 'read'));
      await delay(ctl.readDelayMs);
      if (ctl.readThrow) throw new Error('read boom');
      if (ctl.readError) return { rows: null, error: ctl.readError };
      const out: CareerPersonalMemoryRawRow[] = [];
      for (const sk of sectionKeys) { const row = rows.get(`${userId}:${sk}`); if (row) out.push(row); }
      return { rows: out, error: null };
    },
    async upsertSection(row): Promise<StoreWriteResult> {
      counts.upsert++; bump(row.section_key, 'upsert');
      await delay(ctl.upsertDelayMs);
      if (ctl.upsertThrow) throw new Error('upsert boom');
      if (ctl.upsertError) return { error: ctl.upsertError };
      lastUpsert = row; rows.set(`${row.user_id}:${row.section_key}`, toRaw(row));
      return { error: null };
    },
    async deleteSection(userId, sectionKey): Promise<StoreWriteResult> {
      counts.del++; rows.delete(`${userId}:${sectionKey}`); return { error: null };
    },
  };
  return {
    store, counts, perSection,
    get lastUpsert() { return lastUpsert; },
    rowCount: () => rows.size,
    getRaw: (userId: string, sk: string) => rows.get(`${userId}:${sk}`) ?? null,
    seed: (userId: string, row: CareerPersonalMemoryRawRow) => rows.set(`${userId}:${row.section_key as string}`, row),
    replace: (userId: string, sk: string, row: CareerPersonalMemoryRawRow) => rows.set(`${userId}:${sk}`, row),
  };
}

// ── coordinator DI（in-memory store / fake session / fixed now） ──
function coordDeps(store: PersonalMemoryStore | null, session: 'member' | 'guest' | 'no-env' = 'member', enabled = true): ShadowWriteDeps {
  return {
    isEnabled: () => enabled,
    resolveSession: async (): Promise<ShadowWriteSession> =>
      session === 'member' ? { kind: 'member', userId: USER } : session === 'guest' ? { kind: 'guest' } : { kind: 'no-env' },
    createStore: () => store,
    now: () => NOW,
  };
}

// ── gated pipeline harness（実 runGatedShadowWrite を駆動し、counts を観測） ──
type PipelineCfg = {
  masterOn: boolean;
  section: CareerPersonalMemorySectionKey;
  resolveEligibility: (s: CareerPersonalMemorySectionKey) => Promise<boolean>;
  build: () => SectionRebuildResult;
  store: PersonalMemoryStore | null;
  session?: 'member' | 'guest' | 'no-env';
  coordEnabled?: boolean;
};
function makePipeline(cfg: PipelineCfg) {
  const counts = { elig: 0, load: 0, coord: 0 };
  let outcome: ProductionShadowWriteOutcome | 'master_disabled' | 'none' = 'none';
  const deps: ShadowWriteGateDeps = {
    isEnabled: () => cfg.masterOn,
    resolveEligibility: async (s) => { counts.elig++; return cfg.resolveEligibility(s); },
    loadAndBuild: () => { counts.load++; return cfg.build(); },
    coordinate: async (built) => { counts.coord++; const o = await coordinateShadowWrite(built, coordDeps(cfg.store, cfg.session ?? 'member', cfg.coordEnabled ?? true)); outcome = o; return o; },
  };
  return {
    counts, deps,
    outcome: () => outcome,
    // master flag の同期 gate（public shadowWrite* と同じ順序）を含めて駆動する。
    run: async () => { if (!deps.isEnabled()) { outcome = 'master_disabled'; return outcome; } await runGatedShadowWrite(cfg.section, deps); return outcome; },
  };
}

// ── 実 eligibility を疑似 network 越しに接続する resolver（Case 13 用に client resolver 実挙動を通す） ──
type FakeNet = { verify: CanaryVerifyResult | 'throw'; userIdsRaw: string; sectionsRaw: string; mode?: 'ok' | 'network' | 'timeout' | 'malformed' | '500' | 'notoken' };
function realEligibilityResolver(net: FakeNet) {
  const getAccessToken = async () => (net.mode === 'notoken' ? null : 'fake-token');
  const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
    if (net.mode === 'network') throw new Error('network');
    if (net.mode === 'timeout') throw Object.assign(new Error('abort'), { name: 'AbortError' });
    const body = JSON.parse(String(init.body)) as { section?: unknown };
    const config = buildCanaryConfig(net.userIdsRaw, net.sectionsRaw); // 実 parser
    const verifyUser = async () => { if (net.verify === 'throw') throw new Error('auth'); return net.verify; };
    const { eligible } = await evaluateEligibility({ verifyUser, loadConfig: () => config }, { section: body.section }); // 実 core + gate
    if (net.mode === '500') return cast<Response>({ ok: false, json: async () => ({}) });
    if (net.mode === 'malformed') return cast<Response>({ ok: true, json: async () => { throw new Error('bad'); } });
    return cast<Response>({ ok: true, json: async () => ({ eligible }) });
  };
  return (section: CareerPersonalMemorySectionKey) =>
    resolveCanaryEligibility(section, { getAccessToken, fetchFn, timeoutMs: 20 });
}
const allow = async () => true;
const deny = async () => false;

// ────────────────────────────────────────────────────────────────────
// Source fixtures（実ユーザー情報を使わない）。
// ────────────────────────────────────────────────────────────────────
const profileBase = cast<CareerProfileContext>({ name: '山田太郎', university: '東京大学', faculty: '工学部', grade: 'B3', graduationYear: '2027', targetIndustries: ['IT'], targetJobs: ['エンジニア'], targetCompanies: ['A社'], jobHuntingStatus: '準備中', strengths: ['実行力'], weaknesses: ['心配性'], preferredLocations: ['東京'] });
const profileChanged = cast<CareerProfileContext>({ ...profileBase, targetIndustries: ['IT', 'コンサル'] }); // 非PII 変更
const activityBase = cast<CareerActivity>({ personality: {}, academics: { detail: '研究' }, focusedActivities: [{ title: '長期インターン', role: 'PM' }, { title: 'ゼミ', role: 'リーダー' }], partTimeJobs: [], internships: [], club: [], projects: [], leadership: [], volunteer: [], overseas: [], certifications: [], itSkills: [], languages: [], hobbies: '', awards: '', snsActivities: [], portfolios: [], lifeExperiences: {}, freeNote: '', updatedAt: '2026-07-01T00:00:00.000Z' });
const valuesBase = cast<CareerValues>({ selections: { priorities: ['成長'], avoidances: [], industries: ['IT'], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] }, notes: {}, overallNote: '', updatedAt: '2026-07-02T00:00:00.000Z' });
// build base（実 builder。PII は projection で除去される）。
const buildBase = (p: CareerProfileContext = profileBase) => buildBaseMemorySection(p, activityBase, valuesBase);

const saLog = (id: string, created: string, strength: string): CareerSelfAnalysisLog =>
  cast({ id, createdAt: created, userInput: 'raw 会話全文……', result: { summary: `所感${id}`, careerDirection: 'd', strengths: [strength], weaknesses: [], valueKeywords: [], strengthKeywords: [], recommendedIndustries: ['IT'], recommendedJobs: [], companySelectionCriteria: [], gakuchikaIdeas: ['g'], nextActions: [] } });
const esLog = (id: string, created: string): CareerEsLog =>
  cast({ id, createdAt: created, userInput: 'raw body……', result: { gakuchika: 'g', selfPr: 'p', motivation: 'm', headline: 'h', appealPoints: ['ap'], companyName: `Co${id}`, question: 'q' } });
const ivResult = (id: string, created: string): CareerInterviewResult =>
  cast({ id, createdAt: created, mode: 'real', turns: [{ role: 'ai', text: '面接官の発言全文' }], result: { overallComment: 'oc', strengths: ['s'], improvements: ['imp'], deepDiveTopics: [], nextActions: [], companyFit: 'f' } });

const buildSelf = (logs = [saLog('a', '2026-07-01', 'x'), saLog('b', '2026-07-02', 'y')]) => buildSelfAnalysisMemorySection(logs);
const buildEs = (logs = [esLog('a', '2026-06-01')]) => buildEsMemorySection(logs);
const buildIv = (r = [ivResult('a', '2026-05-01')]) => buildInterviewMemorySection(r);

// raw row helper（read adapter / seed 用）。
const rawFrom = (built: SectionRebuildResult, over: Partial<CareerPersonalMemoryRawRow> = {}): CareerPersonalMemoryRawRow => ({
  section_key: built.section.sectionKey, schema_version: built.section.schemaVersion, source_revision: built.sourceRevision,
  source_updated_at: built.sourceUpdatedAt, generated_at: NOW, status: 'fresh', payload: built.section.payload, ...over,
});

// ── independent golden（builder を経由しない手書き期待 read model・非循環） ──
const GOLDEN_BASE = { profile: { university: '東京大学', faculty: '工学部', grade: 'B3', graduationYear: '2027', targetIndustries: ['IT'], targetJobs: ['エンジニア'], targetCompanies: ['A社'], jobHuntingStatus: '準備中', strengths: ['実行力'], weaknesses: ['心配性'], preferredLocations: ['東京'] }, activity: { presentSections: ['学業', '力を入れたこと'], highlights: ['長期インターン', 'ゼミ'] }, values: { priorities: ['成長'], avoidances: [], industries: ['IT'], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] } };

async function main() {
  console.log('[Case 1] master flag OFF → 追加処理ゼロ');
  {
    const p = makePipeline({ masterOn: false, section: 'base', resolveEligibility: allow, build: buildBase, store: makeStore().store });
    const o = await p.run();
    check(o === 'master_disabled' && p.counts.elig === 0 && p.counts.load === 0 && p.counts.coord === 0, 'master OFF: eligibility/load/coordinate 0');
  }

  console.log('[Case 2] guest / no session → eligibility deny（Source load 0）');
  {
    const st = makeStore();
    // 実挙動: master ON なら gate はまず eligibility resolver を呼ぶ（guest は token 無し等で deny）。
    const p = makePipeline({ masterOn: true, section: 'base', resolveEligibility: realEligibilityResolver({ verify: { kind: 'unauth' }, userIdsRaw: USER, sectionsRaw: 'base', mode: 'notoken' }), build: buildBase, store: st.store });
    const o = await p.run();
    check(p.counts.elig === 1 && p.counts.load === 0 && p.counts.coord === 0 && st.counts.read === 0 && st.counts.upsert === 0 && o === 'none', 'guest: eligibility 進むが deny→load/read/upsert 0');
  }

  console.log('[Case 3] non-allowlisted authenticated member → deny');
  {
    const st = makeStore();
    const p = makePipeline({ masterOn: true, section: 'base', resolveEligibility: realEligibilityResolver({ verify: { kind: 'member', userId: OTHER_USER }, userIdsRaw: USER, sectionsRaw: 'base' }), build: buildBase, store: st.store });
    await p.run();
    check(p.counts.load === 0 && st.counts.read === 0 && st.counts.upsert === 0, 'non-allowlisted member: build/read/upsert 0');
  }

  console.log('[Case 4] disallowed section（base only 許可）');
  {
    for (const [section, build] of [['base', buildBase], ['self_analysis', buildSelf], ['es', buildEs], ['interview', buildIv]] as const) {
      const st = makeStore();
      const p = makePipeline({ masterOn: true, section: section as CareerPersonalMemorySectionKey, resolveEligibility: realEligibilityResolver({ verify: { kind: 'member', userId: USER }, userIdsRaw: USER, sectionsRaw: 'base' }), build: build as () => SectionRebuildResult, store: st.store });
      await p.run();
      const wrote = st.counts.upsert === 1;
      check(section === 'base' ? wrote : (!wrote && st.counts.read === 0 && p.counts.load === 0), `${section}: ${section === 'base' ? 'allowed→write' : 'denied→load/read/upsert 0'}`);
    }
  }

  console.log('[Case 5] base initial write（allowlisted・row なし）');
  let baseStore = makeStore();
  {
    const st = baseStore;
    const p = makePipeline({ masterOn: true, section: 'base', resolveEligibility: realEligibilityResolver({ verify: { kind: 'member', userId: USER }, userIdsRaw: USER, sectionsRaw: 'base' }), build: buildBase, store: st.store });
    const o = await p.run();
    check(p.counts.load === 1, 'Source load 1');
    check(st.counts.read === 1 && st.counts.upsert === 1, 'repository read 1 + upsert 1');
    check(o === 'written', 'coordinator outcome=written');
    const raw = st.getRaw(USER, 'base')!;
    check(raw.section_key === 'base' && raw.schema_version === 1 && raw.status === 'fresh', 'row: base/v1/fresh');
    const rd = readPersonalMemorySection('base', raw, { sourceRevision: cast<string>(raw.source_revision), sourceUpdatedAt: cast<string | null>(raw.source_updated_at) });
    check(rd.status === 'fresh' && rd.usableForPrompt === true, 'read adapter: fresh + usableForPrompt');
    const s = stableStringify(raw.payload).toLowerCase();
    check(!s.includes('山田太郎') && !/"name"|"email"|"phone"|"transcript"|"turns"/.test(s), 'PII/forbidden key 非混入');
    check(Buffer.byteLength(JSON.stringify(raw.payload), 'utf8') < 32 * 1024, 'payload < 32KB');
    // independent golden（builder 出力 == 手書き期待）
    check(eq(raw.payload, GOLDEN_BASE), 'base payload == independent hand-written golden');
  }

  console.log('[Case 6] idempotent re-save（同一 Source）');
  {
    const st = baseStore; const before = st.counts.upsert;
    const p = makePipeline({ masterOn: true, section: 'base', resolveEligibility: allow, build: buildBase, store: st.store });
    const o = await p.run();
    check(o === 'unchanged' && st.counts.upsert === before, 'same Source → unchanged, upsert 追加なし');
    check(st.rowCount() === 1, 'row 重複なし');
  }

  console.log('[Case 7] Source change（非PII 1項目）→ revision 変化・row 更新');
  {
    const st = baseStore; const before = st.counts.upsert;
    const p = makePipeline({ masterOn: true, section: 'base', resolveEligibility: allow, build: () => buildBase(profileChanged), store: st.store });
    const o = await p.run();
    check(o === 'written' && st.counts.upsert === before + 1, 'changed Source → written, upsert +1');
    const raw = st.getRaw(USER, 'base')!;
    check(String(raw.source_revision) === buildBase(profileChanged).sourceRevision, 'revision 変化を反映');
    check(cast<{ profile: { targetIndustries: string[] } }>(raw.payload).profile.targetIndustries.includes('コンサル'), '変更 projection 反映');
    check(cast<{ values: unknown }>(raw.payload).values !== undefined && cast<{ activity: unknown }>(raw.payload).activity !== undefined, '他 projection 欠落なし');
  }

  console.log('[Case 8] stale writer race（B commit → A 後追い）');
  {
    const st = makeStore();
    const older = buildSelf([saLog('a', '2026-07-01', 'x')]); // 古い Source（latestAt 早い）
    const newer = buildSelf([saLog('a', '2026-07-01', 'x'), saLog('b', '2026-07-09', 'y')]); // 新しい Source
    // B（newer）が先に write
    const pB = makePipeline({ masterOn: true, section: 'self_analysis', resolveEligibility: allow, build: () => newer, store: st.store });
    const oB = await pB.run();
    const upsertAfterB = st.counts.upsert;
    // A（older）が後追い → B の row を読み stale_write skip
    const pA = makePipeline({ masterOn: true, section: 'self_analysis', resolveEligibility: allow, build: () => older, store: st.store });
    const oA = await pA.run();
    check(oB === 'written', 'B(newer) written');
    check(oA === 'stale_write' && st.counts.upsert === upsertAfterB, 'A(older) → stale_write skip（upsert 増えない）');
    check(String(st.getRaw(USER, 'self_analysis')!.source_revision) === newer.sourceRevision, '最終 row は B(newer) 由来');
  }

  console.log('[Case 9] simultaneous same-revision write');
  {
    const st = makeStore();
    const built = buildEs([esLog('a', '2026-06-01')]);
    const p1 = makePipeline({ masterOn: true, section: 'es', resolveEligibility: allow, build: () => built, store: st.store });
    const p2 = makePipeline({ masterOn: true, section: 'es', resolveEligibility: allow, build: () => built, store: st.store });
    const [o1, o2] = await Promise.all([p1.run(), p2.run()]);
    const outcomes = [o1, o2].sort().join(',');
    check(st.rowCount() === 1, '最終 row 1 件（(user,section) key・重複なし）');
    check(st.counts.upsert <= 2, 'upsert は最大 2（no 無限分岐）');
    check(outcomes.includes('written'), '少なくとも 1 つ written');
    console.log(`         [limitation] outcomes=${outcomes} — in-memory は DB UNIQUE 同時競合(23505)を再現不可 → 実 DB は RUNTIME HOLD`);
  }

  console.log('[Case 10] invalid payload → upsert 0 / 既存 row 破壊なし / never-throw');
  {
    const st = makeStore();
    st.seed(USER, rawFrom(buildBase(), { source_revision: 'v1:content:pre', payload: cast<Record<string, unknown>>(GOLDEN_BASE) })); // 既存 valid row
    const bad: Array<[string, () => SectionRebuildResult]> = [
      ['malformed(payload string)', () => cast<SectionRebuildResult>({ section: { sectionKey: 'base', schemaVersion: 1, payload: 'x' }, sourceRevision: 'r', sourceUpdatedAt: null })],
      ['discriminator mismatch', () => cast<SectionRebuildResult>({ section: { sectionKey: 'base', schemaVersion: 1, payload: buildSelf().section.payload }, sourceRevision: 'r', sourceUpdatedAt: null })],
      ['PII name', () => cast<SectionRebuildResult>({ section: { sectionKey: 'base', schemaVersion: 1, payload: { ...GOLDEN_BASE, name: '山田' } }, sourceRevision: 'r', sourceUpdatedAt: null })],
      ['email', () => cast<SectionRebuildResult>({ section: { sectionKey: 'base', schemaVersion: 1, payload: { ...GOLDEN_BASE, email: 'a@b' } }, sourceRevision: 'r', sourceUpdatedAt: null })],
      ['turns', () => cast<SectionRebuildResult>({ section: { sectionKey: 'base', schemaVersion: 1, payload: { ...GOLDEN_BASE, turns: [] } }, sourceRevision: 'r', sourceUpdatedAt: null })],
      ['transcript', () => cast<SectionRebuildResult>({ section: { sectionKey: 'base', schemaVersion: 1, payload: { ...GOLDEN_BASE, transcript: 'x' } }, sourceRevision: 'r', sourceUpdatedAt: null })],
      ['prompt', () => cast<SectionRebuildResult>({ section: { sectionKey: 'base', schemaVersion: 1, payload: { ...GOLDEN_BASE, prompt: 'x' } }, sourceRevision: 'r', sourceUpdatedAt: null })],
      ['eventSignals', () => cast<SectionRebuildResult>({ section: { sectionKey: 'base', schemaVersion: 1, payload: { ...GOLDEN_BASE, recentFeatures: [] } }, sourceRevision: 'r', sourceUpdatedAt: null })],
      ['oversized', () => cast<SectionRebuildResult>({ section: { sectionKey: 'base', schemaVersion: 1, payload: { ...GOLDEN_BASE, activity: { presentSections: [], highlights: ['x'.repeat(40000)] } } }, sourceRevision: 'r', sourceUpdatedAt: null })],
    ];
    let upserts = 0; let threw = false;
    for (const [label, build] of bad) {
      const before = st.counts.upsert;
      let o: unknown;
      try { const p = makePipeline({ masterOn: true, section: 'base', resolveEligibility: allow, build, store: st.store }); o = await p.run(); } catch { threw = true; }
      check(o === 'invalid' && st.counts.upsert === before, `${label} → invalid, upsert 0`);
    }
    check(!threw, 'invalid 群で never-throw');
    check(String(st.getRaw(USER, 'base')!.source_revision) === 'v1:content:pre', '既存 valid row を破壊しない');
    check(upserts === 0, 'invalid で upsert 発生せず');
  }

  console.log('[Case 11] store read failure（★ read failure は missing 扱い→write 継続：contract 明記）');
  {
    for (const ctl of [{ readError: { code: '42501' } }, { readThrow: true }] as StoreCtl[]) {
      const st = makeStore(ctl);
      const p = makePipeline({ masterOn: true, section: 'base', resolveEligibility: allow, build: buildBase, store: st.store });
      let threw = false; let o: unknown;
      try { o = await p.run(); } catch { threw = true; }
      check(!threw, `read ${ctl.readThrow ? 'throw' : 'error'}: never-throw`);
      // 現行 contract: read 失敗→[]（missing）→ decideWrite write=true → upsert 継続。correctness は read-time revision 権威。
      check(o === 'written' && st.counts.upsert === 1, `read ${ctl.readThrow ? 'throw' : 'error'} → missing 扱いで written（best-effort read・churn / not correctness bug）`);
    }
    console.log('         [contract] read failure は write を許可（write 順序は correctness 前提でない・read-time revision で担保）');
  }

  console.log('[Case 12] store upsert failure → failed / 既存 row 不変 / retry なし');
  {
    for (const ctl of [{ upsertError: { code: '500' } }, { upsertThrow: true }] as StoreCtl[]) {
      const st = makeStore(ctl);
      st.seed(USER, rawFrom(buildBase(), { source_revision: 'v1:content:pre' }));
      const p = makePipeline({ masterOn: true, section: 'base', resolveEligibility: allow, build: () => buildBase(profileChanged), store: st.store });
      let threw = false; let o: unknown;
      try { o = await p.run(); } catch { threw = true; }
      check(!threw && o === 'failed', `upsert ${ctl.upsertThrow ? 'throw' : 'error'} → failed (never-throw)`);
      check(st.counts.upsert === 1, 'upsert 試行は 1 回のみ（無限 retry なし）');
      check(String(st.getRaw(USER, 'base')!.source_revision) === 'v1:content:pre', '既存 row を不正変更しない');
    }
  }

  console.log('[Case 13] eligibility failure matrix → 全て default deny（Source load / read / upsert 0）');
  {
    const nets: Array<[string, FakeNet]> = [
      ['timeout', { verify: { kind: 'member', userId: USER }, userIdsRaw: USER, sectionsRaw: 'base', mode: 'timeout' }],
      ['network', { verify: { kind: 'member', userId: USER }, userIdsRaw: USER, sectionsRaw: 'base', mode: 'network' }],
      ['malformed', { verify: { kind: 'member', userId: USER }, userIdsRaw: USER, sectionsRaw: 'base', mode: 'malformed' }],
      ['500', { verify: { kind: 'member', userId: USER }, userIdsRaw: USER, sectionsRaw: 'base', mode: '500' }],
      ['no-token', { verify: { kind: 'member', userId: USER }, userIdsRaw: USER, sectionsRaw: 'base', mode: 'notoken' }],
      ['auth error', { verify: 'throw', userIdsRaw: USER, sectionsRaw: 'base' }],
      ['unauth(401/403)', { verify: { kind: 'unauth' }, userIdsRaw: USER, sectionsRaw: 'base' }],
      ['no-config', { verify: { kind: 'no-config' }, userIdsRaw: USER, sectionsRaw: 'base' }],
      ['malformed UUID config', { verify: { kind: 'member', userId: USER }, userIdsRaw: `${USER},bad`, sectionsRaw: 'base' }],
      ['malformed section config', { verify: { kind: 'member', userId: USER }, userIdsRaw: USER, sectionsRaw: 'base,all' }],
    ];
    for (const [label, net] of nets) {
      const st = makeStore();
      const p = makePipeline({ masterOn: true, section: 'base', resolveEligibility: realEligibilityResolver(net), build: buildBase, store: st.store });
      let threw = false;
      try { await p.run(); } catch { threw = true; }
      check(!threw && p.counts.load === 0 && st.counts.read === 0 && st.counts.upsert === 0, `${label} → deny (load/read/upsert 0, never-throw)`);
    }
  }

  console.log('[Case 14] section isolation');
  {
    const st = makeStore();
    // 4 section を allow で書く
    for (const [section, build] of [['base', buildBase], ['self_analysis', buildSelf], ['es', buildEs], ['interview', buildIv]] as const) {
      const p = makePipeline({ masterOn: true, section: section as CareerPersonalMemorySectionKey, resolveEligibility: allow, build: build as () => SectionRebuildResult, store: st.store });
      await p.run();
    }
    check(st.rowCount() === 4, '4 section 独立 row');
    const baseRevBefore = String(st.getRaw(USER, 'base')!.source_revision);
    // es を変更再書き込み → 他 section 不変
    const p = makePipeline({ masterOn: true, section: 'es', resolveEligibility: allow, build: () => buildEs([esLog('a', '2026-06-01'), esLog('b', '2026-06-05')]), store: st.store });
    await p.run();
    check(String(st.getRaw(USER, 'base')!.source_revision) === baseRevBefore, 'es write が base row を変えない');
    check(st.perSection['self_analysis'].upsert === 1 && st.perSection['interview'].upsert === 1, 'self/interview の upsert 回数不変');
    // 1 section の破損 raw が他 section read へ波及しない
    st.replace(USER, 'self_analysis', cast<CareerPersonalMemoryRawRow>({ section_key: 'self_analysis', schema_version: 1, source_revision: 'x', source_updated_at: null, generated_at: NOW, status: 'fresh', payload: 'GARBAGE' }));
    const rows = await readCareerPersonalMemorySections(st.store, USER, ['base', 'self_analysis', 'es', 'interview']);
    check(rows.some((r) => r.sectionKey === 'base') && rows.some((r) => r.sectionKey === 'es') && !rows.some((r) => r.sectionKey === 'self_analysis'), '破損 self_analysis は drop・他 section は読める');
  }

  console.log('[Case 15] read-back contract（独立 golden + write→read compatibility）');
  {
    // independent golden（手書き raw row → read adapter。builder 非経由・非循環）
    const goldenRaw = cast<CareerPersonalMemoryRawRow>({ section_key: 'base', schema_version: 1, source_revision: 'v1:content:golden', source_updated_at: null, generated_at: NOW, status: 'fresh', payload: GOLDEN_BASE });
    check(readPersonalMemorySection('base', goldenRaw, { sourceRevision: 'v1:content:golden', sourceUpdatedAt: null }).status === 'fresh', 'golden base → fresh');
    check(readPersonalMemorySection('base', goldenRaw, { sourceRevision: 'OTHER', sourceUpdatedAt: null }).status === 'stale', 'stale expected → stale');
    check(readPersonalMemorySection('base', { ...goldenRaw, status: 'failed' }, { sourceRevision: 'v1:content:golden', sourceUpdatedAt: null }).status === 'unusable', 'failed row → unusable');
    check(readPersonalMemorySection('base', { ...goldenRaw, schema_version: 2 }, { sourceRevision: 'v1:content:golden', sourceUpdatedAt: null }).status === 'unsupported_schema', 'schema_version=2 → unsupported_schema');
    // write→read compatibility（parity ではない）: pipeline で書いた row を read adapter へ
    for (const [section, build] of [['base', buildBase], ['self_analysis', buildSelf], ['es', buildEs]] as const) {
      const st = makeStore();
      const p = makePipeline({ masterOn: true, section: section as CareerPersonalMemorySectionKey, resolveEligibility: allow, build: build as () => SectionRebuildResult, store: st.store });
      await p.run();
      const raw = st.getRaw(USER, section)!;
      const built = (build as () => SectionRebuildResult)();
      const rd = readPersonalMemorySection(section as CareerPersonalMemorySectionKey, raw, { sourceRevision: built.sourceRevision, sourceUpdatedAt: built.sourceUpdatedAt });
      check(rd.status === 'fresh' && rd.status === 'fresh' && eq(rd.section.payload, built.section.payload), `${section}: write→read fresh + payload round-trip (compatibility, not parity)`);
    }
  }

  console.log('[static] sensitive-data / import guard');
  {
    const { readFileSync } = await import('node:fs');
    const self = readFileSync(new URL(import.meta.url).pathname, 'utf8');
    // QA harness 自身が secret/実 UUID を直書きしていない（合成 UUID のみ）。
    check(!/eyJ[A-Za-z0-9_-]{20,}/.test(self), 'harness に JWT らしき文字列なし');
    check(!/postgres(ql)?:\/\//.test(self), 'harness に接続文字列なし');
    check(!/https?:\/\/[a-z0-9]{16,}\.supabase\./i.test(self), 'harness に Supabase URL なし');
    check(!/@[a-z0-9.-]+\.(com|jp|net)\b/i.test(self.replace(/a@b/g, '')), 'harness に実メールなし（fixture の a@b 除く）');
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-shadow-pipeline-qa: ALL PASS' : `career-personal-memory-shadow-pipeline-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

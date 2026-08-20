/*
 * scripts/career-personal-memory-wiring-qa.ts
 *
 * PASSAI CAREER — P16-D: Personal Memory production shadow-write wiring QA（dev-only）。
 *
 * 実 Supabase / 実データ / env を使わず、injected fake deps（flag/session/store/now）で coordinator を検証し、
 * production callsite を静的確認する。
 *   - flag OFF → session/store 未生成・write 0。
 *   - guest / no-env → guest（write 0）。no-client → no_client。member → written/unchanged/stale_write/invalid/failed。
 *   - never-throw。
 *   - 静的: callsite は対象 4 section のみ / Event Signal・Orchestrator・prompt・service role の非 import /
 *     read repository が prompt 経路で使われていない / flag default OFF。
 *
 * 使い方: npx tsx scripts/career-personal-memory-wiring-qa.ts
 */

import { readFileSync } from 'node:fs';
import { readdirSync as readdirSyncLocal } from 'node:fs';
import { join } from 'node:path';
import {
  coordinateShadowWrite,
  type ShadowWriteDeps,
  type ShadowWriteSession,
} from '@/lib/careerMemory/persistence/productionShadowWriter';
import { evalCareerPersonalMemoryShadowWriteEnabled } from '@/lib/careerMemory/persistence/shadowWriteFlag';
import {
  buildSelfAnalysisMemorySection,
  type SectionRebuildResult,
} from '@/lib/careerMemory/persistence/rebuild';
import type {
  PersonalMemoryStore,
  CareerPersonalMemoryRawRow,
  StoreSelectResult,
  StoreWriteResult,
  CareerPersonalMemoryUpsertRow,
} from '@/lib/careerMemory/persistence/repository';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };
const cast = <T>(v: unknown): T => v as T;

const built: SectionRebuildResult = buildSelfAnalysisMemorySection([]);

// ── fake store ──
function fakeStore(cfg: { rows?: CareerPersonalMemoryRawRow[] | null; writeError?: unknown } = {}) {
  const upserts: CareerPersonalMemoryUpsertRow[] = [];
  const store: PersonalMemoryStore = {
    async selectSections(): Promise<StoreSelectResult> { return { rows: cfg.rows ?? null, error: null }; },
    async upsertSection(row): Promise<StoreWriteResult> { if (!cfg.writeError) upserts.push(row); return { error: cfg.writeError ?? null }; },
    async deleteSection(): Promise<StoreWriteResult> { return { error: null }; },
  };
  return { store, upserts };
}

// ── fake deps（呼び出し回数を記録） ──
function makeDeps(over: Partial<ShadowWriteDeps> & { sessionKind?: 'member' | 'guest' | 'no-env'; store?: PersonalMemoryStore | null }) {
  const calls = { isEnabled: 0, resolveSession: 0, createStore: 0, now: 0 };
  const deps: ShadowWriteDeps = {
    isEnabled: () => { calls.isEnabled++; return over.isEnabled ? over.isEnabled() : true; },
    resolveSession: async (): Promise<ShadowWriteSession> => {
      calls.resolveSession++;
      const k = over.sessionKind ?? 'member';
      return k === 'member' ? { kind: 'member', userId: 'u1' } : k === 'no-env' ? { kind: 'no-env' } : { kind: 'guest' };
    },
    createStore: () => { calls.createStore++; return over.store !== undefined ? over.store : fakeStore().store; },
    now: () => { calls.now++; return '2026-07-10T00:00:00.000Z'; },
  };
  return { deps, calls };
}

const rawRow = (over: Partial<CareerPersonalMemoryRawRow>): CareerPersonalMemoryRawRow => ({
  section_key: 'self_analysis', schema_version: built.section.schemaVersion, source_revision: built.sourceRevision,
  source_updated_at: built.sourceUpdatedAt, generated_at: '2026-07-01', status: 'fresh', payload: built.section.payload, ...over,
});

async function main() {
  console.log('[1] flag OFF → 追加処理ゼロ（session/store 未生成・write 0）');
  {
    const { deps, calls } = makeDeps({ isEnabled: () => false });
    const r = await coordinateShadowWrite(built, deps);
    check(r === 'disabled', 'flag OFF → disabled');
    check(calls.resolveSession === 0 && calls.createStore === 0, 'flag OFF → resolveSession/createStore 未呼出');
  }

  console.log('[2] guest / no-env → guest（store 未生成・write 0）');
  {
    const { deps, calls } = makeDeps({ sessionKind: 'guest' });
    check((await coordinateShadowWrite(built, deps)) === 'guest', 'guest → guest');
    check(calls.createStore === 0, 'guest → createStore 未呼出（write 0）');
    check((await coordinateShadowWrite(built, makeDeps({ sessionKind: 'no-env' }).deps)) === 'guest', 'no-env → guest');
  }

  console.log('[3] member + no client → no_client');
  check((await coordinateShadowWrite(built, makeDeps({ sessionKind: 'member', store: null }).deps)) === 'no_client', 'member + null store → no_client');

  console.log('[4] member → written / unchanged / stale_write');
  {
    const { store, upserts } = fakeStore({ rows: [] });
    check((await coordinateShadowWrite(built, makeDeps({ store }).deps)) === 'written', 'missing row → written');
    check(upserts.length === 1 && upserts[0].user_id === 'u1' && upserts[0].section_key === 'self_analysis', 'upsert owner-scoped + section');
  }
  check((await coordinateShadowWrite(built, makeDeps({ store: fakeStore({ rows: [rawRow({})] }).store }).deps)) === 'unchanged', 'same revision row → unchanged (compare-and-set)');
  // stale_write は built に実 sourceUpdatedAt があり、既存行がそれより新しい Source 由来のとき（K）。
  const builtWithSource = buildSelfAnalysisMemorySection([cast({ id: 'a', createdAt: '2026-07-05', userInput: '', result: { summary: 's', strengths: ['x'], recommendedIndustries: ['IT'], gakuchikaIdeas: ['g'], weaknesses: [], careerDirection: 'd', valueKeywords: [], strengthKeywords: [], recommendedJobs: [], companySelectionCriteria: [], nextActions: [], esAngles: [], interviewQuestions: [], suitableEnvironment: [], motivationSources: [], stressFactors: [], developmentPoints: [] } })]);
  const staleRow = rawRow({ section_key: 'self_analysis', source_revision: 'different', source_updated_at: '2999-01-01', payload: builtWithSource.section.payload });
  check((await coordinateShadowWrite(builtWithSource, makeDeps({ store: fakeStore({ rows: [staleRow] }).store }).deps)) === 'stale_write', 'existing newer Source → stale_write (K guard)');

  console.log('[5] failed / invalid / never-throw');
  check((await coordinateShadowWrite(built, makeDeps({ store: fakeStore({ writeError: { message: 'rls' } }).store }).deps)) === 'failed', 'store write error → failed');
  {
    const invalidBuilt = cast<SectionRebuildResult>({ section: { sectionKey: 'self_analysis', schemaVersion: 1, payload: 'x' }, sourceRevision: 'r', sourceUpdatedAt: null });
    check((await coordinateShadowWrite(invalidBuilt, makeDeps({ store: fakeStore({ rows: [] }).store }).deps)) === 'invalid', 'invalid payload → invalid (not written)');
  }
  {
    const throwingDeps: ShadowWriteDeps = { isEnabled: () => true, resolveSession: async () => { throw new Error('boom'); }, createStore: () => fakeStore().store, now: () => 'n' };
    check((await coordinateShadowWrite(built, throwingDeps)) === 'failed', 'deps throw → failed (never-throw boundary)');
  }

  console.log('[6] flag eval (default OFF / fail-closed)');
  for (const [v, exp] of [['true', true], ['1', true], ['yes', true], ['TRUE', true], ['', false], ['false', false], ['x', false]] as const) {
    check(evalCareerPersonalMemoryShadowWriteEnabled(v) === exp, `flag eval "${v}" → ${exp}`);
  }
  check(evalCareerPersonalMemoryShadowWriteEnabled(undefined) === false && evalCareerPersonalMemoryShadowWriteEnabled(1) === false, 'non-string / 未設定 → false (fail-closed)');

  console.log('[7] static: production callsites = 対象 4 section のみ・save 後配置');
  {
    // ★ ES は「AI 代筆廃止（360be22）」で es/run/page.tsx が削除され、
    //   確定経路が es/[id]（添削完了・改善版保存）と es/draft/[draftId]（新規確定）の 2 file 3 経路へ分かれた。
    // ★ self-analysis は 9e06fdf で確定処理が finalizeSummary.ts へ移設された。
    //   どちらも「実装が動いたのに QA の参照先が旧 path のまま」だったため、実経路へ追随させる。
    // count は「その file 内で期待する callsite 数」。ES の 3 経路を数で担保する。
    const wire: Array<{ file: string; fn: string; after: RegExp; count: number; label: string }> = [
      { file: 'app/career/self-analysis/finalizeSummary.ts', fn: 'shadowWriteSelfAnalysisMemory', after: /upsertCareerSelfAnalysisResultsToSupabase/, count: 1, label: '自己分析確定' },
      { file: 'app/career/es/[id]/page.tsx', fn: 'shadowWriteEsMemory', after: /upsertCareerEsLogsToSupabase/, count: 2, label: 'ES添削完了 + 改善版保存' },
      { file: 'app/career/es/draft/[draftId]/page.tsx', fn: 'shadowWriteEsMemory', after: /upsertCareerEsLogsToSupabase/, count: 1, label: '新規ES確定' },
      { file: 'app/career/interview/session/page.tsx', fn: 'shadowWriteInterviewMemory', after: /upsertCareerInterviewResultsToSupabase/, count: 1, label: '面接完了' },
      { file: 'app/career/profile/ProfileClient.tsx', fn: 'shadowWriteBaseMemory', after: /saveCareerProfileToSupabase/, count: 1, label: 'プロフィール保存' },
      { file: 'app/career/activity/page.tsx', fn: 'shadowWriteBaseMemory', after: /saveCareerActivityToSupabase/, count: 1, label: '活動保存' },
      { file: 'app/career/values/page.tsx', fn: 'shadowWriteBaseMemory', after: /saveCareerValuesToSupabase/, count: 1, label: '価値観保存' },
      // マイページ（User Data Hub）から編集する canonical 志望条件。profile と同じ 3 段
      //（localStorage canonical → career_profiles mirror → Layer 2 base 再構築）を通る。
      { file: 'app/career/mypage/saveCareerAspiration.ts', fn: 'shadowWriteBaseMemory', after: /saveCareerProfileToSupabase/, count: 1, label: 'マイページ志望条件保存' },
    ];
    for (const w of wire) {
      const src = readFileSync(join(ROOT, w.file), 'utf8');
      const needle = `void ${w.fn}()`;
      const occurrences = src.split(needle).length - 1;
      const firstCallIdx = src.indexOf(needle);
      const saveIdx = src.search(w.after);
      check(occurrences === w.count, `${w.file}: ${w.fn} 呼出 ${w.count} 件（${w.label}）: got ${occurrences}`);
      check(firstCallIdx > saveIdx && saveIdx >= 0, `${w.file}: shadow write は canonical save/mirror の後`);
    }

    // ES の 3 経路が「別々の確定処理」に紐づいていること（同じ箇所の重複ではない）。
    {
      const editor = readFileSync(join(ROOT, 'app/career/es/[id]/page.tsx'), 'utf8');
      const draft = readFileSync(join(ROOT, 'app/career/es/draft/[draftId]/page.tsx'), 'utf8');
      check(/添削完了[\s\S]{0,240}?void shadowWriteEsMemory\(\)/.test(editor), 'ES: 添削完了の確定後に再構築');
      check(/改善版[\s\S]{0,240}?void shadowWriteEsMemory\(\)/.test(editor), 'ES: 改善版保存の確定後に再構築');
      check(/deleteEsDraft[\s\S]{0,240}?void shadowWriteEsMemory\(\)/.test(draft), 'ES: 新規確定（draft 削除）の後に再構築');
    }
    // 他の career route/page に shadow write が混入していない（manifest の callsite + 定義ファイルのみ）。
    const callers = execGrep('shadowWrite\\(Base\\|SelfAnalysis\\|Es\\|Interview\\)Memory(');
    const files = new Set(callers.map((l) => l.split(':')[0]));
    const expected = new Set([
      'app/career/personalMemoryShadowWrite.ts',
      'app/career/self-analysis/finalizeSummary.ts',
      'app/career/es/[id]/page.tsx', 'app/career/es/draft/[draftId]/page.tsx',
      'app/career/interview/session/page.tsx', 'app/career/profile/ProfileClient.tsx',
      'app/career/activity/page.tsx', 'app/career/values/page.tsx',
      'app/career/mypage/saveCareerAspiration.ts',
    ]);
    check([...files].every((f) => expected.has(f)), `shadow write は対象 file のみ（${[...files].filter((f) => !expected.has(f)).join(',') || 'ok'}）`);
  }

  console.log('[8] static: Event Signal / Orchestrator / prompt / service role 非 import・read が prompt 経路で不使用');
  {
    const coord = readFileSync(join(ROOT, 'lib/careerMemory/persistence/productionShadowWriter.ts'), 'utf8');
    const wrap = readFileSync(join(ROOT, 'app/career/personalMemoryShadowWrite.ts'), 'utf8');
    for (const [name, src] of [['coordinator', coord], ['wrapper', wrap]] as const) {
      check(!/renderEventSignals|eventSignalPilotGuard|loadEventSignals|eventSignals/.test(src), `${name}: Event Signal 非 import`);
      check(!/buildCareerContextForPurpose|careerContext\/orchestrator|CrossFeatureContext|presentationPrompt|interviewPrompt|esPrompt|consultationPrompt/.test(src), `${name}: Orchestrator/prompt builder 非 import`);
      check(!/serviceRole|service_role/.test(src), `${name}: service role 非使用`);
    }
    // Orchestrator / renderer が productionShadowWriter / repository read を import していない（prompt 経路清浄）。
    const orch = readFileSync(join(ROOT, 'lib/careerContext/orchestrator.ts'), 'utf8');
    check(!/productionShadowWriter|persistence\/repository|readCareerPersonalMemorySections/.test(orch), 'orchestrator は Memory read/coordinator を import しない');
    // ★ manifest を固定列挙しない: renderer ディレクトリの **実体を走査**する。
    //   renderer が増減しても陳腐化せず、新 renderer が persistence を掴めば即 FAIL する
    //   （PROTOCOL §6.1 の網羅性 check）。
    const rendererDir = join(ROOT, 'lib/careerMemory/renderers');
    const renderers = readdirSyncLocal(rendererDir).filter((f) => f.endsWith('.ts'));
    check(renderers.length >= 3, `renderer が検出できる（${renderers.length} 件）`);
    for (const r of renderers) {
      const src = readFileSync(join(rendererDir, r), 'utf8');
      check(!/persistence\/|productionShadowWriter|readCareerPersonalMemorySections/.test(src), `${r}: persistence を import しない（prompt 経路清浄）`);
    }
  }

  console.log('[9] static: PII / transcript / prompt を console 出力しない');
  {
    const coord = readFileSync(join(ROOT, 'lib/careerMemory/persistence/productionShadowWriter.ts'), 'utf8');
    const wrap = readFileSync(join(ROOT, 'app/career/personalMemoryShadowWrite.ts'), 'utf8');
    check(!/console\.(log|info|warn|error)\(/.test(coord) && !/console\.(log|info|warn|error)\(/.test(wrap), 'coordinator/wrapper に console 出力なし（payload/PII 非ログ）');
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-wiring-qa: ALL PASS' : `career-personal-memory-wiring-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

// grep helper（node 内 child_process 回避のため、対象 dir を自前走査）。
import { readdirSync, statSync } from 'node:fs';
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e === '.git') continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
function execGrep(_pattern: string): string[] {
  const re = /void shadowWrite(Base|SelfAnalysis|Es|Interview)Memory\(\)/;
  const files = walk(join(ROOT, 'app/career'));
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (re.test(src)) hits.push(f.replace(ROOT + '/', '') + ':hit');
  }
  return hits;
}

void main();

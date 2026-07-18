/*
 * scripts/career-personal-memory-read-contract-qa.ts
 *
 * PASSAI CAREER — P16-E: Personal Memory shadow-read adapter Offline Read Contract QA（dev-only）。
 *
 * 実 Supabase / 実 row / prompt / Orchestrator を一切使わず、read adapter の contract を検証する:
 *   - 正常系: valid base/self_analysis/es/interview fixture row → fresh・usableForPrompt。
 *   - independent golden: production builder で expected を生成せず、手書き golden read model と比較。
 *   - 欠損/劣化系: missing / malformed / unknown / unsupported schema / mismatch / bad status /
 *     revision 欠損 / stale / size cap / forbidden key / PII / raw turns / raw transcript / repository error 相当。
 *   - writer-reader compatibility: rebuild builder の payload を read adapter が受理（parity ではない）。
 *   - 決定性 / section 独立 / usableForPrompt が state.ts と一致。
 *   - 静的: readAdapter が env / 外部AI / Supabase 実接続 / client 生成を import しない・未配線。
 *
 * ★ 本 QA は実 row を使わないため「read parity 完了」ではない（Read Contract QA）。
 *   同一 builder の出力を両辺に置く循環比較は independent golden では使用しない。
 *
 * 使い方: npx tsx scripts/career-personal-memory-read-contract-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readPersonalMemorySection,
  readPersonalMemorySectionsFromRows,
  type PersonalMemoryReadResult,
} from '@/lib/careerMemory/persistence/readAdapter';
import { stableStringify } from '@/lib/careerMemory/persistence/validate';
import { isUsableForPrompt } from '@/lib/careerMemory/persistence/state';
import {
  buildBaseMemorySection,
  buildSelfAnalysisMemorySection,
  buildEsMemorySection,
  buildInterviewMemorySection,
} from '@/lib/careerMemory/persistence/rebuild';
import type { ExpectedMemoryMeta } from '@/lib/careerMemory/persistence/state';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerEsLog } from '@/types/careerEs';
import type { EsMemorySummary } from '@/lib/careerMemory/types';
import type { CareerInterviewResult } from '@/types/careerInterview';
import type { CareerProfileContext } from '@/lib/careerAi';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';

let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };
const cast = <T>(v: unknown): T => v as T;
const eq = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const NOW = '2026-07-10T00:00:00.000Z';

// raw row builder（DB select 相当の snake_case row。手書き fixture を組むため）。
function rawRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    section_key: 'base',
    schema_version: 1,
    source_revision: 'v1:content:aaaa0001',
    source_updated_at: '2026-07-02T00:00:00.000Z',
    generated_at: NOW,
    status: 'fresh',
    payload: {},
    ...over,
  };
}
const exp = (sourceRevision: string, sourceUpdatedAt: string | null = null): ExpectedMemoryMeta => ({ sourceRevision, sourceUpdatedAt });

// ────────────────────────────────────────────────────────────────────
// independent golden fixtures（手書き payload + 手書き期待 read model）。
//   production builder を使わない＝expected/actual が同じ変換関数に依存する循環を避ける。
// ────────────────────────────────────────────────────────────────────
const GOLDEN_BASE_PAYLOAD = {
  profile: {
    university: '東京大学', faculty: '工学部', grade: 'B3', graduationYear: '2027',
    targetIndustries: ['IT'], targetJobs: ['エンジニア'], targetCompanies: ['A社'],
    jobHuntingStatus: '準備中', strengths: ['実行力'], weaknesses: ['心配性'], preferredLocations: ['東京'],
  },
  activity: { presentSections: ['学業', '力を入れたこと'], highlights: ['長期インターン'] },
  values: {
    priorities: ['成長'], avoidances: [], industries: ['IT'], jobTypes: [],
    workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [],
  },
};
const GOLDEN_SELF_PAYLOAD = {
  meta: { feature: 'self_analysis', sourceCount: 2, latestAt: '2026-07-02', warnings: [] },
  latest: [
    { createdAt: '2026-07-02', summary: '所感b', careerDirection: 'd', strengths: ['計画性'], weaknesses: [], valueKeywords: [], strengthKeywords: [], recommendedIndustries: ['IT'], recommendedJobs: [], companySelectionCriteria: [], gakuchikaIdeas: ['g'], nextActions: [] },
  ],
  longTerm: { consistentStrengths: [], industryShift: [] },
};
// ES golden: P17-M1 で「本人が入力した設問メタのみ」へ縮小済み。
//   ★ AI 生成本文（headline / gakuchika / selfPr / motivation / appealPoints）・その派生
//     （recurringAppeal）・AI 添削・ES 生本文は golden に含めない。旧契約として残さないこと。
//   EsMemorySummary 注釈により、旧 field を書き戻すと excess property check で tsc が赤になる。
const GOLDEN_ES_PAYLOAD: EsMemorySummary = {
  meta: { feature: 'es', sourceCount: 1, latestAt: '2026-06-01', warnings: [] },
  latest: [{ createdAt: '2026-06-01', companyName: 'Co-A', question: 'q' }],
  longTerm: { companies: ['Co-A'] },
};
const GOLDEN_INTERVIEW_PAYLOAD = {
  meta: { feature: 'interview', sourceCount: 1, latestAt: '2026-05-01', warnings: [] },
  latest: [
    { createdAt: '2026-05-01', mode: 'real', overallComment: 'oc', strengths: ['s'], improvements: ['imp'], deepDiveTopics: [], nextActions: [], companyFit: 'f' },
  ],
  longTerm: { recurringImprovements: [], stableStrengths: [] },
};

const GOLDEN = [
  { key: 'base', rev: 'v1:content:base0001', payload: GOLDEN_BASE_PAYLOAD },
  { key: 'self_analysis', rev: 'v1:content:self0001', payload: GOLDEN_SELF_PAYLOAD },
  { key: 'es', rev: 'v1:content:es000001', payload: GOLDEN_ES_PAYLOAD },
] as const;

// ── writer-reader compatibility fixtures（builder は compat 検証にのみ使用） ──
const saLog = (id: string, created: string, strength: string): CareerSelfAnalysisLog =>
  cast({ id, createdAt: created, userInput: '', result: { summary: `所感${id}`, careerDirection: 'd', strengths: [strength], weaknesses: [], valueKeywords: [], strengthKeywords: [], recommendedIndustries: ['IT'], recommendedJobs: [], companySelectionCriteria: [], gakuchikaIdeas: ['g'], nextActions: [] } });
const esLog = (id: string, created: string): CareerEsLog =>
  cast({ id, createdAt: created, userInput: '', result: { gakuchika: 'g', selfPr: 'p', motivation: 'm', headline: 'h', appealPoints: ['ap'], companyName: `Co${id}`, question: 'q' } });
const ivResult = (id: string, created: string): CareerInterviewResult =>
  cast({ id, createdAt: created, mode: 'real', turns: [{ role: 'ai', text: '面接官の発言全文' }], result: { overallComment: 'oc', strengths: ['s'], improvements: ['imp'], deepDiveTopics: [], nextActions: [], companyFit: 'f' } });
const profileCtx = cast<CareerProfileContext>({ name: '山田太郎', university: '東京大学', faculty: '工学部', grade: 'B3', graduationYear: '2027', targetIndustries: ['IT'], targetJobs: ['eng'], targetCompanies: ['A社'], jobHuntingStatus: '準備中', strengths: ['実行力'], weaknesses: ['心配性'], preferredLocations: ['東京'] });
const activity = cast<CareerActivity>({ personality: {}, academics: { detail: '研究' }, focusedActivities: [{ title: '長期インターン', role: 'PM' }], partTimeJobs: [], internships: [], club: [], projects: [], leadership: [], volunteer: [], overseas: [], certifications: [], itSkills: [], languages: [], hobbies: '読書', awards: '', snsActivities: [], portfolios: [], lifeExperiences: {}, freeNote: '', updatedAt: '2026-07-01T00:00:00.000Z' });
const values = cast<CareerValues>({ selections: { priorities: ['成長'], avoidances: [], industries: ['IT'], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] }, notes: {}, overallNote: '', updatedAt: '2026-07-02T00:00:00.000Z' });

function main() {
  console.log('[1] independent golden: valid row + matching revision → fresh, read model == 手書き golden');
  for (const g of GOLDEN) {
    const row = rawRow({ section_key: g.key, source_revision: g.rev, payload: g.payload });
    const r = readPersonalMemorySection(g.key, row, exp(g.rev));
    check(r.status === 'fresh', `${g.key}: fresh`);
    check(r.status === 'fresh' && r.usableForPrompt === true, `${g.key}: usableForPrompt=true`);
    // 手書き golden payload と read model が一致（builder を経由しない independent 比較）。
    check(r.status === 'fresh' && eq(r.section.payload, g.payload), `${g.key}: read model == hand-written golden payload`);
    check(r.status === 'fresh' && r.section.sectionKey === g.key && r.section.schemaVersion === 1, `${g.key}: discriminated union preserved`);
  }

  console.log('[2] interview: contract fixture のみ（実データ parity は HOLD）');
  {
    const row = rawRow({ section_key: 'interview', source_revision: 'v1:content:iv000001', payload: GOLDEN_INTERVIEW_PAYLOAD });
    const r = readPersonalMemorySection('interview', row, exp('v1:content:iv000001'));
    check(r.status === 'fresh' && eq(r.section.payload, GOLDEN_INTERVIEW_PAYLOAD), 'interview: contract fixture fresh (実データ parity は HOLD)');
  }

  console.log('[3] stale: 同一 row + 異なる expected revision → stale, usableForPrompt=false, section は保持');
  for (const g of GOLDEN) {
    const row = rawRow({ section_key: g.key, source_revision: g.rev, payload: g.payload });
    const r = readPersonalMemorySection(g.key, row, exp('v1:content:DIFFERENT'));
    check(r.status === 'stale' && r.usableForPrompt === false, `${g.key}: revision mismatch → stale (not usable)`);
    check(r.status === 'stale' && eq(r.section.payload, g.payload), `${g.key}: stale でも read model は保持`);
  }

  console.log('[4] stale latestAt は freshness 権威ではない: revision 一致なら sourceUpdatedAt 相違でも fresh');
  {
    const row = rawRow({ section_key: 'base', source_revision: 'v1:content:base0001', source_updated_at: '1999-01-01T00:00:00.000Z', payload: GOLDEN_BASE_PAYLOAD });
    const r = readPersonalMemorySection('base', row, exp('v1:content:base0001', '2099-01-01T00:00:00.000Z'));
    check(r.status === 'fresh', 'sourceUpdatedAt 相違でも revision 一致 → fresh（revision が権威）');
  }

  console.log('[5] missing');
  check(readPersonalMemorySection('base', null, exp('r')).status === 'missing', 'null row → missing');
  check(readPersonalMemorySection('base', undefined, exp('r')).status === 'missing', 'undefined row → missing');
  check(readPersonalMemorySectionsFromRows([{ sectionKey: 'es', expected: exp('r') }], [rawRow({ section_key: 'base' })])[0].status === 'missing', '要求 section が rows に無い → missing');

  console.log('[6] malformed / repository error 相当の入力 → invalid（throw しない）');
  for (const bad of ['x', 123, true, [], null === undefined]) {
    const r = readPersonalMemorySection('base', bad, exp('r'));
    check(r.status === 'missing' || (r.status === 'invalid' && r.reason === 'malformed_row'), `malformed input(${JSON.stringify(bad)}) → missing/invalid, no throw`);
  }
  check(readPersonalMemorySection('base', { message: 'RLS denied', code: '42501' }, exp('r')).status === 'invalid', 'repository error 相当 object（section_key 無し）→ invalid');

  console.log('[7] section_mismatch');
  check(cast<PersonalMemoryReadResult>(readPersonalMemorySection('base', rawRow({ section_key: 'es' }), exp('r'))).status === 'invalid', 'row.section_key != 要求 → invalid(section_mismatch)');

  console.log('[8] unsupported schema version（独立 status）');
  {
    const r2 = readPersonalMemorySection('base', rawRow({ schema_version: 2, payload: GOLDEN_BASE_PAYLOAD }), exp('r'));
    check(r2.status === 'unsupported_schema' && r2.foundSchemaVersion === 2, 'schema_version=2 → unsupported_schema(foundSchemaVersion=2)');
    const r0 = readPersonalMemorySection('base', rawRow({ schema_version: 0, payload: GOLDEN_BASE_PAYLOAD }), exp('r'));
    check(r0.status === 'invalid', 'schema_version=0 → invalid（validate と整合・unsupported 扱いにしない）');
  }

  console.log('[9] malformed payload / section↔payload 不一致');
  check(readPersonalMemorySection('base', rawRow({ payload: 'not-object' }), exp('r')).status === 'invalid', 'payload が object でない → invalid');
  check(readPersonalMemorySection('base', rawRow({ payload: GOLDEN_SELF_PAYLOAD }), exp('r')).status === 'invalid', 'base に self_analysis payload → invalid(shape 不一致)');
  check(readPersonalMemorySection('self_analysis', rawRow({ section_key: 'self_analysis', payload: GOLDEN_BASE_PAYLOAD }), exp('r')).status === 'invalid', 'self_analysis に base payload → invalid(shape 不一致)');

  console.log('[10] revision 欠損/不正 → fresh にならない（stale）');
  {
    const r = readPersonalMemorySection('base', rawRow({ source_revision: undefined, payload: GOLDEN_BASE_PAYLOAD }), exp('v1:content:base0001'));
    check(r.status === 'stale' && r.usableForPrompt === false, 'source_revision 欠損 → stale（fresh にしない）');
  }

  console.log('[11] size cap 超過 → invalid(oversized)');
  {
    const huge = { ...GOLDEN_BASE_PAYLOAD, activity: { presentSections: [], highlights: [ 'x'.repeat(40000) ] } };
    const r = readPersonalMemorySection('base', rawRow({ payload: huge }), exp('r'));
    check(r.status === 'invalid' && r.reason === 'oversized', '32KB 超 payload → invalid(oversized)');
  }

  console.log('[12] forbidden key / PII / raw turns / raw transcript → invalid(forbidden_key)');
  const forbid = [
    ['name(PII)', { ...GOLDEN_BASE_PAYLOAD, name: '山田太郎' }],
    ['email(PII)', { ...GOLDEN_BASE_PAYLOAD, email: 'a@b.com' }],
    ['phone(PII)', { ...GOLDEN_BASE_PAYLOAD, phone: '090' }],
    ['turns(raw)', { ...GOLDEN_BASE_PAYLOAD, turns: [{ role: 'ai', text: '全文' }] }],
    ['transcript(raw)', { ...GOLDEN_BASE_PAYLOAD, transcript: '会話全文' }],
    ['prompt', { ...GOLDEN_BASE_PAYLOAD, prompt: 'system prompt' }],
    ['eventSignals', { ...GOLDEN_BASE_PAYLOAD, recentFeatures: ['es'] }],
  ] as const;
  for (const [label, payload] of forbid) {
    const r = readPersonalMemorySection('base', rawRow({ payload }), exp('r'));
    check(r.status === 'invalid' && r.reason === 'forbidden_key', `${label} → invalid(forbidden_key)`);
  }

  console.log('[13] db status=failed → unusable / status 不正 → invalid(bad_status)');
  {
    const rf = readPersonalMemorySection('base', rawRow({ status: 'failed', source_revision: 'v1:content:base0001', payload: GOLDEN_BASE_PAYLOAD }), exp('v1:content:base0001'));
    check(rf.status === 'unusable' && rf.usableForPrompt === false, 'db status=failed（revision 一致でも）→ unusable');
    check(readPersonalMemorySection('base', rawRow({ status: 'weird', payload: GOLDEN_BASE_PAYLOAD }), exp('r')).status === 'invalid', 'status が enum 外 → invalid(bad_status)');
  }

  console.log('[14] section 独立: 1 section invalid でも他 section は読める');
  {
    const rows = [
      rawRow({ section_key: 'base', source_revision: 'v1:content:base0001', payload: GOLDEN_BASE_PAYLOAD }),
      'GARBAGE-ES-ROW', // es は破損
      rawRow({ section_key: 'self_analysis', source_revision: 'v1:content:self0001', payload: GOLDEN_SELF_PAYLOAD }),
    ];
    const results = readPersonalMemorySectionsFromRows([
      { sectionKey: 'base', expected: exp('v1:content:base0001') },
      { sectionKey: 'es', expected: exp('v1:content:es000001') },
      { sectionKey: 'self_analysis', expected: exp('v1:content:self0001') },
    ], rows);
    check(results[0].status === 'fresh', 'base fresh');
    check(results[1].status === 'missing', 'es（破損 row は section_key 無しで採用されず）→ missing');
    check(results[2].status === 'fresh', 'self_analysis fresh（他 section 破損に波及しない）');
  }
  {
    // repository error 相当（rows が配列でない）→ 全 missing（throw しない）。
    const results = readPersonalMemorySectionsFromRows([{ sectionKey: 'base', expected: exp('r') }], { error: 'db down' });
    check(results.length === 1 && results[0].status === 'missing', 'rawRows が非配列（error 相当）→ 全 missing');
  }

  console.log('[15] 決定性: 同一入力 → 同一 read result');
  {
    const row = rawRow({ source_revision: 'v1:content:base0001', payload: GOLDEN_BASE_PAYLOAD });
    check(eq(readPersonalMemorySection('base', row, exp('v1:content:base0001')), readPersonalMemorySection('base', row, exp('v1:content:base0001'))), 'deterministic read result');
  }

  console.log('[16] usableForPrompt は state.ts と一致（fresh のみ true）');
  {
    const fresh = readPersonalMemorySection('base', rawRow({ source_revision: 'v1:content:base0001', payload: GOLDEN_BASE_PAYLOAD }), exp('v1:content:base0001'));
    const stale = readPersonalMemorySection('base', rawRow({ source_revision: 'v1:content:base0001', payload: GOLDEN_BASE_PAYLOAD }), exp('other'));
    check(fresh.usableForPrompt === isUsableForPrompt('fresh'), 'fresh.usableForPrompt == isUsableForPrompt(fresh)');
    check(stale.usableForPrompt === isUsableForPrompt('stale'), 'stale.usableForPrompt == isUsableForPrompt(stale)');
  }

  console.log('[17] writer-reader compatibility（parity ではない）: builder payload を read adapter が受理');
  {
    const built = {
      base: buildBaseMemorySection(profileCtx, activity, values),
      self_analysis: buildSelfAnalysisMemorySection([saLog('a', '2026-07-01', 'x'), saLog('b', '2026-07-02', 'y')]),
      es: buildEsMemorySection([esLog('a', '2026-06-01')]),
      interview: buildInterviewMemorySection([ivResult('a', '2026-05-01')]),
    } as const;
    for (const key of ['base', 'self_analysis', 'es', 'interview'] as const) {
      const b = built[key];
      const row = rawRow({ section_key: key, schema_version: b.section.schemaVersion, source_revision: b.sourceRevision, source_updated_at: b.sourceUpdatedAt, payload: b.section.payload });
      const okRes = readPersonalMemorySection(key, row, exp(b.sourceRevision, b.sourceUpdatedAt));
      check(okRes.status === 'fresh' && eq(okRes.section.payload, b.section.payload), `${key}: writer→reader accepted (fresh, payload round-trip)`);
      const staleRes = readPersonalMemorySection(key, row, exp('v1:content:CHANGED', b.sourceUpdatedAt));
      check(staleRes.status === 'stale', `${key}: writer payload + changed expected → stale`);
    }
    // interview builder 由来 payload に raw turns が混入していない（read model も本文を持たない）。
    const ivRow = rawRow({ section_key: 'interview', source_revision: built.interview.sourceRevision, payload: built.interview.section.payload });
    const ivRead = readPersonalMemorySection('interview', ivRow, exp(built.interview.sourceRevision));
    check(ivRead.status === 'fresh' && !stableStringify(ivRead.section.payload).includes('面接官の発言全文'), 'interview read model に raw turns 本文が無い');
  }

  console.log('[18] static: readAdapter は env / 外部AI / Supabase 実接続 / client 生成を import しない・未配線');
  {
    const root = process.cwd();
    const src = readFileSync(join(root, 'lib/careerMemory/persistence/readAdapter.ts'), 'utf8');
    check(!/anthropic|openai|process\.env|\.env\.local|serviceRole|createClient\(|browserClient|getCareerBrowserSupabaseClient/.test(src), 'readAdapter に env/AI/Supabase-real/client 生成の import なし');
    // 配線有無は import 文で判定する（コメント内の境界説明「Orchestrator / prompt」に誤反応しないため）。
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    const badImport = importLines.filter((l) => /orchestrat|prompt|careerAi|app\/api|routes?\/|careerContext|browserClient/i.test(l));
    check(badImport.length === 0, 'readAdapter の import は persistence 兄弟のみ（route/Orchestrator/prompt/client を import しない）');
    // app/career・prompt・Orchestrator から readAdapter が未 import（read rollout 未配線）。
    const grepImporters = (dirRel: string) => {
      const { execSync } = require('node:child_process') as typeof import('node:child_process');
      try {
        return execSync(`grep -rl "persistence/readAdapter" ${dirRel} --include=*.ts --include=*.tsx 2>/dev/null || true`, { cwd: root, encoding: 'utf8' }).trim();
      } catch { return ''; }
    };
    check(grepImporters('app') === '', 'app/ から readAdapter 未 import（production callsite 未配線）');
    const libImporters = grepImporters('lib').split('\n').filter((l) => l && !l.includes('readAdapter.ts'));
    check(libImporters.length === 0, 'lib/（scripts 除く）から readAdapter 未 import');
  }

  console.log('');
  console.log(failures === 0 ? 'career-personal-memory-read-contract-qa: ALL PASS' : `career-personal-memory-read-contract-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

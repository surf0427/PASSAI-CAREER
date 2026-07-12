/*
 * scripts/career-personal-memory-schema-qa.ts
 *
 * PASSAI CAREER — P16-A Stage 1: Personal Memory schema / payload validation QA（dev-only）。
 *
 * 何を守るか:
 *   - section discriminated union の網羅性（4 section）と SQL CHECK との一致。
 *   - validate: valid payload PASS / mismatch・unknown section・version・invalid・oversized・forbidden key FAIL。
 *   - forbidden key（PII / transcript / prompt / Event Signal 由来）を deep scan で拒否。
 *   - deterministic serialization（stableStringify）round-trip。
 *   - SQL(section CHECK / status CHECK / payload DEFAULT なし / RLS / FK CASCADE / UNIQUE) と TS 定数の一致。
 *
 * 厳守: production を読むだけ。DB / Supabase / env / secret / 外部 AI 非接続。
 * 使い方: npx tsx scripts/career-personal-memory-schema-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAREER_PERSONAL_MEMORY_SECTION_KEYS,
  CAREER_PERSONAL_MEMORY_PERSISTED_STATUSES,
  CAREER_PERSONAL_MEMORY_SCHEMA_VERSION,
  CAREER_PERSONAL_MEMORY_MAX_PAYLOAD_BYTES,
} from '@/lib/careerMemory/persistence/schema';
import {
  validateCareerPersonalMemorySection,
  stableStringify,
  payloadByteSize,
} from '@/lib/careerMemory/persistence/validate';

let failures = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failures++;
};

// ── valid payload fixtures（P4-A FeatureSummary 形状） ──
const meta = (feature: string, n: number) => ({ feature, sourceCount: n, latestAt: '2026-07-01', warnings: [] });
const basePayload = {
  profile: { university: '', faculty: '', grade: '', graduationYear: '', targetIndustries: [], targetJobs: [], targetCompanies: [], jobHuntingStatus: '', strengths: [], weaknesses: [], preferredLocations: [] },
  activity: { presentSections: ['academics'], highlights: ['ガクチカA'] },
  values: { priorities: ['成長'], avoidances: [], industries: [], jobTypes: [], workStyles: [], companyTypes: [], careerGoals: [], culturePreferences: [] },
};
const selfAnalysisPayload = { meta: meta('self_analysis', 2), latest: [{ createdAt: '2026-07-01', summary: 's', careerDirection: 'd', strengths: ['a'], weaknesses: [], valueKeywords: [], strengthKeywords: [], recommendedIndustries: ['IT'], recommendedJobs: [], companySelectionCriteria: [], gakuchikaIdeas: ['g'], nextActions: [] }], longTerm: { consistentStrengths: ['a'], industryShift: [] } };
const esPayload = { meta: meta('es', 1), latest: [{ createdAt: '2026-06-01', companyName: 'Co', question: 'q', headline: 'h', gakuchika: 'g', selfPr: 'p', motivation: 'm', appealPoints: ['ap'] }], longTerm: { recurringAppeal: [], companies: ['Co'] } };
const interviewPayload = { meta: meta('interview', 1), latest: [{ createdAt: '2026-05-01', mode: 'real', overallComment: 'oc', strengths: ['s'], improvements: ['i'], deepDiveTopics: [], nextActions: [], companyFit: 'f' }], longTerm: { recurringImprovements: [], stableStrengths: [] } };

const V = CAREER_PERSONAL_MEMORY_SCHEMA_VERSION;

console.log('[1] valid payloads PASS');
check(validateCareerPersonalMemorySection('base', V, basePayload).ok, 'base valid');
check(validateCareerPersonalMemorySection('self_analysis', V, selfAnalysisPayload).ok, 'self_analysis valid');
check(validateCareerPersonalMemorySection('es', V, esPayload).ok, 'es valid');
check(validateCareerPersonalMemorySection('interview', V, interviewPayload).ok, 'interview valid');

console.log('[2] mismatch / unknown / version');
// section/payload mismatch: base の payload を self_analysis として渡す → base は featureSummary shape を持たない
const mm = validateCareerPersonalMemorySection('self_analysis', V, basePayload);
check(!mm.ok && mm.reason === 'invalid_payload', 'section/payload mismatch → invalid_payload');
const us = validateCareerPersonalMemorySection('presentation', V, selfAnalysisPayload);
check(!us.ok && us.reason === 'unknown_section', 'unknown section → unknown_section');
const v0 = validateCareerPersonalMemorySection('es', 0, esPayload);
check(!v0.ok && v0.reason === 'invalid_payload', 'version 0 → invalid_payload');
const vf = validateCareerPersonalMemorySection('es', V + 1, esPayload);
check(!vf.ok && vf.reason === 'unsupported_version', 'future version → unsupported_version');
const vneg = validateCareerPersonalMemorySection('es', -1, esPayload);
check(!vneg.ok && vneg.reason === 'invalid_payload', 'negative version → invalid_payload');

console.log('[3] invalid object types');
for (const bad of [null, undefined, [], 'str', 42, true] as unknown[]) {
  const r = validateCareerPersonalMemorySection('self_analysis', V, bad);
  check(!r.ok && r.reason === 'invalid_payload', `payload=${JSON.stringify(bad)} → invalid_payload`);
}

console.log('[4] oversized');
const big = { meta: meta('es', 1), latest: [{ createdAt: '2026-06-01', companyName: 'Co', question: 'q', headline: 'h', gakuchika: 'x'.repeat(CAREER_PERSONAL_MEMORY_MAX_PAYLOAD_BYTES + 100), selfPr: '', motivation: '', appealPoints: [] }] };
const ov = validateCareerPersonalMemorySection('es', V, big);
check(!ov.ok && ov.reason === 'oversized', 'oversized payload → oversized');
check(payloadByteSize(big) > CAREER_PERSONAL_MEMORY_MAX_PAYLOAD_BYTES, 'payloadByteSize measures oversize');

console.log('[5] forbidden keys (PII / transcript / prompt / Event Signal)');
const forbid = (extra: Record<string, unknown>, label: string) => {
  const p = { ...selfAnalysisPayload, ...extra } as Record<string, unknown>;
  const r = validateCareerPersonalMemorySection('self_analysis', V, p);
  check(!r.ok && r.reason === 'forbidden_key', `forbidden: ${label}`);
};
forbid({ name: '山田太郎' }, 'name(PII)');
forbid({ email: 'x@example.com' }, 'email(PII)');
forbid({ phone: '090-0000-0000' }, 'phone(PII)');
forbid({ transcript: '面接: ...' }, 'transcript');
forbid({ prompt: '完成 prompt 文字列' }, 'prompt');
forbid({ turns: [{ role: 'q' }] }, 'turns(raw)');
forbid({ recentFeatures: ['es'] }, 'recentFeatures(Event Signal)');
forbid({ featureUsage: { es: '1' } }, 'featureUsage(Event Signal)');
forbid({ latestBands: {} }, 'latestBands(Event Signal)');
// nested forbidden key
forbid({ latest: [{ deep: { email: 'x@y.z' } }] }, 'nested email');

console.log('[6] legit keys NOT false-positive (companyName contains "name")');
check(validateCareerPersonalMemorySection('es', V, esPayload).ok, 'es with companyName → valid (exact-key guard)');

console.log('[7] empty-but-valid payload (sourceCount 0 は正常 empty)');
const emptySelf = { meta: meta('self_analysis', 0), latest: [] };
check(validateCareerPersonalMemorySection('self_analysis', V, emptySelf).ok, 'sourceCount=0 empty → valid (missing 行不在 とは別概念)');

console.log('[8] deterministic serialization round-trip');
const s1 = stableStringify(selfAnalysisPayload);
const s2 = stableStringify(JSON.parse(JSON.stringify(selfAnalysisPayload)));
check(s1 === s2, 'stableStringify deterministic across re-serialize');
const reordered = { latest: selfAnalysisPayload.latest, longTerm: selfAnalysisPayload.longTerm, meta: selfAnalysisPayload.meta };
check(stableStringify(reordered) === stableStringify(selfAnalysisPayload), 'stableStringify key-order independent');

console.log('[9] union exhaustiveness (TS const == 4 MVP sections)');
check(JSON.stringify([...CAREER_PERSONAL_MEMORY_SECTION_KEYS].sort()) === JSON.stringify(['base', 'es', 'interview', 'self_analysis']), 'section keys == base/es/interview/self_analysis');
check(JSON.stringify([...CAREER_PERSONAL_MEMORY_PERSISTED_STATUSES].sort()) === JSON.stringify(['failed', 'fresh', 'stale']), 'persisted statuses == fresh/stale/failed');

console.log('[10] SQL ↔ TS 一致（static）');
const sql = readFileSync(join(process.cwd(), 'supabase/career_personal_memory_apply.sql'), 'utf8');
check(/section_key IN \('base', 'self_analysis', 'es', 'interview'\)/.test(sql), 'SQL section CHECK == TS union');
check(/status IN \('fresh', 'stale', 'failed'\)/.test(sql), 'SQL status CHECK == TS persisted statuses');
check(/schema_version\s+int\s+NOT NULL/.test(sql) && /schema_version > 0/.test(sql), 'SQL schema_version CHECK > 0');
check(/payload\s+jsonb\s+NOT NULL/.test(sql) && !/payload\s+jsonb\s+NOT NULL DEFAULT/.test(sql), "SQL payload NOT NULL WITHOUT DEFAULT '{}'");
check(/jsonb_typeof\(payload\) = 'object'/.test(sql), 'SQL payload object CHECK');
check(/REFERENCES auth\.users\(id\) ON DELETE CASCADE/.test(sql), 'SQL FK auth.users ON DELETE CASCADE');
check(/UNIQUE \(user_id, section_key\)/.test(sql), 'SQL UNIQUE(user_id, section_key)');
check(/ENABLE ROW LEVEL SECURITY/.test(sql), 'SQL RLS enabled');
check(/owner select/.test(sql) && /owner insert/.test(sql) && /owner update/.test(sql) && /owner delete/.test(sql), 'SQL 4 owner policies (incl DELETE)');
check(!/TO anon|TO public/.test(sql), 'SQL no anon/public policy');

console.log('');
console.log(failures === 0 ? 'career-personal-memory-schema-qa: ALL PASS' : `career-personal-memory-schema-qa: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

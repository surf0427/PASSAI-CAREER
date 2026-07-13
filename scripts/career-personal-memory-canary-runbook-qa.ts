/*
 * scripts/career-personal-memory-canary-runbook-qa.ts
 *
 * PASSAI CAREER — P16-F-1: base runtime write canary runbook の軽量 docs QA（dev-only・オフライン）。
 *
 * runbook が「必須構成語句」を含み、かつ「禁止事項の明記」を持つことを静的に検証する。
 * production code / SQL / env / Supabase には触れない（ファイル読取のみ）。
 *
 * 使い方: npx tsx scripts/career-personal-memory-canary-runbook-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const RUNBOOK = join(ROOT, 'docs/career/personal_memory_base_runtime_canary_runbook.md');

let failures = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`); if (!ok) failures++; };

let src = '';
try {
  src = readFileSync(RUNBOOK, 'utf8');
} catch {
  console.log('  FAIL  runbook が存在しない: docs/career/personal_memory_base_runtime_canary_runbook.md');
  process.exit(1);
}

// 必須構成（Phase 見出し・必須章）。
const requiredPhases = [
  'Phase 0', 'Phase 1', 'Phase 2', 'Phase 3', 'Phase 4',
  'Phase 5', 'Phase 6', 'Phase 7', 'Phase 8', 'Phase 9', 'Phase 10',
];
console.log('[1] 必須 Phase 見出し');
for (const p of requiredPhases) check(src.includes(p), `${p} が存在`);

console.log('[2] 必須構成要素');
const requiredSections: Array<[string, RegExp]> = [
  ['Execution Gate', /Execution Gate/],
  ['DDL Gate', /DDL Application Gate/],
  ['Flag Enablement', /Flag Enablement/],
  ['Canary Cases A〜F', /Case[\s\S]*A[\s\S]*B[\s\S]*C[\s\S]*D[\s\S]*E[\s\S]*F/],
  ['Row Observation Contract', /Row Observation Contract/],
  ['STOP Conditions', /STOP Condition/i],
  ['Rollback', /Rollback/i],
  ['Success Criteria', /Success Criteria/],
  ['Post-Canary Decision', /Post-Canary Decision/],
  ['運用記録テンプレート', /運用記録テンプレート/],
];
for (const [name, re] of requiredSections) check(re.test(src), `${name} が存在`);

console.log('[3] リスク・境界の明記');
const requiredNotices: Array<[string, RegExp]> = [
  ['Production 代替禁止', /Production を代替環境として使用しない/],
  ['global flag リスク', /グローバル boolean/],
  ['user/section canary 制限なし', /user 単位・section 単位の canary 制限は\s*\*\*存在しない\*\*/],
  ['Interview 非依存', /Interview 実機は base canary の前提ではない/],
  ['secret/PII 記録禁止', /secret[\s\S]{0,40}記録しない|記録・実行ログへ\s*記録しない|文書・実行ログへ/],
  ['service role 不使用', /service role/],
  ['全 user row 非取得', /全\s*(ユーザー|user)\s*row を(取得しない|取得しない)/],
  ['non-production 限定', /non-production/],
  ['32KB cap', /32KB/],
  ['owner-scoped RLS', /owner-scoped|RLS/],
];
for (const [name, re] of requiredNotices) check(re.test(src), `${name} が明記`);

console.log('[4] 禁止トークンが文書に混入していない（secret/実値の直書き防止）');
// service role KEY 実体・connection string・実メール・UUID を直書きしていないことの粗い検査。
const forbiddenPatterns: Array<[string, RegExp]> = [
  ['service_role JWT らしき文字列', /eyJ[A-Za-z0-9_-]{20,}/],
  ['postgres 接続文字列', /postgres(ql)?:\/\/[^\s]/i],
  ['実メールアドレス', /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/],
  ['生 UUID', /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/],
  ['supabase URL', /https?:\/\/[a-z0-9]{16,}\.supabase\./i],
];
for (const [name, re] of forbiddenPatterns) check(!re.test(src), `${name} を含まない`);

console.log('[5] コード整合: 参照している実ファイルが存在する');
const referenced = [
  'lib/careerMemory/persistence/shadowWriteFlag.ts',
  'app/career/personalMemoryShadowWrite.ts',
  'lib/careerMemory/persistence/productionShadowWriter.ts',
  'lib/careerMemory/persistence/shadowWriter.ts',
  'lib/careerMemory/persistence/repository.ts',
  'lib/careerMemory/persistence/validate.ts',
  'lib/careerMemory/persistence/state.ts',
  'lib/careerMemory/persistence/rebuild.ts',
  'supabase/career_personal_memory_apply.sql',
];
for (const rel of referenced) {
  let ok = true;
  try { readFileSync(join(ROOT, rel), 'utf8'); } catch { ok = false; }
  check(ok, `参照ファイル存在: ${rel}`);
}

console.log('[6] コード整合: activity debounce 値が runbook と一致（1500ms）');
{
  const activitySrc = readFileSync(join(ROOT, 'app/career/activity/page.tsx'), 'utf8');
  const codeHas1500 = /},\s*1500\s*\)/.test(activitySrc) && /setTimeout\(/.test(activitySrc);
  check(codeHas1500 && src.includes('1500ms'), 'activity の debounce=1500ms がコード・runbook で一致');
}

console.log('');
console.log(failures === 0 ? 'career-personal-memory-canary-runbook-qa: ALL PASS' : `career-personal-memory-canary-runbook-qa: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

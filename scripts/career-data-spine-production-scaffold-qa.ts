/*
 * scripts/career-data-spine-production-scaffold-qa.ts
 *
 * PASSAI CAREER — Data Spine Production Scaffold 統合 QA（P17-C §16）。
 *
 * [A] DB boundary  [B] SQL static verification  [C] Repository  [D] Readiness
 * [E] Gate  [F] Loader  [G] Isolation
 *
 * ネットワーク・実 Supabase・実 migration なし。fake DB port のみ。
 * 使い方: npx tsx scripts/career-data-spine-production-scaffold-qa.ts
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { mapDbError } from '@/lib/careerDataSpineDb/errors';
import { clampPagination, DEFAULT_MAX_ROWS } from '@/lib/careerDataSpineDb/types';
import { createSupabaseAggregateReadRepository } from '@/lib/careerAggregate/supabaseReadRepository';
import { createSupabaseCompanyKnowledgeReadRepository } from '@/lib/careerCompanyKnowledge/supabaseReadRepository';
import { evaluateReadiness, READINESS_DECISIONS } from '@/lib/careerDataSpinePolicy/readiness';
import { parseCanaryAllowlist, evaluateCanary, isConsumerEligible } from '@/lib/careerDataSpineGate/canary';
// NOTE: config.server.ts / flags.server.ts は `import 'server-only'` を持つため tsx から実行時 import
//   しない（server-only は Next build 時の shim）。それらの default OFF / NOT READY は静的 source 検査で確認する。
import { loadAggregatedInsightContextServer } from '@/lib/careerContextLoaders/server/aggregatedInsight.server';
import { loadCompanyKnowledgeContextServer } from '@/lib/careerContextLoaders/server/companyKnowledge.server';
import {
  createFakeDb,
  batchRow,
  artifactRow,
  contributionRow,
  moderationRow,
  DS_NOW,
  DS_NOW_ISO,
  CANARY_UUID,
  NON_CANARY_UUID,
} from './fixtures/careerDataSpineDbFixtures';
import type { CanaryDecision } from '@/lib/careerDataSpineGate/canary';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const ROOT = process.cwd();
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const eligibleCanary: CanaryDecision = { eligible: true, reason: 'allowlisted' };
const ineligibleCanary: CanaryDecision = { eligible: false, reason: 'not_in_allowlist' };

// ══════════════════════════════════════════════════════════════════
console.log('[A] DB boundary');
{
  check('A1 mapDbError 42P01 → table_missing', mapDbError({ code: '42P01' }, 't').kind === 'table_missing');
  check('A2 mapDbError 42501 → permission_denied', mapDbError({ code: '42501' }, 't').kind === 'permission_denied');
  check('A3 mapDbError 23505 → conflict', mapDbError({ code: '23505' }, 't').kind === 'conflict');
  check('A4 mapDbError unknown → unavailable', mapDbError({ code: 'ZZZ' }, 't').kind === 'unavailable');
  check('A5 mapDbError は raw message を載せない', !JSON.stringify(mapDbError({ code: 'X', message: 'secret detail' }, 't')).includes('secret detail'));
  check('A6 clampPagination は limit を上限で clamp', clampPagination({ limit: 99999 }).limit === DEFAULT_MAX_ROWS && clampPagination({ limit: 0 }).limit === 1);
}

// ══════════════════════════════════════════════════════════════════
console.log('[B] SQL static verification');
{
  const l4 = readFileSync(join(ROOT, 'supabase/career_aggregated_insight_apply.sql'), 'utf8');
  const l5 = readFileSync(join(ROOT, 'supabase/career_company_knowledge_apply.sql'), 'utf8');
  const files: Array<[string, string]> = [['L4', l4], ['L5', l5]];

  // 共通 header（TARGET PROJECT 行は L4=finalized(shared) / L5=UNDECIDED で異なるため別扱い）。
  const HEADERS = ['NOT APPLIED', 'DO NOT APPLY UNTIL DECISION REGISTER GATES ARE CLOSED', 'DEFAULT DENY', 'SERVICE/BATCH WRITER POLICY UNDECIDED', 'LEGAL/CONSENT VALUES NOT FINAL'];

  for (const [label, sql] of files) {
    check(`B ${label} header markers 全て存在`, HEADERS.every((h) => sql.includes(h)));
    // TARGET PROJECT: L4 は P17-E で shared 確定、L5 は未決定のまま。
    check(`B ${label} TARGET PROJECT header`, label === 'L4' ? /TARGET PROJECT: shared/i.test(sql) : sql.includes('TARGET PROJECT UNDECIDED'));
    const begins = (sql.match(/\bBEGIN;/g) ?? []).length;
    const commits = (sql.match(/\bCOMMIT;/g) ?? []).length;
    check(`B ${label} BEGIN/COMMIT 整合`, begins === 1 && commits === 1);
    const creates = (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length;
    const rls = (sql.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length;
    check(`B ${label} 全 table に RLS enabled`, creates > 0 && creates === rls, `creates=${creates} rls=${rls}`);
    check(`B ${label} CREATE POLICY なし（default deny）`, !/create\s+policy/i.test(sql));
    check(`B ${label} permissive policy (USING true) なし`, !/using\s*\(\s*true\s*\)/i.test(sql));
    check(`B ${label} GRANT なし`, !/grant\s+(select|insert|update|delete|all|usage|references|execute)/i.test(sql));
    // 禁止 column は「定義」文脈でのみ検出する（コメント / COMMENT ON の散文語は対象外）。
    const TYPE = '(uuid|text|integer|boolean|timestamptz|jsonb|text\\[\\])';
    const forbiddenCol = (name: string) => new RegExp(`\\b${name}\\s+${TYPE}`, 'i').test(sql);
    const forbidden = ['user_id', 'auth_user_id', 'email', 'contributor_name', 'university', 'application_id', 'transcript', 'raw_text', 'body', 'answer'];
    const hit = forbidden.filter(forbiddenCol);
    check(`B ${label} 禁止 column 定義なし`, hit.length === 0, hit.join(','));
    check(`B ${label} 無制限 raw text 保存 field なし`, !/\bcontent\s+text\b/i.test(sql) && !/\bbody\s+text\b/i.test(sql));
    check(`B ${label} legal/consent hardcode（INTERVAL retention）なし`, !/\bINTERVAL\b/i.test(sql));
  }

  // L4 idempotency
  check('B L4 idempotency UNIQUE(idempotency_key)', /UNIQUE\s*\(\s*idempotency_key\s*\)/i.test(l4));
  // dependency order: batches が artifacts より前
  check('B L4 dependency order (batches before artifacts)', l4.indexOf('career_aggregate_batches (') < l4.indexOf('career_aggregate_artifacts ('));
  check('B L5 dependency order (master before contributions)', l5.indexOf('career_company_master (') < l5.indexOf('career_company_knowledge_contributions ('));
  // schema.sql へ未統合
  const schema = readFileSync(join(ROOT, 'supabase/schema.sql'), 'utf8');
  check('B schema.sql へ統合していない', !schema.includes('career_aggregate_batches') && !schema.includes('career_company_knowledge_contributions'));
}

// ══════════════════════════════════════════════════════════════════
console.log('[C] Repository (fake DB port)');

async function l4Read(db: ReturnType<typeof createFakeDb>, artifactId = 'art-1', now = DS_NOW) {
  const repo = createSupabaseAggregateReadRepository(db.read);
  return repo.readArtifact(artifactId, now);
}

async function repositoryChecks(): Promise<void> {
  // valid
  {
    const db = createFakeDb();
    db.seed('career_aggregate_batches', [batchRow()]);
    db.seed('career_aggregate_artifacts', [artifactRow()]);
    const r = await l4Read(db);
    check('C1 valid batch/artifact → available', r.status === 'available');
    const r2 = await l4Read(db);
    check('C1 deterministic（同一結果）', JSON.stringify(r) === JSON.stringify(r2));
  }
  // stale
  {
    const db = createFakeDb();
    db.seed('career_aggregate_batches', [batchRow()]);
    db.seed('career_aggregate_artifacts', [artifactRow({ expires_at: '2026-07-01T00:00:00.000Z' }, { expiresAt: '2026-07-01T00:00:00.000Z' })]);
    check('C2 期限切れ artifact → stale', (await l4Read(db)).status === 'stale');
  }
  // incomplete
  {
    const db = createFakeDb();
    db.seed('career_aggregate_batches', [batchRow({ incomplete_reason: 'watermark_gap', validation_state: 'invalid' })]);
    db.seed('career_aggregate_artifacts', [artifactRow()]);
    check('C3 incomplete batch → available にならない', (await l4Read(db)).status !== 'available');
  }
  // failed
  {
    const db = createFakeDb();
    db.seed('career_aggregate_batches', [batchRow({ status: 'failed', validation_state: 'invalid', publish_state: 'unpublished' })]);
    db.seed('career_aggregate_artifacts', [artifactRow()]);
    check('C4 failed batch → blocked', (await l4Read(db)).status === 'blocked');
  }
  // invalidated
  {
    const db = createFakeDb();
    db.seed('career_aggregate_batches', [batchRow()]);
    db.seed('career_aggregate_artifacts', [artifactRow({ invalidated: true })]);
    check('C5 invalidated artifact → blocked', (await l4Read(db)).status === 'blocked');
  }
  // malformed payload
  {
    const db = createFakeDb();
    db.seed('career_aggregate_batches', [batchRow()]);
    db.seed('career_aggregate_artifacts', [artifactRow({}, { kind: 'weird' })]);
    check('C6 malformed payload (unknown kind) → unavailable', (await l4Read(db)).status === 'unavailable');
  }
  // table missing / permission denied
  {
    const db = createFakeDb({ errorTables: { career_aggregate_artifacts: { kind: 'table_missing', table: 'career_aggregate_artifacts' } } });
    check('C7 table missing → unavailable', (await l4Read(db)).status === 'unavailable');
    const db2 = createFakeDb({ errorTables: { career_aggregate_artifacts: { kind: 'permission_denied', table: 'career_aggregate_artifacts' } } });
    check('C7 permission denied → unavailable', (await l4Read(db2)).status === 'unavailable');
  }
  // missing
  {
    const db = createFakeDb();
    check('C8 未登録 artifact → missing', (await l4Read(db, 'nope')).status === 'missing');
  }

  // ── Layer 5 ──
  const l5 = (db: ReturnType<typeof createFakeDb>, purpose = 'company_research', companyId = 'c_alpha') =>
    createSupabaseCompanyKnowledgeReadRepository(db.read).readProjection({ purpose, companyId, displayName: 'Alpha株式会社', nowIso: DS_NOW_ISO });

  {
    const db = createFakeDb();
    db.seed('career_company_knowledge_contributions', [contributionRow()]);
    db.seed('career_company_knowledge_moderation', [moderationRow()]);
    const r = await l5(db);
    check('C9 approved/published/safe/non-stale → available', r.status === 'available');
    check('C9 projection に contributor_opaque_key を出さない', r.status === 'available' && !JSON.stringify(r).includes('opaque-A'));
  }
  {
    const db = createFakeDb();
    db.seed('career_company_knowledge_contributions', [contributionRow()]);
    db.seed('career_company_knowledge_moderation', [moderationRow({ state: 'pending' })]);
    check('C10 moderation pending → empty', (await l5(db)).status === 'empty');
  }
  {
    const db = createFakeDb();
    db.seed('career_company_knowledge_contributions', [contributionRow({ revoked: true })]);
    db.seed('career_company_knowledge_moderation', [moderationRow()]);
    check('C11 revoked → empty', (await l5(db)).status === 'empty');
  }
  {
    const db = createFakeDb();
    db.seed('career_company_knowledge_contributions', [contributionRow({ legal_hold: true })]);
    db.seed('career_company_knowledge_moderation', [moderationRow()]);
    check('C12 legal hold → empty', (await l5(db)).status === 'empty');
  }
  {
    const db = createFakeDb();
    db.seed('career_company_knowledge_contributions', [contributionRow()]);
    db.seed('career_company_knowledge_moderation', [moderationRow({ pii_scan: 'not_scanned' })]);
    check('C13 PII unknown → empty', (await l5(db)).status === 'empty');
  }
  {
    const db = createFakeDb();
    db.seed('career_company_knowledge_contributions', [contributionRow()]);
    db.seed('career_company_knowledge_moderation', [moderationRow({ confidentiality: 'unknown' })]);
    check('C14 confidentiality unknown → empty', (await l5(db)).status === 'empty');
  }
  {
    const db = createFakeDb();
    db.seed('career_company_knowledge_contributions', [contributionRow({ observed_period: '2018' })]);
    db.seed('career_company_knowledge_moderation', [moderationRow()]);
    check('C15 stale → empty', (await l5(db)).status === 'empty');
  }
  {
    const db = createFakeDb();
    db.seed('career_company_knowledge_contributions', [contributionRow({ evidence_kind: 'bogus' })]);
    db.seed('career_company_knowledge_moderation', [moderationRow()]);
    check('C16 unknown enum row skip → empty', (await l5(db)).status === 'empty');
  }
  {
    const db = createFakeDb();
    db.seed('career_company_knowledge_contributions', [contributionRow()]);
    db.seed('career_company_knowledge_moderation', [moderationRow()]);
    check('C17 unknown purpose → unavailable', (await l5(db, 'bogus_purpose')).status === 'unavailable');
  }
  {
    const db = createFakeDb({ errorTables: { career_company_knowledge_contributions: { kind: 'table_missing', table: 'x' } } });
    check('C18 table missing → unavailable', (await l5(db)).status === 'unavailable');
  }
  {
    const db = createFakeDb();
    db.seed('career_company_knowledge_contributions', [
      contributionRow({ contribution_id: 'x1', contributor_opaque_key: 'kA', evidence_summary: '面接は3回、最終は役員。' }),
      contributionRow({ contribution_id: 'x2', contributor_opaque_key: 'kB', evidence_summary: '面接はなくテストのみ。' }),
    ]);
    db.seed('career_company_knowledge_moderation', [moderationRow({ contribution_id: 'x1' }), moderationRow({ contribution_id: 'x2' })]);
    const r = await l5(db);
    check('C19 conflict → available だが conflict 保持',
      r.status === 'available' && (r.data.corroboration === 'conflicting' || r.data.evidence.some((e) => e.conflicting)));
  }
  {
    const db = createFakeDb();
    db.seed('career_company_knowledge_contributions', [contributionRow()]);
    db.seed('career_company_knowledge_moderation', [moderationRow()]);
    const r = await l5(db);
    check('C20 単一投稿 → trend 化しない（single_report）', r.status === 'available' && r.data.corroboration === 'single_report');
  }
}

// ══════════════════════════════════════════════════════════════════
console.log('[D] Readiness');
{
  check('D1 default (null) → NOT READY', evaluateReadiness(null).ready === false);
  check('D2 partial → NOT READY', evaluateReadiness({ target_project: true }).ready === false);
  const all = Object.fromEntries(READINESS_DECISIONS.map((k) => [k, true]));
  check('D3 全 approved のみ READY', evaluateReadiness(all).ready === true);
  check('D4 空 config（env 未設定相当）→ NOT READY', evaluateReadiness({}).ready === false);
  const r = evaluateReadiness(null);
  check('D5 readiness 結果に secret を含めない', !JSON.stringify(r).toLowerCase().includes('key') && !JSON.stringify(r).includes('SUPABASE'));
  // config.server は server-only（tsx 非 import）。静的検査で default NOT READY / env 名のみ / secret 非読取を確認。
  const cfgSrc = readFileSync(join(ROOT, 'lib/careerDataSpinePolicy/config.server.ts'), 'utf8');
  check('D6 config.server は server-only', /import\s+['"]server-only['"]/.test(cfgSrc));
  check('D6 config.server は === "true"（未設定は false）', cfgSrc.includes("=== 'true'"));
}

// ══════════════════════════════════════════════════════════════════
console.log('[E] Gate');
{
  check('E1 空 allowlist → empty', parseCanaryAllowlist('').ok === false);
  check('E2 wildcard 拒否', parseCanaryAllowlist('*').ok === false && evaluateCanary('*', CANARY_UUID).reason === 'wildcard_rejected');
  check('E3 malformed UUID 拒否', parseCanaryAllowlist('not-a-uuid').ok === false);
  check('E4 allowlist 内 → eligible', evaluateCanary(CANARY_UUID, CANARY_UUID).eligible === true);
  check('E5 allowlist 外 → not eligible', evaluateCanary(CANARY_UUID, NON_CANARY_UUID).eligible === false);
  check('E6 非 UUID user → invalid_user', evaluateCanary(CANARY_UUID, 'self-reported').reason === 'invalid_user');
  check('E7 多重 gate: 全 true のみ eligible',
    isConsumerEligible({ masterReadEnabled: true, consumerEnabled: true, readinessReady: true, canary: eligibleCanary }) === true);
  check('E8 master OFF → not eligible', isConsumerEligible({ masterReadEnabled: false, consumerEnabled: true, readinessReady: true, canary: eligibleCanary }) === false);
  check('E9 consumer OFF → not eligible', isConsumerEligible({ masterReadEnabled: true, consumerEnabled: false, readinessReady: true, canary: eligibleCanary }) === false);
  check('E10 readiness false → not eligible', isConsumerEligible({ masterReadEnabled: true, consumerEnabled: true, readinessReady: false, canary: eligibleCanary }) === false);
  check('E11 canary 外 → not eligible', isConsumerEligible({ masterReadEnabled: true, consumerEnabled: true, readinessReady: true, canary: ineligibleCanary }) === false);
  // flags.server は server-only（tsx 非 import）。静的検査で default OFF / allowlist default empty を確認。
  const flagsSrc = readFileSync(join(ROOT, 'lib/careerDataSpineGate/flags.server.ts'), 'utf8');
  check('E12 flags.server は server-only', /import\s+['"]server-only['"]/.test(flagsSrc));
  check('E12 flag は === "true"（default OFF）・return true なし', flagsSrc.includes("=== 'true'") && !/return\s+true\b/.test(flagsSrc));
  check('E12 canary allowlist は default empty (?? \'\')', flagsSrc.includes("?? ''"));
}

// ══════════════════════════════════════════════════════════════════
console.log('[F] Loader');

async function loaderChecks(): Promise<void> {
  const db = createFakeDb();
  db.seed('career_aggregate_batches', [batchRow()]);
  db.seed('career_aggregate_artifacts', [artifactRow()]);
  const readRepo = createSupabaseAggregateReadRepository(db.read);
  const base = { readRepository: readRepo, artifactId: 'art-1', now: DS_NOW };

  check('F1 flag OFF → disabled',
    (await loadAggregatedInsightContextServer({ ...base, isReadEnabled: false, isConsumerEnabled: true, readinessReady: true, canary: eligibleCanary })).status === 'disabled');
  check('F2 readiness false → blocked',
    (await loadAggregatedInsightContextServer({ ...base, isReadEnabled: true, isConsumerEnabled: true, readinessReady: false, canary: eligibleCanary })).status === 'blocked');
  check('F3 canary 外 → disabled',
    (await loadAggregatedInsightContextServer({ ...base, isReadEnabled: true, isConsumerEnabled: true, readinessReady: true, canary: ineligibleCanary })).status === 'disabled');

  const ok = await loadAggregatedInsightContextServer({ ...base, isReadEnabled: true, isConsumerEnabled: true, readinessReady: true, canary: eligibleCanary });
  check('F4 全 gate 通過 + valid → available', ok.status === 'available');
  if (ok.status === 'available') {
    check('F5 available 必須属性', 'provenance' in ok && typeof ok.confidence === 'number' && 'freshness' in ok && ok.privacy === 'anonymous_aggregate' && ok.usage === 'reference_only');
    check('F6 Layer 4 usage=reference_only', ok.usage === 'reference_only');
    check('F7 projection に raw count key なし', !Object.keys(ok.data[0]).includes('denominator') && !Object.keys(ok.data[0]).includes('numerator'));
    check('F8 raw DB row を返さない（safe_artifact/ opaque を含めない）', !JSON.stringify(ok.data).includes('safe_artifact'));
  }

  // repo state mappings
  const staleDb = createFakeDb();
  staleDb.seed('career_aggregate_batches', [batchRow()]);
  staleDb.seed('career_aggregate_artifacts', [artifactRow({ expires_at: '2026-07-01T00:00:00.000Z' }, { expiresAt: '2026-07-01T00:00:00.000Z' })]);
  const staleLoader = await loadAggregatedInsightContextServer({ readRepository: createSupabaseAggregateReadRepository(staleDb.read), artifactId: 'art-1', now: DS_NOW, isReadEnabled: true, isConsumerEnabled: true, readinessReady: true, canary: eligibleCanary });
  check('F9 repo stale → stale', staleLoader.status === 'stale');

  const missDb = createFakeDb();
  const missLoader = await loadAggregatedInsightContextServer({ readRepository: createSupabaseAggregateReadRepository(missDb.read), artifactId: 'none', now: DS_NOW, isReadEnabled: true, isConsumerEnabled: true, readinessReady: true, canary: eligibleCanary });
  check('F10 repo missing → empty', missLoader.status === 'empty');

  // exception fail-closed
  const throwing = { readArtifact: async () => { throw new Error('boom'); } };
  const exLoader = await loadAggregatedInsightContextServer({ readRepository: throwing, artifactId: 'x', now: DS_NOW, isReadEnabled: true, isConsumerEnabled: true, readinessReady: true, canary: eligibleCanary });
  check('F11 loader 例外 → unavailable（fail-closed）', exLoader.status === 'unavailable');

  // Layer 5 loader
  const l5db = createFakeDb();
  l5db.seed('career_company_knowledge_contributions', [contributionRow()]);
  l5db.seed('career_company_knowledge_moderation', [moderationRow()]);
  const l5repo = createSupabaseCompanyKnowledgeReadRepository(l5db.read);
  const l5base = { readRepository: l5repo, query: { purpose: 'company_research', companyId: 'c_alpha', displayName: 'Alpha株式会社', nowIso: DS_NOW_ISO } };
  check('F12 L5 flag OFF → disabled', (await loadCompanyKnowledgeContextServer({ ...l5base, isReadEnabled: false, isConsumerEnabled: true, readinessReady: true, canary: eligibleCanary })).status === 'disabled');
  check('F13 L5 readiness false → blocked', (await loadCompanyKnowledgeContextServer({ ...l5base, isReadEnabled: true, isConsumerEnabled: true, readinessReady: false, canary: eligibleCanary })).status === 'blocked');
  const l5ok = await loadCompanyKnowledgeContextServer({ ...l5base, isReadEnabled: true, isConsumerEnabled: true, readinessReady: true, canary: eligibleCanary });
  check('F14 L5 全 gate 通過 → available (user_evidence_not_fact)', l5ok.status === 'available' && l5ok.usage === 'user_evidence_not_fact');
  check('F15 L5 canary 外 → disabled', (await loadCompanyKnowledgeContextServer({ ...l5base, isReadEnabled: true, isConsumerEnabled: true, readinessReady: true, canary: ineligibleCanary })).status === 'disabled');
}

// ══════════════════════════════════════════════════════════════════
console.log('[G] Production isolation');
function isolationChecks(): void {
  const NEW_MODULES = [
    'careerDataSpineDb',
    'careerDataSpinePolicy',
    'careerDataSpineGate',
    'careerContextLoaders/server',
    'supabaseBatchRepository',
    'supabaseReadRepository',
    'supabaseInvalidationRepository',
    'supabaseRepository',
  ];
  // production consumer（新 module 自身 + P17-E composition/shadow 層は除外）。
  //   P17-E の server composition（careerAggregate/server/*）・shadow dispatcher/evidence は、
  //   scaffold を組み立てる sanctioned な server-only 統合層であり production consumer ではない。
  const isNewModuleFile = (f: string) =>
    f.includes('/careerDataSpineDb/') || f.includes('/careerDataSpinePolicy/') ||
    f.includes('/careerDataSpineGate/') || f.includes('/careerContextLoaders/server/') ||
    f.includes('/careerAggregate/server/') ||
    f.endsWith('/careerAggregate/shadowDispatcher.server.ts') ||
    f.endsWith('/careerAggregate/shadowEvidence.ts') ||
    /supabase(Batch|Read|Invalidation)?Repository\.ts$/.test(f) || f.endsWith('/supabaseRepository.ts');

  const consumerFiles = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'lib'))]
    .filter((f) => !isNewModuleFile(f));
  const importsNew = (src: string) => NEW_MODULES.some((m) => new RegExp(`from\\s+['"][^'"]*${m}[^'"]*['"]`).test(src));

  const appFiles = consumerFiles.filter((f) => f.startsWith(join(ROOT, 'app')));
  const apiFiles = appFiles.filter((f) => f.startsWith(join(ROOT, 'app/api')));
  const promptFiles = consumerFiles.filter((f) => /prompt/i.test(f));

  check('G1 app/ から新 scaffold import 0', appFiles.filter((f) => importsNew(readFileSync(f, 'utf8'))).length === 0);
  check('G2 app/api/ から import 0', apiFiles.filter((f) => importsNew(readFileSync(f, 'utf8'))).length === 0);
  check('G3 production prompt から import 0', promptFiles.filter((f) => importsNew(readFileSync(f, 'utf8'))).length === 0);
  check('G4 production consumer 全体で import 0', consumerFiles.filter((f) => importsNew(readFileSync(f, 'utf8'))).length === 0);

  const orch = readFileSync(join(ROOT, 'lib/careerContext/orchestrator.ts'), 'utf8');
  check('G5 orchestrator 未変更（新 scaffold 非 import）', !NEW_MODULES.some((m) => orch.includes(m)));

  // env read 制限: config.server / flags.server のみ process.env 可。他は不可。
  const envAllowed = new Set([
    join(ROOT, 'lib/careerDataSpinePolicy/config.server.ts'),
    join(ROOT, 'lib/careerDataSpineGate/flags.server.ts'),
  ]);
  const newFiles = [
    ...walk(join(ROOT, 'lib/careerDataSpineDb')),
    ...walk(join(ROOT, 'lib/careerDataSpinePolicy')),
    ...walk(join(ROOT, 'lib/careerDataSpineGate')),
    ...walk(join(ROOT, 'lib/careerContextLoaders/server')),
    join(ROOT, 'lib/careerAggregate/supabaseBatchRepository.ts'),
    join(ROOT, 'lib/careerAggregate/supabaseReadRepository.ts'),
    join(ROOT, 'lib/careerAggregate/supabaseInvalidationRepository.ts'),
    join(ROOT, 'lib/careerCompanyKnowledge/supabaseRepository.ts'),
    join(ROOT, 'lib/careerCompanyKnowledge/supabaseReadRepository.ts'),
  ].filter((f) => existsSync(f));
  const envOffenders = newFiles.filter((f) => !envAllowed.has(f) && /process\.env/.test(readFileSync(f, 'utf8')));
  check('G6 config/flags 以外は process.env を読まない', envOffenders.length === 0, envOffenders.join(','));

  // client 生成 / supabase import 制限（DB boundary + repos は supabase client を作らない）。
  //   例外（P17-E §4 の sanctioned bridge）: sharedClientAdapter.server は既存 server client factory
  //   （@/lib/supabase/serverClient）を **再利用** する（client 生成はしない）。この 1 ファイルのみ許可。
  const clientImportAllowed = new Set([join(ROOT, 'lib/careerDataSpineDb/sharedClientAdapter.server.ts')]);
  const clientOffenders = newFiles.filter((f) => {
    if (clientImportAllowed.has(f)) {
      // 例外ファイルでも client を **生成** してはいけない（factory 再利用のみ）。
      return /createClient\s*\(/.test(readFileSync(f, 'utf8'));
    }
    const src = readFileSync(f, 'utf8');
    return /createClient\s*\(/.test(src) || /from\s+['"]@\/lib\/(careerSupabase|supabase)\//.test(src);
  });
  check('G7 新 scaffold が supabase client を生成/直 import しない（adapter は factory 再利用のみ許可）', clientOffenders.length === 0, clientOffenders.join(','));
}

// ── run ───────────────────────────────────────────────────────────
(async () => {
  await repositoryChecks();
  await loaderChecks();
  isolationChecks();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
})();

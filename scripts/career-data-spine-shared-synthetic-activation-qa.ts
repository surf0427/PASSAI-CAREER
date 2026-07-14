/*
 * scripts/career-data-spine-shared-synthetic-activation-qa.ts
 *
 * PASSAI CAREER — P17-E / P17-E2 Shared Synthetic Activation 統合 QA。
 *
 * [A] SQL  [B] Client adapters  [C] Composition (gate before privileged client)
 * [D] Seed/validation  [E] Shadow route (static)  [F] Evidence  [G] Isolation
 * [H] Access contradiction  [I] Synthetic query restriction  [J] Canary identity
 *
 * 実 DB / 実 client / network なし。server-only（.server）は source 静的検査 + fake port。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { adaptReadPort, type SupabaseLikeClient } from '@/lib/careerDataSpineDb/client';
import { composeAggregatedInsightShadow } from '@/lib/careerAggregate/server/aggregatedInsightShadowCore';
import { SYNTHETIC_CONSULTATION_ARTIFACT_ID } from '@/lib/careerAggregate/server/runtimeTypes';
import { createSyntheticShadowReadRepository } from '@/lib/careerAggregate/syntheticShadowReadRepository';
import {
  buildShadowEvidence,
  isShadowEvidenceSafe,
  validateShadowEvidence,
  SHADOW_EVIDENCE_ALLOWED_FIELDS,
} from '@/lib/careerAggregate/shadowEvidence';
import { evaluateCanary } from '@/lib/careerDataSpineGate/canary';
import { evaluateSyntheticReadiness, isRealReadyForActivation } from '@/lib/careerDataSpinePolicy/syntheticReadiness';
import { createFakeDb, DS_NOW } from './fixtures/careerDataSpineDbFixtures';
import { syntheticArtifactRow, syntheticBatchRow, syntheticDataset, PROHIBITED_ROW_FIELDS, UUID_RE } from './fixtures/careerAggregateSyntheticDbFixture';
import type { PrivilegedReadResult } from '@/lib/careerAggregate/server/runtimeTypes';
import type { BatchAwareReadResult } from '@/lib/careerAggregate/batchRepository';
import type { ValidAggregateArtifact } from '@/types/careerAggregate';
import type { CanaryDecision } from '@/lib/careerDataSpineGate/canary';
import type { DataSpineReadPort, DbRow } from '@/lib/careerDataSpineDb/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const eligible: CanaryDecision = { eligible: true, reason: 'allowlisted' };
const ineligible: CanaryDecision = { eligible: false, reason: 'not_in_allowlist' };
const CANARY_UUID = '00000000-0000-4000-8000-000000000001';

function fakeClient(result: { data: unknown; error: unknown }): SupabaseLikeClient {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain; builder.eq = chain; builder.in = chain; builder.order = chain; builder.range = chain;
  builder.then = (onf: (r: unknown) => unknown) => Promise.resolve(result).then(onf);
  builder.insert = () => Promise.resolve(result);
  builder.update = chain; builder.upsert = () => Promise.resolve(result);
  return { from: () => builder as never };
}

// shadow target id を持つ artifact row（valid ベース + override）。
function shadowArtifactRow(over: Partial<DbRow> = {}, safeOver: Record<string, unknown> = {}): DbRow {
  const base = syntheticArtifactRow('valid');
  const safe = { ...(base.safe_artifact as Record<string, unknown>), ...safeOver };
  return { ...base, id: SYNTHETIC_CONSULTATION_ARTIFACT_ID, safe_artifact: safe, ...over };
}
function shadowBatchRow(over: Partial<DbRow> = {}): DbRow {
  return { ...syntheticBatchRow('valid'), ...over };
}
function seededDb(artifactRows: DbRow[], batchRows: DbRow[] = [shadowBatchRow()]) {
  const db = createFakeDb();
  db.seed('career_aggregate_artifacts', artifactRows);
  db.seed('career_aggregate_batches', batchRows);
  return db;
}

async function main(): Promise<void> {
  // ══════════════════════════════════════════════════════════════
  console.log('[A] SQL (shared placement / default-deny)');
  {
    const sql = read('supabase/career_aggregated_insight_apply.sql');
    const ddl = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    check('A1 TARGET PROJECT: shared', /TARGET PROJECT: shared/i.test(sql));
    check('A2 auth 依存なし（DDL）', !/auth\.users|auth\.uid/i.test(ddl));
    check('A3 RLS enabled 全 table', (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length === (sql.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length);
    check('A4 CREATE POLICY 0（service_role 向け含む）', !/create\s+policy/i.test(sql));
    check('A5 GRANT なし', !/grant\s+(select|insert|update|all)/i.test(sql));
    check('A6 synthetic classification 列 + CHECK', /data_classification\s+text/i.test(sql) && /'synthetic'/.test(sql) && /'production'/.test(sql));
    check('A7 schema.sql 未統合', !read('supabase/schema.sql').includes('career_aggregate_batches'));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[B] Client adapters (anon adapter / service-role port)');
  {
    const okRes = await adaptReadPort(fakeClient({ data: [{ id: 'x' }], error: null })).select({ table: 't', limit: 10 });
    check('B1 adaptReadPort success → ok', okRes.ok === true);
    const denyRes = await adaptReadPort(fakeClient({ data: null, error: { code: '42501' } })).select({ table: 't', limit: 10 });
    check('B2 adaptReadPort permission denied → error union', denyRes.ok === false && denyRes.error.kind === 'permission_denied');

    const anonAdapter = read('lib/careerDataSpineDb/sharedClientAdapter.server.ts');
    check('B3 anon adapter は server-only', /import\s+['"]server-only['"]/.test(anonAdapter));

    const svc = read('lib/careerDataSpineDb/sharedServiceRolePorts.server.ts');
    check('B4 service-role port は server-only', /import\s+['"]server-only['"]/.test(svc));
    check('B5 既存 service-role factory を再利用', svc.includes('getServiceRoleSupabaseClient'));
    check('B6 service-role client を作らない（createClient なし）', !/createClient\s*\(/.test(svc));
    check('B7 DataSpineReadPort のみ返す（raw client 非漏洩）', svc.includes('DataSpineReadPort') && !/return\s*{\s*status:\s*'available',\s*client/.test(svc));
    check('B8 NEXT_PUBLIC で service-role を参照しない', !/NEXT_PUBLIC[A-Z_]*SERVICE_ROLE/.test(svc));
    check('B9 service-role port は console 出力しない', !/console\.(log|info|warn|error)/.test(svc));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[C] Composition — gate BEFORE privileged client 生成');
  {
    const validArtifact = syntheticArtifactRow('valid').safe_artifact as ValidAggregateArtifact;
    const dummyPort = {} as DataSpineReadPort;
    let clientCalls = 0;
    const resolveAvail = (): PrivilegedReadResult => { clientCalls += 1; return { status: 'available', read: dummyPort }; };
    const resolveMisconfig = (): PrivilegedReadResult => { clientCalls += 1; return { status: 'misconfigured' }; };
    const readSyntheticAvailable = async (): Promise<BatchAwareReadResult> => ({ status: 'available', artifact: validArtifact });
    const base = { runId: 'r1', now: 0, timestamp: '2026-07-13T00:00:00.000Z', latencyMs: 1, readSyntheticArtifact: readSyntheticAvailable };

    clientCalls = 0;
    let ev = await composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: false, consumerFlag: false, syntheticReady: true, canary: eligible, resolvePrivilegedRead: resolveAvail });
    check('C1 flag OFF → flag_off・client 生成 0', ev.gateDecision === 'flag_off' && clientCalls === 0);

    clientCalls = 0;
    ev = await composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: true, consumerFlag: true, syntheticReady: false, canary: eligible, resolvePrivilegedRead: resolveAvail });
    check('C2 readiness false → client 生成 0', ev.gateDecision === 'readiness_not_ready' && clientCalls === 0);

    clientCalls = 0;
    ev = await composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: true, consumerFlag: true, syntheticReady: true, canary: ineligible, resolvePrivilegedRead: resolveAvail });
    check('C3 canary 外 → client 生成 0', ev.gateDecision === 'canary_excluded' && clientCalls === 0);

    clientCalls = 0;
    ev = await composeAggregatedInsightShadow({ ...base, mode: 'real', masterFlag: true, consumerFlag: true, syntheticReady: true, canary: eligible, resolvePrivilegedRead: resolveAvail });
    check('C4 real mode → blocked・client 生成 0', ev.gateDecision === 'real_mode_blocked' && clientCalls === 0);

    clientCalls = 0;
    ev = await composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: true, consumerFlag: true, syntheticReady: true, canary: eligible, resolvePrivilegedRead: resolveMisconfig });
    check('C5 全 gate 通過だが service-role misconfigured → unavailable（client 生成 1・raw error なし）', ev.gateDecision === 'passed' && ev.sourceStatus === 'unavailable' && ev.errorCategory === 'dependency_unavailable' && clientCalls === 1);

    clientCalls = 0;
    ev = await composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: true, consumerFlag: true, syntheticReady: true, canary: eligible, resolvePrivilegedRead: resolveAvail });
    check('C6 全 gate 通過 + available → rendered/disclaimer・client 生成 1', ev.gateDecision === 'passed' && ev.sourceStatus === 'available' && ev.rendered && ev.disclaimerPresent && clientCalls === 1);
    check('C7 evidence safe + access_path 記録', isShadowEvidenceSafe(ev) && ev.accessPath === 'server_service_role' && ev.identitySource === 'shared_auth_session' && ev.syntheticQueryEnforced === true);
    check('C8 evidence validator = PASS', validateShadowEvidence(ev).verdict === 'PASS');

    const cfg = { target_project: true, identity_strategy: true, table_placement: true } as const;
    check('C9 synthetic readiness → ready / real → NOT ready', evaluateSyntheticReadiness(cfg).ready === true && isRealReadyForActivation(cfg) === false);
    check('C10 canary wildcard/self-report 拒否', evaluateCanary('*', CANARY_UUID).eligible === false && evaluateCanary(CANARY_UUID, 'self').eligible === false);
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[D] Seed / validation');
  {
    const ds = syntheticDataset();
    check('D1 全ケース', ds.length === 5);
    check('D2 deterministic', JSON.stringify(ds) === JSON.stringify(syntheticDataset()));
    check('D3 synthetic marker', ds.every((e) => e.batch.data_classification === 'synthetic' && e.artifact.data_classification === 'synthetic'));
    check('D4 禁止 identity field なし', ds.every((e) => ![...Object.keys(e.batch), ...Object.keys(e.artifact)].some((k) => PROHIBITED_ROW_FIELDS.includes(k))));
    // P17-E3: uuid 型契約（uuid 列は有効 UUID・FK 一致・idempotency_key は text）。
    const batchIds = new Set(ds.map((e) => String(e.batch.id)));
    check('D5 batch.id / artifact.id / batch_id が全て UUID', ds.every((e) => UUID_RE.test(String(e.batch.id)) && UUID_RE.test(String(e.artifact.id)) && UUID_RE.test(String(e.artifact.batch_id))));
    check('D6 artifact.batch_id が既存 batch.id を参照（FK 整合）', ds.every((e) => e.artifact.batch_id === e.batch.id && batchIds.has(String(e.artifact.batch_id))));
    check('D7 idempotency_key は text（UUID でない・synthetic marker）', ds.every((e) => !UUID_RE.test(String(e.batch.idempotency_key)) && String(e.batch.idempotency_key).includes('synthetic')));
    check('D8 UUID は case 間で衝突しない', new Set([...ds.map((e) => String(e.batch.id)), ...ds.map((e) => String(e.artifact.id))]).size === ds.length * 2);
    const seedSrc = read('scripts/career-data-spine-l4-synthetic-seed.ts');
    check('D9 seed は DB 接続しない', !/from\s+['"]@\/lib\/(supabase|careerSupabase)/.test(seedSrc));
    check('D10 seed は REVIEW ONLY', seedSrc.includes('REVIEW ONLY') || seedSrc.includes('DO NOT AUTO-APPLY'));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[E] Shadow route (static)');
  {
    const route = read('app/api/career/consultation/route.ts');
    check('E1 route は shadow dispatcher を import', route.includes('dispatchAggregatedInsightConsultationShadow'));
    check('E2 shadow は void（fire-and-forget）', /void\s+dispatchAggregatedInsightConsultationShadow/.test(route));
    check('E3 route が renderer/repo を直 import しない', !route.includes('aggregatedInsightConsultation') && !route.includes('syntheticShadowReadRepository'));
    check('E4 response schema 不変', route.includes('Response.json({ result })'));
    const disp = read('lib/careerAggregate/shadowDispatcher.server.ts');
    check('E5 dispatcher server-only + flag OFF 即 return + timeout + never-throw', /import\s+['"]server-only['"]/.test(disp) && disp.includes('isAggregatedInsightReadEnabled') && /setTimeout|withTimeout/.test(disp) && /catch\s*\{/.test(disp));
    const prompt = read('app/api/career/consultation/consultationPrompt.ts');
    check('E6 consultation prompt が Aggregated Insight を import しない', !/careerAggregate|aggregatedInsight|AggregatedInsight/i.test(prompt));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[F] Evidence');
  {
    const good = buildShadowEvidence({ runId: 'r', sourceStatus: 'available', rendered: true, byteCount: 200, disclaimerPresent: true, gateDecision: 'passed', latencyMs: 10, errorCategory: 'none', metricKey: 'feature_usage_prevalence', calculationVersion: 'feature_usage_prevalence@1', timestamp: '2026-07-13T00:00:00.000Z' });
    check('F1 evidence は許可 field のみ', Object.keys(good).every((k) => SHADOW_EVIDENCE_ALLOWED_FIELDS.includes(k)));
    check('F2 PASS + access_path/rls_mode/identity_source/synthetic_query_enforced', validateShadowEvidence(good).verdict === 'PASS' && good.accessPath === 'server_service_role' && good.rlsMode === 'default_deny_bypassed_server_only');
    check('F3 prompt 変化 → STOP', validateShadowEvidence({ ...good, promptChanged: true }).verdict === 'STOP');
    check('F4 禁止 field 混入 → STOP', validateShadowEvidence({ ...good, email: 'x@y.z' }).verdict === 'STOP');
    check('F5 non-service-role access → STOP', validateShadowEvidence({ ...good, accessPath: 'anon_client' as never }).verdict === 'STOP');
    check('F6 non-shared identity → STOP', validateShadowEvidence({ ...good, identitySource: 'career_otp' as never }).verdict === 'STOP');
    check('F7 flag_off → INCOMPLETE', validateShadowEvidence(buildShadowEvidence({ runId: 'r', sourceStatus: 'not_run', rendered: false, byteCount: 0, disclaimerPresent: false, gateDecision: 'flag_off', latencyMs: 1, errorCategory: 'none' })).verdict === 'INCOMPLETE');
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[G] Isolation');
  {
    const NEW = [
      'lib/careerDataSpineDb/sharedServiceRolePorts.server.ts',
      'lib/careerAggregate/syntheticShadowReadRepository.ts',
      'lib/careerAggregate/server/aggregatedInsightShadowCore.ts',
      'lib/careerAggregate/server/createAggregatedInsightRuntime.server.ts',
      'lib/careerAggregate/shadowDispatcher.server.ts',
      'lib/careerAggregate/shadowEvidence.ts',
    ].map((f) => join(ROOT, f));
    const forbidden = ['careerCompanyKnowledge', 'careerMemory', '@/lib/ai', 'anthropic', 'career_user_events'];
    check('G1 新モジュールが L5/PM/外部AI/実 EventLog を import しない', NEW.filter((f) => existsSync(f) && forbidden.some((m) => readFileSync(f, 'utf8').includes(m))).length === 0);
    check('G2 Orchestrator が shadow/adapter を import しない', !read('lib/careerContext/orchestrator.ts').includes('shadow') && !read('lib/careerContext/orchestrator.ts').includes('ServiceRole'));
    check('G3 NEXT_PUBLIC service-role 参照 0', NEW.every((f) => !existsSync(f) || !/NEXT_PUBLIC[A-Z_]*SERVICE_ROLE/.test(readFileSync(f, 'utf8'))));
    const core = read('lib/careerAggregate/server/aggregatedInsightShadowCore.ts');
    check('G4 shadow core が real event を read しない', !core.includes('career_user_events') && !core.includes('careerEvents'));
    // raw client 非漏洩: 合成 read repo は DataSpineReadPort を受け取り raw SupabaseClient を受け取らない。
    const synRepo = read('lib/careerAggregate/syntheticShadowReadRepository.ts');
    check('G5 synthetic repo は DataSpineReadPort を受け取る（raw client 非受領）', synRepo.includes('DataSpineReadPort') && !/SupabaseClient/.test(synRepo));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[H] Access contradiction (anon 不可 / service-role 可)');
  {
    // anon 相当: permission_denied → synthetic repo は unavailable（policy 0 で read 不能を再現）。
    const denyDb = createFakeDb({ errorTables: { career_aggregate_artifacts: { kind: 'permission_denied', table: 'career_aggregate_artifacts' } } });
    const denyRes = await createSyntheticShadowReadRepository(denyDb.read).readSyntheticShadowArtifact(DS_NOW);
    check('H1 anon/permission_denied → unavailable（read 不可）', denyRes.status === 'unavailable');

    // service-role 相当（RLS bypass）: fake port が synthetic row を返す → available。
    const okDb = seededDb([shadowArtifactRow()]);
    const okRes = await createSyntheticShadowReadRepository(okDb.read).readSyntheticShadowArtifact(DS_NOW);
    check('H2 service-role read（synthetic）→ available', okRes.status === 'available');
    check('H3 available payload に identity/raw を含めない', !JSON.stringify(okRes).toLowerCase().includes('user_id') && !JSON.stringify(okRes).includes('opaque'));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[I] Synthetic query restriction');
  {
    const syn = (rows: DbRow[], batches: DbRow[] = [shadowBatchRow()]) =>
      createSyntheticShadowReadRepository(seededDb(rows, batches).read).readSyntheticShadowArtifact(DS_NOW);

    check('I1 valid synthetic → available', (await syn([shadowArtifactRow()])).status === 'available');
    check('I2 production classification → 取得しない（missing）', (await syn([shadowArtifactRow({ data_classification: 'production' })])).status === 'missing');
    check('I3 unknown classification → 取得しない', (await syn([shadowArtifactRow({ data_classification: '' })])).status === 'missing');
    check('I4 invalidated → 取得しない（filter 除外）', (await syn([shadowArtifactRow({ invalidated: true })])).status === 'missing');
    check('I5 duplicate（同 id 2 行）→ blocked', (await syn([shadowArtifactRow(), shadowArtifactRow()])).status === 'blocked');
    check('I6 stale（expiry 過去）→ stale', (await syn([shadowArtifactRow({ expires_at: '2026-07-02T00:00:00.000Z' }, { expiresAt: '2026-07-02T00:00:00.000Z' })])).status === 'stale');
    check('I7 malformed payload → unavailable（fail-closed）', (await syn([shadowArtifactRow({}, { kind: 'weird' })])).status === 'unavailable');
    check('I8 batch も synthetic 必須（batch=production → unavailable）', (await syn([shadowArtifactRow()], [shadowBatchRow({ data_classification: 'production' })])).status === 'unavailable');
    // query が limit を持ち deterministic order（source 静的）。
    const src = read('lib/careerAggregate/syntheticShadowReadRepository.ts');
    check('I9 query は synthetic filter + limit + order を持つ', /data_classification:\s*SYNTHETIC/.test(src) && /limit:\s*2/.test(src) && /order:/.test(src));
    check('I10 production を絶対返さない旨の二重防御', src.includes("!== SYNTHETIC"));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[J] Canary identity (shared auth UID)');
  {
    const runtime = read('lib/careerAggregate/server/createAggregatedInsightRuntime.server.ts');
    check('J1 shared auth UID を使う（getServerSupabaseClient）', runtime.includes('getServerSupabaseClient') && runtime.includes('resolveSharedAuthUserId'));
    // CAREER OTP を「import しない」ことを検査（コメント中の語ではなく実 import 文）。
    check('J2 CAREER OTP UID を使わない（careerSupabase を import しない）', !/from\s+['"]@\/lib\/careerSupabase/.test(runtime) && !/from\s+['"][^'"]*CareerAuthProvider/.test(runtime));
    check('J3 email join を実装しない（実コード）', !/\.eq\(['"]email/.test(runtime) && !/from\s+['"][^'"]*email/i.test(runtime));
    check('J4 UID を evidence/console/response へ出さない', !runtime.includes('console.') && !/return[^;]*uid/i.test(runtime));
    check('J5 SharedAuthUserId 型が存在', read('lib/careerAggregate/server/runtimeTypes.ts').includes('SharedAuthUserId'));
    // shared UID が空/malformed/wildcard は fail-closed（canary が判定）。
    check('J6 shared UID 不明 → canary invalid_user', evaluateCanary(CANARY_UUID, null).eligible === false);
    check('J7 anonymous でも uid があれば allowlist 一致で eligible', evaluateCanary(CANARY_UUID, CANARY_UUID).eligible === true);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UNEXPECTED', err);
  process.exit(1);
});

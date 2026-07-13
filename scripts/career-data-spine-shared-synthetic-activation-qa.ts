/*
 * scripts/career-data-spine-shared-synthetic-activation-qa.ts
 *
 * PASSAI CAREER — P17-E Shared Synthetic Activation 統合 QA。
 *
 * [A] SQL  [B] Client adapter  [C] Composition (compose core)  [D] Seed/validation
 * [E] Shadow route (static)  [F] Evidence  [G] Isolation
 *
 * 実 DB / 実 client / network なし。server-only（.server）ファイルは source 静的検査。
 * 使い方: npx tsx scripts/career-data-spine-shared-synthetic-activation-qa.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { adaptReadPort, type SupabaseLikeClient } from '@/lib/careerDataSpineDb/client';
import { composeAggregatedInsightShadow } from '@/lib/careerAggregate/server/aggregatedInsightShadowCore';
import { SYNTHETIC_CONSULTATION_ARTIFACT_ID } from '@/lib/careerAggregate/server/runtimeTypes';
import {
  buildShadowEvidence,
  isShadowEvidenceSafe,
  validateShadowEvidence,
  SHADOW_EVIDENCE_ALLOWED_FIELDS,
} from '@/lib/careerAggregate/shadowEvidence';
import { evaluateCanary } from '@/lib/careerDataSpineGate/canary';
import { evaluateSyntheticReadiness, isRealReadyForActivation } from '@/lib/careerDataSpinePolicy/syntheticReadiness';
import { syntheticArtifactRow, syntheticDataset, PROHIBITED_ROW_FIELDS } from './fixtures/careerAggregateSyntheticDbFixture';
import type { BatchAwareReadResult } from '@/lib/careerAggregate/batchRepository';
import type { ValidAggregateArtifact } from '@/types/careerAggregate';
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

async function main(): Promise<void> {
  // ══════════════════════════════════════════════════════════════
  console.log('[A] SQL (shared placement)');
  {
    const sql = read('supabase/career_aggregated_insight_apply.sql');
    // コメント行（-- ...）は除外して DDL のみを検査する。
    const ddl = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    check('A1 TARGET PROJECT: shared 明記', /TARGET PROJECT: shared/i.test(sql));
    check('A2 NOT APPLIED header', sql.includes('NOT APPLIED'));
    check('A3 auth.users / auth.uid 依存なし（DDL）', !/auth\.users|auth\.uid/i.test(ddl));
    check('A4 career_personal_memory 参照なし', !sql.includes('career_personal_memory'));
    check('A5 RLS enabled 全 table', (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length === (sql.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length);
    check('A6 default deny（CREATE POLICY / GRANT なし）', !/create\s+policy/i.test(sql) && !/grant\s+(select|insert|update|all)/i.test(sql));
    check('A7 禁止 column 定義なし', !/\buser_id\s+(uuid|text)/i.test(sql) && !/\bemail\s+text/i.test(sql));
    check('A8 synthetic classification 列', /data_classification\s+text/i.test(sql) && /'synthetic'/.test(sql));
    check('A9 idempotency UNIQUE(idempotency_key)', /UNIQUE\s*\(\s*idempotency_key\s*\)/i.test(sql));
    check('A10 INTERVAL retention hardcode なし', !/\bINTERVAL\b/i.test(sql));
    check('A11 schema.sql へ未統合', !read('supabase/schema.sql').includes('career_aggregate_batches'));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[B] Client adapter');
  {
    const okRes = await adaptReadPort(fakeClient({ data: [{ id: 'x' }], error: null })).select({ table: 't', limit: 10 });
    check('B1 success → ok rows', okRes.ok === true);
    const denyRes = await adaptReadPort(fakeClient({ data: null, error: { code: '42501' } })).select({ table: 't', limit: 10 });
    check('B2 permission denied → error union', denyRes.ok === false && denyRes.error.kind === 'permission_denied');
    const missRes = await adaptReadPort(fakeClient({ data: null, error: { code: '42P01' } })).select({ table: 't', limit: 10 });
    check('B3 table missing → error union', missRes.ok === false && missRes.error.kind === 'table_missing');

    const adapter = read('lib/careerDataSpineDb/sharedClientAdapter.server.ts');
    check('B4 sharedClientAdapter は server-only', /import\s+['"]server-only['"]/.test(adapter));
    check('B5 既存 server client factory 再利用', adapter.includes('getServerSupabaseClient'));
    check('B6 browser client を使わない', !adapter.includes('browserClient'));
    check('B7 URL/key/session をログに出さない', !/console\.(log|info|warn|error)/.test(adapter));
    check('B8 process.env を直接読まない', !/process\.env/.test(adapter));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[C] Composition (compose core・gate before query)');
  {
    const validArtifact = syntheticArtifactRow('valid').safe_artifact as ValidAggregateArtifact;
    let calls = 0;
    const spy = async (): Promise<BatchAwareReadResult> => { calls += 1; return { status: 'available', artifact: validArtifact }; };
    const base = { runId: 'r1', artifactId: SYNTHETIC_CONSULTATION_ARTIFACT_ID, now: 0, timestamp: '2026-07-13T00:00:00.000Z', latencyMs: 1 };

    calls = 0;
    let ev = await composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: false, consumerFlag: false, syntheticReady: true, canary: eligible, readArtifact: spy });
    check('C1 flag OFF → gate=flag_off・query 0', ev.gateDecision === 'flag_off' && calls === 0);

    calls = 0;
    ev = await composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: true, consumerFlag: true, syntheticReady: false, canary: eligible, readArtifact: spy });
    check('C2 readiness false → gate=readiness・query 0', ev.gateDecision === 'readiness_not_ready' && calls === 0);

    calls = 0;
    ev = await composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: true, consumerFlag: true, syntheticReady: true, canary: ineligible, readArtifact: spy });
    check('C3 canary 外 → gate=canary・query 0', ev.gateDecision === 'canary_excluded' && calls === 0);

    calls = 0;
    ev = await composeAggregatedInsightShadow({ ...base, mode: 'real', masterFlag: true, consumerFlag: true, syntheticReady: true, canary: eligible, readArtifact: spy });
    check('C4 real mode → blocked・query 0', ev.gateDecision === 'real_mode_blocked' && calls === 0);

    calls = 0;
    ev = await composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: true, consumerFlag: true, syntheticReady: true, canary: eligible, readArtifact: null });
    check('C5 dependency 無し → passed だが unavailable（fail-closed）', ev.gateDecision === 'passed' && ev.sourceStatus === 'unavailable' && ev.errorCategory === 'dependency_unavailable');

    calls = 0;
    ev = await composeAggregatedInsightShadow({ ...base, mode: 'synthetic_only', masterFlag: true, consumerFlag: true, syntheticReady: true, canary: eligible, readArtifact: spy });
    check('C6 全 gate 通過 + available → rendered/disclaimer/query 1', ev.gateDecision === 'passed' && ev.sourceStatus === 'available' && ev.rendered === true && ev.disclaimerPresent === true && calls === 1);
    check('C7 evidence は safe', isShadowEvidenceSafe(ev));
    check('C8 evidence validator = PASS', validateShadowEvidence(ev).verdict === 'PASS');

    const cfg = { target_project: true, identity_strategy: true, table_placement: true } as const;
    check('C9 synthetic readiness（非法務3項目）→ ready', evaluateSyntheticReadiness(cfg).ready === true);
    check('C10 同 config で real readiness → NOT ready（12項目）', isRealReadyForActivation(cfg) === false);
    check('C11 synthetic result は mode=synthetic brand', evaluateSyntheticReadiness(cfg).mode === 'synthetic');
    check('C12 canary は wildcard/self-report 拒否', evaluateCanary('*', CANARY_UUID).eligible === false && evaluateCanary(CANARY_UUID, 'self').eligible === false);
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[D] Seed / validation');
  {
    const ds = syntheticDataset();
    check('D1 全ケース(valid/suppressed/stale/invalidated/incomplete)', ds.length === 5);
    check('D2 deterministic', JSON.stringify(ds) === JSON.stringify(syntheticDataset()));
    check('D3 synthetic marker', ds.every((e) => e.batch.data_classification === 'synthetic' && e.artifact.data_classification === 'synthetic'));
    check('D4 禁止 identity field なし', ds.every((e) => ![...Object.keys(e.batch), ...Object.keys(e.artifact)].some((k) => PROHIBITED_ROW_FIELDS.includes(k))));
    const dsBlob = JSON.stringify(ds).toLowerCase();
    check('D5 raw identity 値なし', !/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(dsBlob) && !/\buser_id\b/.test(dsBlob) && !dsBlob.includes('"email"'));
    const seedSrc = read('scripts/career-data-spine-l4-synthetic-seed.ts');
    check('D6 seed は DB 接続しない', !/from\s+['"]@\/lib\/(supabase|careerSupabase)/.test(seedSrc) && !/createClient/.test(seedSrc));
    check('D7 seed は REVIEW ONLY 明記', seedSrc.includes('REVIEW ONLY') || seedSrc.includes('DO NOT AUTO-APPLY'));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[E] Shadow route (static)');
  {
    const route = read('app/api/career/consultation/route.ts');
    check('E1 route は shadow dispatcher を import', route.includes('dispatchAggregatedInsightConsultationShadow'));
    check('E2 shadow は void（fire-and-forget）', /void\s+dispatchAggregatedInsightConsultationShadow/.test(route));
    check('E3 route が renderer/projection/repo を直 import しない', !route.includes('aggregatedInsightConsultation') && !route.includes('supabaseReadRepository'));
    check('E4 response schema 不変（Response.json({ result })）', route.includes('Response.json({ result })'));
    check('E5 systemPrompt は buildConsultationSystemPrompt のまま', route.includes('buildConsultationSystemPrompt('));
    const disp = read('lib/careerAggregate/shadowDispatcher.server.ts');
    check('E6 dispatcher は server-only', /import\s+['"]server-only['"]/.test(disp));
    check('E7 dispatcher は flag OFF で即 return', disp.includes('isAggregatedInsightReadEnabled') && disp.includes('return'));
    check('E8 dispatcher は timeout を持つ', /setTimeout|withTimeout/.test(disp));
    check('E9 dispatcher は never-throw', /catch\s*\{/.test(disp));
    const prompt = read('app/api/career/consultation/consultationPrompt.ts');
    check('E10 consultation prompt が Aggregated Insight を import しない', !/careerAggregate|aggregatedInsight|AggregatedInsight/i.test(prompt));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[F] Evidence');
  {
    const good = buildShadowEvidence({ runId: 'r', sourceStatus: 'available', rendered: true, byteCount: 200, disclaimerPresent: true, gateDecision: 'passed', latencyMs: 10, errorCategory: 'none', metricKey: 'feature_usage_prevalence', calculationVersion: 'feature_usage_prevalence@1', timestamp: '2026-07-13T00:00:00.000Z' });
    check('F1 evidence は許可 field のみ', Object.keys(good).every((k) => SHADOW_EVIDENCE_ALLOWED_FIELDS.includes(k)));
    check('F2 PASS', validateShadowEvidence(good).verdict === 'PASS');
    check('F3 rollbackReady=true', good.rollbackReady === true);
    check('F4 prompt 変化 → STOP', validateShadowEvidence({ ...good, promptChanged: true }).verdict === 'STOP');
    check('F5 禁止 field 混入 → STOP', validateShadowEvidence({ ...good, email: 'x@y.z' }).verdict === 'STOP' && isShadowEvidenceSafe({ ...good, email: 'x@y.z' }) === false);
    check('F6 flag_off → INCOMPLETE', validateShadowEvidence(buildShadowEvidence({ runId: 'r', sourceStatus: 'not_run', rendered: false, byteCount: 0, disclaimerPresent: false, gateDecision: 'flag_off', latencyMs: 1, errorCategory: 'none' })).verdict === 'INCOMPLETE');
    check('F7 dependency 未接続 → INCOMPLETE', validateShadowEvidence(buildShadowEvidence({ runId: 'r', sourceStatus: 'unavailable', rendered: false, byteCount: 0, disclaimerPresent: false, gateDecision: 'passed', latencyMs: 1, errorCategory: 'dependency_unavailable' })).verdict === 'INCOMPLETE');
  }

  // ══════════════════════════════════════════════════════════════
  console.log('[G] Isolation');
  {
    const NEW_SERVER_FILES = [
      'lib/careerDataSpineDb/sharedClientAdapter.server.ts',
      'lib/careerAggregate/server/createAggregatedInsightRuntime.server.ts',
      'lib/careerAggregate/server/aggregatedInsightShadowCore.ts',
      'lib/careerAggregate/server/runtimeTypes.ts',
      'lib/careerAggregate/shadowDispatcher.server.ts',
      'lib/careerAggregate/shadowEvidence.ts',
      'lib/careerDataSpinePolicy/syntheticReadiness.ts',
    ].map((f) => join(ROOT, f));
    const forbidden = ['careerCompanyKnowledge', 'careerMemory', 'careerEvents', '@/lib/ai', 'anthropic', 'career_user_events'];
    const offenders = NEW_SERVER_FILES.filter((f) => existsSync(f) && forbidden.some((m) => readFileSync(f, 'utf8').includes(m)));
    check('G1 shadow モジュールが L5/PM/EventLog/外部AI を import しない', offenders.length === 0, offenders.join(','));
    const orch = read('lib/careerContext/orchestrator.ts');
    check('G2 Orchestrator が shadow/adapter を import しない', !orch.includes('shadowDispatcher') && !orch.includes('AggregatedInsightRuntime') && !orch.includes('sharedClientAdapter'));
    const route = read('app/api/career/consultation/route.ts');
    check('G3 route が shadow 結果を prompt/response へ渡さない', !/Response\.json\([^)]*shadow/i.test(route) && !/system:\s*\w*shadow/i.test(route));
    const core = read('lib/careerAggregate/server/aggregatedInsightShadowCore.ts');
    check('G4 shadow core が real event を read しない', !core.includes('career_user_events') && !core.includes('careerEvents'));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UNEXPECTED', err);
  process.exit(1);
});

/*
 * scripts/career-data-spine-l4-synthetic-validate.ts
 *
 * PASSAI CAREER — Layer 4 synthetic fixture / round-trip validator（P17-E §6）。
 *
 * 実 DB へ接続しない。fixture の row shape / classification / prohibited fields /
 * batch-artifact consistency と、fake port 経由の supabase read repository round-trip
 * （available / suppressed / stale / invalidated / incomplete mapping）を検証する。
 *
 * 使い方: npx tsx scripts/career-data-spine-l4-synthetic-validate.ts
 */

import { createFakeDb } from './fixtures/careerDataSpineDbFixtures';
import {
  syntheticDataset,
  EXPECTED_READ_STATUS,
  PROHIBITED_ROW_FIELDS,
  UUID_RE,
  type SyntheticCase,
} from './fixtures/careerAggregateSyntheticDbFixture';
import { createSupabaseAggregateReadRepository } from '@/lib/careerAggregate/supabaseReadRepository';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const ds = syntheticDataset();

  console.log('[1] fixture row shape / classification / UUID type contract / prohibited fields');
  const allBatchIds = new Set(ds.map((e) => String(e.batch.id)));
  for (const e of ds) {
    check(`${e.case}: batch data_classification=synthetic`, e.batch.data_classification === 'synthetic');
    check(`${e.case}: artifact data_classification=synthetic`, e.artifact.data_classification === 'synthetic');
    // ── UUID 型契約（uuid 列は有効 UUID・FK 一致）──
    check(`${e.case}: batch.id は UUID`, UUID_RE.test(String(e.batch.id)));
    check(`${e.case}: artifact.id は UUID`, UUID_RE.test(String(e.artifact.id)));
    check(`${e.case}: artifact.batch_id は UUID`, UUID_RE.test(String(e.artifact.batch_id)));
    check(`${e.case}: artifact.batch_id が batch.id と一致（FK）`, e.artifact.batch_id === e.batch.id);
    check(`${e.case}: batch_id は既存 batch を参照`, allBatchIds.has(String(e.artifact.batch_id)));
    // idempotency_key は text（人間可読・UUID でなくてよい）。
    check(`${e.case}: idempotency_key は text marker`, typeof e.batch.idempotency_key === 'string' && String(e.batch.idempotency_key).includes('synthetic'));
    const keys = [...Object.keys(e.batch), ...Object.keys(e.artifact)];
    check(`${e.case}: 禁止 identity field なし`, !keys.some((k) => PROHIBITED_ROW_FIELDS.includes(k)));
    const blob = JSON.stringify(e).toLowerCase();
    check(`${e.case}: raw identity 値なし`, !/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(blob) && !/\buser_id\b/.test(blob) && !blob.includes('"email"'));
  }
  // batch id / artifact id が case 間で衝突しない。
  check('id 衝突なし（batch/artifact 全 UUID がユニーク）',
    new Set([...ds.map((e) => String(e.batch.id)), ...ds.map((e) => String(e.artifact.id))]).size === ds.length * 2);

  console.log('[2] round-trip mapping via fake port + supabase read repository');
  const now = Date.parse('2026-07-13T00:00:00.000Z');
  for (const e of ds) {
    const db = createFakeDb();
    db.seed('career_aggregate_batches', [e.batch]);
    db.seed('career_aggregate_artifacts', [e.artifact]);
    const repo = createSupabaseAggregateReadRepository(db.read);
    const res = await repo.readArtifact(String(e.artifact.id), now);
    const expected = EXPECTED_READ_STATUS[e.case as SyntheticCase];
    check(`${e.case}: read status = ${expected}`, res.status === expected, `got ${res.status}`);
    if (res.status === 'available') {
      check(`${e.case}: available payload に user_id なし`, !JSON.stringify(res).toLowerCase().includes('user_id'));
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UNEXPECTED', err);
  process.exit(1);
});

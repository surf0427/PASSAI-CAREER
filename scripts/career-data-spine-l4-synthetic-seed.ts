/*
 * scripts/career-data-spine-l4-synthetic-seed.ts
 *
 * PASSAI CAREER — Layer 4 synthetic seed（P17-E §6・Option A: reviewable SQL 出力のみ）。
 *
 * ⚠ Claude Code は本番 DB へ接続しない。本 script は **INSERT 文を stdout へ出力するだけ**。
 *   operator が review して Supabase SQL Editor で手動適用する（自動適用しない）。
 *
 * synthetic data のみ / 非 PII / deterministic。
 *
 * 使い方: npx tsx scripts/career-data-spine-l4-synthetic-seed.ts   # SQL を表示
 */

import { syntheticDataset } from './fixtures/careerAggregateSyntheticDbFixture';
import type { DbRow } from '@/lib/careerDataSpineDb/types';

function sqlVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function insertStmt(table: string, row: DbRow): string {
  const cols = Object.keys(row);
  const vals = cols.map((c) => sqlVal(row[c]));
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
}

const ds = syntheticDataset();

const out: string[] = [
  '-- ============================================================',
  '-- Layer 4 SYNTHETIC seed (P17-E) — REVIEW ONLY, DO NOT AUTO-APPLY',
  '-- synthetic data のみ・非 PII・data_classification=synthetic。',
  '-- 適用は operator が Supabase SQL Editor で手動実行（Operator Packet Phase 8）。',
  '-- rollback: DELETE ... WHERE data_classification = \'synthetic\';（Phase 15）',
  '-- ============================================================',
  'BEGIN;',
  '-- batches（dependency order: artifacts より先）',
  ...ds.map((e) => insertStmt('career_aggregate_batches', e.batch)),
  '-- artifacts',
  ...ds.map((e) => insertStmt('career_aggregate_artifacts', e.artifact)),
  'COMMIT;',
];

console.log(out.join('\n'));

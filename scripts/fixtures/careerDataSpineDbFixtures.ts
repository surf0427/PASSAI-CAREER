/*
 * scripts/fixtures/careerDataSpineDbFixtures.ts
 *
 * PASSAI CAREER — Data Spine production scaffold synthetic fixtures（P17-C・dev-only）。
 *
 * ネットワーク・実 Supabase を使わない fake DB port（in-memory）と row builder。
 * 合成 ID のみ。実 project ref / URL / key を含めない。
 */

import type {
  DataSpineBatchPort,
  DataSpineReadPort,
  DataSpineWritePort,
  DbFilter,
  DbRow,
  DbSelect,
  DbSelectResult,
  DbWriteResult,
} from '@/lib/careerDataSpineDb/types';
import type { DataSpineDbError } from '@/lib/careerDataSpineDb/errors';

function matchesFilter(row: DbRow, filter: DbFilter): boolean {
  if (filter.eq) {
    for (const [k, v] of Object.entries(filter.eq)) {
      if (row[k] !== v) return false;
    }
  }
  if (filter.in) {
    const val = row[filter.in.column];
    if (!filter.in.values.includes(val as string | number)) return false;
  }
  return true;
}

export type FakeDbOptions = {
  /** 特定 table のアクセスを error にする（table_missing / permission_denied 等の再現）。 */
  errorTables?: Record<string, DataSpineDbError>;
};

export type FakeDb = {
  read: DataSpineReadPort;
  write: DataSpineWritePort;
  batch: DataSpineBatchPort;
  seed(table: string, rows: readonly DbRow[]): void;
  dump(table: string): DbRow[];
};

export function createFakeDb(opts: FakeDbOptions = {}): FakeDb {
  const tables = new Map<string, DbRow[]>();
  const errFor = (table: string): DataSpineDbError | null => opts.errorTables?.[table] ?? null;

  const read: DataSpineReadPort = {
    async select(q: DbSelect): Promise<DbSelectResult> {
      const err = errFor(q.table);
      if (err) return { ok: false, error: err };
      let rows = (tables.get(q.table) ?? []).filter((r) => matchesFilter(r, q));
      if (q.order) {
        const col = q.order.column;
        rows = [...rows].sort((a, b) => {
          const av = String(a[col] ?? '');
          const bv = String(b[col] ?? '');
          return (av < bv ? -1 : av > bv ? 1 : 0) * (q.order!.ascending ? 1 : -1);
        });
      }
      const offset = q.offset ?? 0;
      return { ok: true, rows: rows.slice(offset, offset + q.limit) };
    },
  };

  const write: DataSpineWritePort = {
    async insert(table: string, rows: readonly DbRow[]): Promise<DbWriteResult> {
      const err = errFor(table);
      if (err) return { ok: false, error: err };
      const cur = tables.get(table) ?? [];
      tables.set(table, [...cur, ...rows]);
      return { ok: true, affected: rows.length };
    },
    async update(table: string, patch: DbRow, where: DbFilter): Promise<DbWriteResult> {
      const err = errFor(table);
      if (err) return { ok: false, error: err };
      const cur = tables.get(table) ?? [];
      let affected = 0;
      const next = cur.map((r) => {
        if (matchesFilter(r, where)) {
          affected += 1;
          return { ...r, ...patch };
        }
        return r;
      });
      tables.set(table, next);
      return { ok: true, affected };
    },
  };

  const batch: DataSpineBatchPort = {
    ...write,
    async upsert(table: string, rows: readonly DbRow[], conflictColumn: string): Promise<DbWriteResult> {
      const err = errFor(table);
      if (err) return { ok: false, error: err };
      const cur = tables.get(table) ?? [];
      const byKey = new Map(cur.map((r) => [String(r[conflictColumn]), r]));
      for (const r of rows) byKey.set(String(r[conflictColumn]), r);
      tables.set(table, Array.from(byKey.values()));
      return { ok: true, affected: rows.length };
    },
  };

  return {
    read,
    write,
    batch,
    seed(table, rows) {
      tables.set(table, [...(tables.get(table) ?? []), ...rows]);
    },
    dump(table) {
      return [...(tables.get(table) ?? [])];
    },
  };
}

// ── row builders ─────────────────────────────────────────────────────
export const DS_NOW = Date.parse('2026-07-13T00:00:00.000Z');
export const DS_NOW_ISO = '2026-07-13T00:00:00.000Z';

/** Layer 4: valid batch row。 */
export function batchRow(over: Partial<DbRow> = {}): DbRow {
  return {
    id: 'batch-1',
    idempotency_key: 'idem-1',
    metric_key: 'feature_usage_prevalence',
    calculation_version: 'feature_usage_prevalence@1',
    policy_version: 1,
    source_window_start: '2026-05-01T00:00:00.000Z',
    source_window_end: '2026-06-01T00:00:00.000Z',
    input_watermark: '2026-06-02T00:00:00.000Z',
    consent_snapshot_version: 'cs-1',
    status: 'completed',
    validation_state: 'valid',
    publish_state: 'published',
    incomplete_reason: '',
    source_event_count_bucket: '100–499',
    eligible_event_count_bucket: '50–99',
    suppressed_result_count: 0,
    rollback_reason: '',
    started_at: '2026-07-01T00:00:00.000Z',
    completed_at: '2026-07-01T01:00:00.000Z',
    ...over,
  };
}

/** Layer 4: artifact row（safe_artifact jsonb = SafeAggregateArtifact 相当）。 */
export function artifactRow(over: Partial<DbRow> = {}, artifactOver: Partial<DbRow> = {}): DbRow {
  const safe = {
    kind: 'valid',
    metricKey: 'feature_usage_prevalence',
    calculationVersion: 'feature_usage_prevalence@1',
    feature: 'interview',
    cohortType: 'all',
    cohortValue: 'all',
    timeBucket: '2026-05',
    sourceWindowStart: '2026-05-01T00:00:00.000Z',
    sourceWindowEnd: '2026-06-01T00:00:00.000Z',
    generatedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-07-20T00:00:00.000Z',
    consentScope: 'user_facing_aggregated_insight',
    provenance: {
      metricKey: 'feature_usage_prevalence',
      calculationVersion: 'feature_usage_prevalence@1',
      consentScope: 'user_facing_aggregated_insight',
      audience: 'user_facing',
      policyStatus: 'PROVISIONAL',
      rolledUpFrom: null,
    },
    qualityStatus: 'valid',
    disclaimerKey: 'aggregate_general_trend_v1',
    numerator: 30,
    denominator: 60,
    prevalence: 0.5,
    sampleSizeBucket: '50–99',
    suppression: { suppressed: false },
    ...artifactOver,
  };
  return {
    id: 'art-1',
    batch_id: 'batch-1',
    metric_key: 'feature_usage_prevalence',
    feature_key: 'interview',
    calculation_version: 'feature_usage_prevalence@1',
    policy_version: 1,
    kind: safe.kind,
    safe_artifact: safe,
    suppression_reason: null,
    sample_size_bucket: '50–99',
    cohort_type: 'all',
    cohort_value: 'all',
    time_bucket: '2026-05',
    source_window_start: '2026-05-01T00:00:00.000Z',
    source_window_end: '2026-06-01T00:00:00.000Z',
    invalidated: false,
    generated_at: '2026-07-01T00:00:00.000Z',
    expires_at: '2026-07-20T00:00:00.000Z',
    ...over,
  };
}

/** Layer 5: contribution row。 */
export function contributionRow(over: Partial<DbRow> = {}): DbRow {
  return {
    contribution_id: 'c-1',
    company_id: 'c_alpha',
    content_category: 'selection_flow',
    source_category: 'self_experience',
    evidence_kind: 'user_experience',
    observed_period: '2026',
    selection_category: 'full_time',
    role_category: 'engineering',
    evidence_summary: '一次面接は志望動機と学生時代の取り組みを中心に問われた。',
    lifecycle_state: 'published',
    provenance_note: null,
    version: 1,
    superseded_by: '',
    legal_hold: false,
    revoked: false,
    expired: false,
    contributor_opaque_key: 'opaque-A',
    content_fingerprint: '',
    submitted_at: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

/** Layer 5: moderation row（approved/clean/low = readable）。 */
export function moderationRow(over: Partial<DbRow> = {}): DbRow {
  return {
    contribution_id: 'c-1',
    state: 'approved',
    pii_scan: 'clean',
    confidentiality: 'low',
    abuse: 'none',
    rejection_reason: null,
    ...over,
  };
}

/** UUID 形式の合成 canary user id（実在 UUID ではない・固定値）。 */
export const CANARY_UUID = '00000000-0000-4000-8000-000000000001';
export const NON_CANARY_UUID = '00000000-0000-4000-8000-0000000000ff';

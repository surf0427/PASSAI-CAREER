/**
 * Data Spine DB boundary — client injection adapters（P17-C §3）。
 *
 * 厳守（絶対にしないこと）:
 *   - env / secret を読まない。
 *   - browser client / server client / service-role client を **生成しない**。
 *   - project URL / ref を保持しない。
 *
 * ここでは「外部から注入された Supabase 互換 client（構造的型）→ port」への adapter のみを提供する。
 * 実 client の生成・注入は将来の production callsite の責務（本 series では作らない）。
 */

import { mapDbError } from './errors';
import type {
  DataSpineBatchPort,
  DataSpineReadPort,
  DataSpineWritePort,
  DbFilter,
  DbRow,
  DbSelect,
  DbSelectResult,
  DbWriteResult,
} from './types';

// supabase-js を import せず、必要最小の構造的型のみを定義（新規 dependency なし）。
type PostgrestResult = { data: DbRow[] | null; error: unknown };

interface FilterBuilderLike extends PromiseLike<PostgrestResult> {
  eq(column: string, value: unknown): FilterBuilderLike;
  in(column: string, values: readonly unknown[]): FilterBuilderLike;
  order(column: string, opts: { ascending: boolean }): FilterBuilderLike;
  range(from: number, to: number): FilterBuilderLike;
}

interface FromBuilderLike {
  select(columns: string): FilterBuilderLike;
  insert(rows: readonly DbRow[]): PromiseLike<PostgrestResult>;
  update(patch: DbRow): FilterBuilderLike;
  upsert(rows: readonly DbRow[], opts: { onConflict: string }): PromiseLike<PostgrestResult>;
}

export interface SupabaseLikeClient {
  from(table: string): FromBuilderLike;
}

function applyFilter(builder: FilterBuilderLike, filter: DbFilter): FilterBuilderLike {
  let b = builder;
  if (filter.eq) {
    for (const [col, val] of Object.entries(filter.eq)) b = b.eq(col, val);
  }
  if (filter.in) b = b.in(filter.in.column, filter.in.values);
  return b;
}

/** 注入された client → read port（never-throw・error は判別 union へ写像）。 */
export function adaptReadPort(client: SupabaseLikeClient): DataSpineReadPort {
  return {
    async select(query: DbSelect): Promise<DbSelectResult> {
      try {
        let b = client.from(query.table).select((query.columns ?? ['*']).join(','));
        b = applyFilter(b, query);
        if (query.order) b = b.order(query.order.column, { ascending: query.order.ascending });
        const offset = query.offset ?? 0;
        b = b.range(offset, offset + query.limit - 1);
        const res = await b;
        if (res.error) return { ok: false, error: mapDbError(res.error, query.table) };
        return { ok: true, rows: Array.isArray(res.data) ? res.data : [] };
      } catch (e) {
        return { ok: false, error: mapDbError(e, query.table) };
      }
    },
  };
}

/** 注入された client → write port。 */
export function adaptWritePort(client: SupabaseLikeClient): DataSpineWritePort {
  return {
    async insert(table: string, rows: readonly DbRow[]): Promise<DbWriteResult> {
      try {
        const res = await client.from(table).insert(rows);
        if (res.error) return { ok: false, error: mapDbError(res.error, table) };
        return { ok: true, affected: rows.length };
      } catch (e) {
        return { ok: false, error: mapDbError(e, table) };
      }
    },
    async update(table: string, patch: DbRow, where: DbFilter): Promise<DbWriteResult> {
      try {
        const res = await applyFilter(client.from(table).update(patch), where);
        if (res.error) return { ok: false, error: mapDbError(res.error, table) };
        const affected = Array.isArray(res.data) ? res.data.length : 0;
        return { ok: true, affected };
      } catch (e) {
        return { ok: false, error: mapDbError(e, table) };
      }
    },
  };
}

/** 注入された privileged client → batch port（service-role 相当。実 client は外部注入）。 */
export function adaptBatchPort(client: SupabaseLikeClient): DataSpineBatchPort {
  const write = adaptWritePort(client);
  return {
    ...write,
    async upsert(table: string, rows: readonly DbRow[], conflictColumn: string): Promise<DbWriteResult> {
      try {
        const res = await client.from(table).upsert(rows, { onConflict: conflictColumn });
        if (res.error) return { ok: false, error: mapDbError(res.error, table) };
        return { ok: true, affected: rows.length };
      } catch (e) {
        return { ok: false, error: mapDbError(e, table) };
      }
    },
  };
}

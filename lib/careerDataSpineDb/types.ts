/**
 * Data Spine DB boundary — project-neutral port 型（P17-C §3）。
 *
 * 目的: Supabase client を外部から注入できる最小 DB port を定義し、repository を
 *   project / env / client 実装から切り離す。
 *
 * 厳守:
 *   - env を内部で読まない（port は外部から注入される）。
 *   - project URL / project ref を型に保持しない。
 *   - user identity を cross-project 変換しない。
 *   - read / write / batch(privileged) を interface で分離する。
 *   - raw row を上位ドメインへそのまま返さない（repository が validation する前提）。
 */

import type { DataSpineDbError } from './errors';

/** 検証前の生 row（repository が domain へ写像する前の unknown 束）。 */
export type DbRow = Record<string, unknown>;

export type DbFilter = {
  eq?: Record<string, string | number | boolean | null>;
  in?: { column: string; values: readonly (string | number)[] };
};

export type DbSelect = DbFilter & {
  table: string;
  columns?: readonly string[];
  order?: { column: string; ascending: boolean };
  /** 最大取得数（pagination contract）。repository は必ず有限 limit を渡す。 */
  limit: number;
  offset?: number;
};

export type DbSelectResult =
  | { ok: true; rows: DbRow[] }
  | { ok: false; error: DataSpineDbError };

export type DbWriteResult =
  | { ok: true; affected: number }
  | { ok: false; error: DataSpineDbError };

/** authenticated read 権限のみ（default deny 前提。今回 caller は作らない）。 */
export interface DataSpineReadPort {
  select(query: DbSelect): Promise<DbSelectResult>;
}

/** write 権限（authenticated write。batch 特権とは別）。 */
export interface DataSpineWritePort {
  insert(table: string, rows: readonly DbRow[]): Promise<DbWriteResult>;
  update(table: string, patch: DbRow, where: DbFilter): Promise<DbWriteResult>;
}

/**
 * privileged batch writer（service-role 相当）。read/write と型で分離する。
 * 部分成功を成功扱いしない契約（affected を返し、caller が期待件数と照合する）。
 */
export interface DataSpineBatchPort extends DataSpineWritePort {
  /** batch upsert（idempotency は conflict target を DB 制約側で担保）。 */
  upsert(table: string, rows: readonly DbRow[], conflictColumn: string): Promise<DbWriteResult>;
}

/** pagination の共通 contract（deterministic ordering + 上限）。 */
export type PaginationSpec = {
  limit: number;
  offset: number;
  orderColumn: string;
  ascending: boolean;
};

export const DEFAULT_MAX_ROWS = 200;

/** 安全な pagination を組む（limit を上限で clamp する）。 */
export function clampPagination(spec: Partial<PaginationSpec> = {}): PaginationSpec {
  const limit = Math.max(1, Math.min(DEFAULT_MAX_ROWS, Math.floor(spec.limit ?? DEFAULT_MAX_ROWS)));
  const offset = Math.max(0, Math.floor(spec.offset ?? 0));
  return {
    limit,
    offset,
    orderColumn: spec.orderColumn ?? 'id',
    ascending: spec.ascending ?? true,
  };
}

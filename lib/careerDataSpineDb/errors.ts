/**
 * Data Spine DB boundary — repository error 判別 union（P17-C §3）。
 *
 * production 非接続。実 DB へ接続しない。raw Supabase error / secret を上位へ流さない。
 * すべての failure を fail-closed で判別 union へ写像する（未知は 'unavailable'）。
 */

export type DataSpineDbError =
  | { kind: 'table_missing'; table: string }
  | { kind: 'permission_denied'; table: string }
  | { kind: 'stale_schema'; detail: string }
  | { kind: 'conflict'; detail: string }
  | { kind: 'malformed_row'; detail: string }
  | { kind: 'unknown_enum'; column: string; value: string }
  | { kind: 'unavailable'; detail: string };

/**
 * PostgREST / Postgres の error code を判別 union へ写像する（text-based・pure）。
 * raw message は載せない（secret / PII 流出防止のため detail は code のみ）。
 *
 * 参考: 42P01 undefined_table / 42501 insufficient_privilege / 23505 unique_violation /
 *   PGRST116 no rows / PGRST20x schema cache。
 */
export function mapDbError(raw: unknown, table: string): DataSpineDbError {
  const code = extractCode(raw);
  switch (code) {
    case '42P01':
    case 'PGRST205': // relation not found in schema cache
      return { kind: 'table_missing', table };
    case '42501':
      return { kind: 'permission_denied', table };
    case '23505':
      return { kind: 'conflict', detail: 'unique_violation' };
    case '42703': // undefined_column
    case 'PGRST204': // column not found in schema cache
      return { kind: 'stale_schema', detail: code };
    default:
      // secret / raw message を載せない。code のみ。
      return { kind: 'unavailable', detail: code ?? 'unknown' };
  }
}

function extractCode(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.code === 'string') return r.code;
  return null;
}

/** read 系で error を「serve しない」結果へ倒すための判定（never-throw 境界）。 */
export function isRetriableUnavailable(e: DataSpineDbError): boolean {
  return e.kind === 'unavailable' || e.kind === 'stale_schema';
}

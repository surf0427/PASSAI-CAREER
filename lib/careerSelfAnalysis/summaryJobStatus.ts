// 自己分析まとめ生成 — status 応答の純粋マッパー（Step2）。
//
// owner-scoped SELECT の結果（自分の job 行 or null）を HTTP 応答契約へ変換する。
// retryable は DB 値を信用せず server-side allowlist mapping で決める。
// owner scope / RLS の強制自体は status route + DB（RLS）側の責務（本関数は純粋変換のみ）。

import { isRetryableErrorCode } from '@/lib/careerGenerationJob/constants';

export interface JobStatusRow {
  status: string;
  result: unknown | null;
  errorCode: string | null;
  /** running の lease 失効時刻（ISO）。stale 判定に使う。 */
  leaseExpiresAt?: string | null;
}

export interface JobStatusResponse {
  httpStatus: number;
  body: Record<string, unknown>;
}

const RETRY_AFTER_MS = 1000;

/**
 * 自分の job 行（or null）→ status 応答。null は 404（他 owner も同一 404 に寄せる）。
 * running/queued は result/errorCode を返さない。
 *
 * recoveryAction（§8）: running の lease が失効していれば client に 'resubmit' を促す。
 *   **GET はここで claim/reclaim しない**（server-side atomic claim は POST 再送で判断）。
 *   nowMs 未指定 or lease 不明のときは安全側の 'poll'。
 */
export function mapOwnedJobToStatusResponse(
  row: JobStatusRow | null,
  jobId: string,
  nowMs?: number,
): JobStatusResponse {
  if (!row) {
    return { httpStatus: 404, body: { status: 'not_found' } };
  }
  if (row.status === 'queued' || row.status === 'running') {
    const leaseMs =
      typeof row.leaseExpiresAt === 'string' ? Date.parse(row.leaseExpiresAt) : NaN;
    const expired =
      typeof nowMs === 'number' && Number.isFinite(leaseMs) && leaseMs <= nowMs;
    return {
      httpStatus: 200,
      body: expired
        ? { status: 'running', jobId, retryAfterMs: 0, recoveryAction: 'resubmit' }
        : { status: 'running', jobId, retryAfterMs: RETRY_AFTER_MS, recoveryAction: 'poll' },
    };
  }
  if (row.status === 'completed') {
    return { httpStatus: 200, body: { status: 'completed', jobId, result: row.result ?? {} } };
  }
  // failed
  const errorCode = typeof row.errorCode === 'string' && row.errorCode ? row.errorCode : 'UNKNOWN';
  return {
    httpStatus: 200,
    body: { status: 'failed', jobId, errorCode, retryable: isRetryableErrorCode(errorCode) },
  };
}

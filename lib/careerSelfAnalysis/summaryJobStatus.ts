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
}

export interface JobStatusResponse {
  httpStatus: number;
  body: Record<string, unknown>;
}

const RETRY_AFTER_MS = 1000;

/**
 * 自分の job 行（or null）→ status 応答。null は 404（他 owner も同一 404 に寄せる）。
 * running/queued は result/errorCode を返さない。
 */
export function mapOwnedJobToStatusResponse(
  row: JobStatusRow | null,
  jobId: string,
): JobStatusResponse {
  if (!row) {
    return { httpStatus: 404, body: { status: 'not_found' } };
  }
  if (row.status === 'queued' || row.status === 'running') {
    return { httpStatus: 200, body: { status: 'running', jobId, retryAfterMs: RETRY_AFTER_MS } };
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

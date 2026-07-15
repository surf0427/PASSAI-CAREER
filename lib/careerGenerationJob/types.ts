/**
 * career generation job — 型定義（STEP-CAREER-GENJOB-01）。
 *
 * pure module。DB row 形状・claim 戻り値・owner-scoped read 形状を定義する。
 * raw input / prompt 本文 / PII に相当する型は持たない（保存しない設計を型でも表現）。
 */

import type { GenerationJobErrorCode } from './constants';

export type GenerationJobStatus = 'queued' | 'running' | 'completed' | 'failed';

/** atomic claim function の 6 outcome。 */
export type GenerationJobClaimOutcome =
  | 'CLAIMED_NEW'
  | 'CLAIMED_RETRY'
  | 'ALREADY_RUNNING'
  | 'ALREADY_COMPLETED'
  | 'FAILED_NON_RETRYABLE'
  | 'RETRY_LIMIT_REACHED';

/** claim の結果。attempt_token は CLAIMED_NEW / CLAIMED_RETRY のみ非 null。 */
export interface GenerationJobClaimResult {
  outcome: GenerationJobClaimOutcome;
  jobId: string;
  /** 生成側が terminal 更新時に提示する fencing token（新規/reclaim 時のみ）。 */
  attemptToken: string | null;
  status: GenerationJobStatus;
  attemptCount: number;
}

/** server-authoritative に確定した idempotency 材料（hash revision のみ）。 */
export interface GenerationJobIdentity {
  idempotencyKey: string;
  inputRevision: string;
  promptRevision: string;
  outputSchemaRevision: string;
  model: string;
}

/** claim の入力（server 認証済み user_id + 機能識別 + identity）。raw input は含めない。 */
export interface GenerationJobClaimArgs {
  userId: string;
  feature: string;
  operation: string;
  identity: GenerationJobIdentity;
}

/** completed への fenced 更新入力。 */
export interface GenerationJobCompleteArgs {
  userId: string;
  jobId: string;
  attemptToken: string;
  result: unknown;
  providerDurationMs?: number | null;
  totalDurationMs?: number | null;
}

/** failed への fenced 更新入力。error_code は allowlist のみ。 */
export interface GenerationJobFailArgs {
  userId: string;
  jobId: string;
  attemptToken: string;
  errorCode: GenerationJobErrorCode;
  providerDurationMs?: number | null;
  totalDurationMs?: number | null;
}

/**
 * fenced 更新の結果。applied=false は「lease を失った古い attempt」
 * （status≠running もしくは attempt_token 不一致）＝結果破棄を意味する。
 */
export interface GenerationJobUpdateResult {
  applied: boolean;
}

/** owner-scoped read（status endpoint / client 復帰用）。raw input は返さない。 */
export interface OwnedGenerationJob {
  id: string;
  feature: string;
  operation: string;
  status: GenerationJobStatus;
  result: unknown | null;
  errorCode: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

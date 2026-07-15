// 自己分析まとめ生成 — client 側 job 追跡の型（Step3 / members pilot 専用）。
//
// pure module（'use client' なし・DOM/React 非依存）。controller から使う。

import type { SelfAnalysisSummaryInput } from '../summaryPrompt';

// UI が表示する明示状態（架空の詳細進行は作らない）。
export type GenerationClientState =
  | 'idle'
  | 'submitting'
  | 'running'
  | 'reconnecting'
  | 'completed'
  | 'failed';

export type RecoveryAction = 'poll' | 'resubmit';

// members pilot 専用 pending slot（versioned・owner-scoped）。
// **本文・result・prompt・error・PII は保存しない**（hash revision と識別子のみ）。
export interface PendingSelfAnalysisJob {
  version: 1;
  ownerScope: string;
  jobId: string | null;
  clientFingerprint: string;
  requestState: 'submitting' | 'running' | 'unknown';
  createdAt: string;
  lastCheckedAt: string | null;
  promptRevision: string;
  outputSchemaRevision: string;
}

// stale-response guard 用の submission トークン（in-memory）。
export interface ActiveGenerationToken {
  sequence: number;
  ownerScope: string;
  clientFingerprint: string;
  jobId: string | null;
}

// controller が POST に渡す request body（今日の generate() と同形）。
// client 由来の user ID / idempotency key は含めない。
export type SelfAnalysisRequestBody = SelfAnalysisSummaryInput;

// fetch 抽象の結果（network 失敗を transport_error として区別）。
export type HttpResult =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'transport_error' };

// finalize（保存）呼び出しの引数。
export interface FinalizeArgs {
  result: unknown;
  ownerScope: string;
  clientFingerprint: string;
  jobId: string | null;
}

// UI へ渡す view（実際に確認できる状態のみ）。
export interface GenerationView {
  state: GenerationClientState;
  /** retry ボタンを出してよいか（retryable failed のみ true）。 */
  canRetry: boolean;
  /** 手動「処理状況を再確認」を出してよいか。 */
  canRecheck: boolean;
  /** 固定 allowlist の error code（表示は呼び出し側で日本語化）。 */
  errorCode: string | null;
}

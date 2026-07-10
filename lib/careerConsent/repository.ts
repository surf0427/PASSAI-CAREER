/**
 * Consent Ledger — repository interface（P14-C・契約のみ）。
 *
 * 将来の永続化に備えた境界定義。**mutable な setConsent(true/false) を source of truth にしない**。
 * append-only event を正とし、現在状態は reducer で導出する。
 *
 * P14-C 実装: interface + in-memory（synthetic 専用）。
 * P14-C 非実装: Supabase / browser / localStorage / service-role / production adapter。
 */

import type {
  ConsentLedgerEvent,
  ConsentReceipt,
  ConsentScope,
  DerivedConsentState,
  IdempotencyClassification,
} from '@/types/careerConsent';

export type AppendRejectReason =
  | 'idempotent_duplicate'
  | 'idempotency_conflict'
  | 'sequence_conflict'
  | 'account_deleted_terminal'
  | 'invalid_event';

export type AppendResult =
  | { ok: true; event: ConsentLedgerEvent; deduped?: boolean }
  | { ok: false; reason: AppendRejectReason };

export type ConsentProvenance = {
  subjectPresent: boolean;
  eventCount: number;
  latestSequence: number | null;
  accountStatus: DerivedConsentState['accountStatus'];
};

/**
 * Consent Ledger repository の契約。
 * 禁止（型で表現しない・実装しない）:
 *   - setConsent(boolean) / upsertCurrentConsent を唯一の真実にする API
 *   - scope 省略 / version 省略の grant API
 *   - client timestamp を権威にする API
 *   - history を消して現在値だけ残す API
 *   - public cross-user read / 任意ユーザー ledger を aggregate から直接読む API
 */
export interface ConsentLedgerRepository {
  /** append-only 追記（idempotency / ordering / terminal を検証）。 */
  append(event: ConsentLedgerEvent, now: number): AppendResult;
  /** subject の全 event（append 順）。 */
  listForSubject(subjectId: string): ConsentLedgerEvent[];
  /** subject × scope の event（account 系は含めない）。 */
  listForSubjectScope(subjectId: string, scope: ConsentScope): ConsentLedgerEvent[];
  /** subject の導出状態。 */
  getDerivedState(subjectId: string, now: number): DerivedConsentState;
  /** candidate の idempotency 分類。 */
  verifyIdempotency(subjectId: string, candidate: ConsentLedgerEvent): IdempotencyClassification;
  /** subject の consent receipt。 */
  getReceipt(subjectId: string, now: number): ConsentReceipt;
  /** provenance（件数・最新 sequence・account 状態）。 */
  getProvenance(subjectId: string, now: number): ConsentProvenance;
}

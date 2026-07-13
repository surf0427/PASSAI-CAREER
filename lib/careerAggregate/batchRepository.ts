/**
 * Aggregated Insight (Layer 4) — batch-aware read repository interface（P17-B §10-11・契約のみ）。
 *
 * manifest（lineage/publish/validation）+ propagation（invalidation）を踏まえた governed read。
 * 本 series では production DB へ接続しない（interface + in-memory synthetic 実装のみ）。
 *
 * 安全要件:
 *   - incomplete / failed / unvalidated / unpublished batch の artifact は available にしない。
 *   - source window / calculation version 欠落 artifact は read 不可。
 *   - invalidated（revoke/delete propagation 未完）batch は blocked / regeneration 完了まで serve しない。
 *   - stale artifact は available にしない。
 *   - 同一 idempotency key の二重生成を防ぐ。
 */

import type {
  AggregateBatchManifest,
  PropagationRecord,
} from '@/types/careerAggregateBatch';
import type {
  SafeAggregateArtifact,
  SuppressedAggregateArtifact,
  ValidAggregateArtifact,
  ZeroAggregateArtifact,
} from '@/types/careerAggregate';

export type BatchAwareReadResult =
  | { status: 'available'; artifact: ValidAggregateArtifact | ZeroAggregateArtifact }
  | { status: 'suppressed'; artifact: SuppressedAggregateArtifact }
  | { status: 'stale' }
  | { status: 'blocked'; reason: 'consent' | 'legal' | 'moderation' | 'privacy' }
  | { status: 'unavailable'; reason: 'not_checked' | 'lookup_error' | 'unknown' }
  | { status: 'missing' };

export type PutManifestResult = { accepted: boolean; deduped: boolean };

export interface AggregateBatchRepository {
  /** manifest を登録（idempotencyKey 二重は deduped）。 */
  putManifest(m: AggregateBatchManifest): PutManifestResult;
  getManifest(batchId: string): AggregateBatchManifest | null;
  listManifests(): readonly AggregateBatchManifest[];

  /** batch に artifact を紐付けて保存（synthetic）。 */
  putArtifact(batchId: string, artifactId: string, artifact: SafeAggregateArtifact): void;

  /** propagation（revoke/delete）記録を登録。 */
  recordPropagation(record: PropagationRecord): void;

  /** governed read（manifest 状態 + freshness + invalidation を踏まえる）。 */
  readArtifact(artifactId: string, now: number): BatchAwareReadResult;
}

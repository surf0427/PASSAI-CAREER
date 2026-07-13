/**
 * Aggregated Insight — read repository interface（P17-A §5.1・契約のみ）。
 *
 * 将来 aggregate store / fixed read model から safe artifact を読む境界。
 * 本 series では production DB へ接続しない（interface + in-memory synthetic 実装のみ）。
 *
 * 安全要件:
 *   - unsafe artifact（stale / suppressed）を `available` として返さない。
 *   - freshness（expiresAt < now）は available にせず stale として返す。
 *   - missing / suppressed / stale を型で区別する。
 *   - duplicate metric（同一 key の複数 artifact）は決定論的に 1 件へ解決する。
 *   - deterministic ordering（list / read）。
 */

import type {
  AggregateAudience,
  AggregateMetricKey,
  CareerEventFeature,
  CohortType,
  SafeAggregateArtifact,
  SuppressedAggregateArtifact,
  ValidAggregateArtifact,
  ZeroAggregateArtifact,
} from '@/types/careerAggregate';

/** artifact を一意に指す read 鍵（cohort 値・month・audience 含む）。 */
export type AggregateReadKey = {
  metricKey: AggregateMetricKey;
  feature: CareerEventFeature;
  cohortType: CohortType;
  cohortValue: string;
  timeBucket: string; // YYYY-MM
  audience: AggregateAudience;
};

export type AggregateReadQuery = AggregateReadKey & {
  /** freshness 判定用（expiresAt <= now は stale）。 */
  now: number;
};

/**
 * read 結果。available には数値を持つ valid / 既知ゼロの zero のみを載せる。
 * suppressed / stale / missing は数値を運ばない（型で区別）。
 */
export type AggregateReadResult =
  | { status: 'available'; artifact: ValidAggregateArtifact | ZeroAggregateArtifact }
  | { status: 'suppressed'; artifact: SuppressedAggregateArtifact }
  | { status: 'stale' }
  | { status: 'missing' };

export interface AggregateReadRepository {
  /** synthetic artifact を投入（同一 key は決定論的に上書き解決）。 */
  put(artifact: SafeAggregateArtifact): void;
  /** query に対応する artifact を安全に読む（freshness / suppressed を考慮）。 */
  read(query: AggregateReadQuery): AggregateReadResult;
  /** 保持中の全 artifact（決定論順）。 */
  list(): readonly SafeAggregateArtifact[];
}

/** artifact → read 鍵（内部 index 生成用・pure）。 */
export function toAggregateReadKey(a: SafeAggregateArtifact): AggregateReadKey {
  return {
    metricKey: a.metricKey,
    feature: a.feature,
    cohortType: a.cohortType,
    cohortValue: a.cohortValue,
    timeBucket: a.timeBucket,
    audience: a.provenance.audience,
  };
}

/** read 鍵 → 安定文字列（区切りの曖昧さを避けるため JSON 配列で構成）。 */
export function serializeAggregateReadKey(key: AggregateReadKey): string {
  return JSON.stringify([
    key.metricKey,
    key.feature,
    key.cohortType,
    key.cohortValue,
    key.timeBucket,
    key.audience,
  ]);
}

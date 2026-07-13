-- ============================================================
-- career_aggregated_insight — Layer 4 Aggregated Insight production tables (DRAFT)
--
-- NOT APPLIED
-- DO NOT APPLY UNTIL DECISION REGISTER GATES ARE CLOSED
-- TARGET PROJECT UNDECIDED
-- DEFAULT DENY
-- SERVICE/BATCH WRITER POLICY UNDECIDED
-- LEGAL/CONSENT VALUES NOT FINAL
--
-- migration header:
--   - これは未適用の草案。schema.sql へ統合しない。手動 review 後にのみ適用する。
--   - RLS enabled + policy 無し（default deny）。anon/authenticated への GRANT は作らない。
--   - service-role / batch writer policy は project 決定後に別途追加する（本ファイルでは作らない）。
--
-- privacy regime（table comment にも記載）:
--   - raw event 本文・user_id 一覧・contributor identity・exact sensitive count を保存しない。
--   - artifact は匿名集計の安全 payload のみ（sample size は bucket、生 count を持たない）。
--   - incomplete / failed / invalidated batch の artifact は read 対象にしない（app / RLS 双方で担保予定）。
-- ============================================================

BEGIN;

-- ── batches ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_aggregate_batches (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key          text NOT NULL,
  metric_key               text NOT NULL,
  calculation_version      text NOT NULL,
  policy_version           integer NOT NULL,
  source_window_start      timestamptz NOT NULL,
  source_window_end        timestamptz NOT NULL,
  input_watermark          timestamptz NOT NULL,
  consent_snapshot_version text NOT NULL,
  status                   text NOT NULL DEFAULT 'started'
                             CHECK (status IN ('started','completed','failed')),
  validation_state         text NOT NULL DEFAULT 'unvalidated'
                             CHECK (validation_state IN ('unvalidated','valid','invalid')),
  publish_state            text NOT NULL DEFAULT 'unpublished'
                             CHECK (publish_state IN ('unpublished','published','rolled_back')),
  incomplete_reason        text,
  source_event_count_bucket    text NOT NULL DEFAULT '0',
  eligible_event_count_bucket  text NOT NULL DEFAULT '0',
  suppressed_result_count  integer NOT NULL DEFAULT 0,
  rollback_reason          text,
  rollback_at              timestamptz,
  started_at               timestamptz NOT NULL DEFAULT now(),
  completed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- idempotency: 同一 key の二重生成を DB 制約で防ぐ。
  CONSTRAINT career_aggregate_batches_idempotency_key_uniq UNIQUE (idempotency_key)
);
COMMENT ON TABLE career_aggregate_batches IS
  'Layer4 aggregate batch manifest. NO raw event body, NO user_id list, NO contributor identity. counts are buckets only. privacy regime: anonymous_aggregate.';

CREATE INDEX IF NOT EXISTS career_aggregate_batches_metric_window_idx
  ON career_aggregate_batches (metric_key, source_window_start, source_window_end);

ALTER TABLE career_aggregate_batches ENABLE ROW LEVEL SECURITY;
-- default deny: policy を作らない（authenticated への直接 read/write を許可しない）。

-- ── artifacts ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_aggregate_artifacts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL
                          REFERENCES career_aggregate_batches (id) ON DELETE RESTRICT,
  metric_key            text NOT NULL,
  feature_key           text NOT NULL,
  calculation_version   text NOT NULL,
  policy_version        integer NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('valid','zero','suppressed')),
  -- 安全 payload のみ（禁止 field を含めないことは app 層でも検証）。exact raw count を含めない。
  safe_artifact         jsonb NOT NULL,
  suppression_reason    text,
  sample_size_bucket    text,
  cohort_type           text NOT NULL,
  cohort_value          text NOT NULL,
  time_bucket           text NOT NULL,
  source_window_start   timestamptz NOT NULL,
  source_window_end     timestamptz NOT NULL,
  invalidated           boolean NOT NULL DEFAULT false,
  generated_at          timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- 同一 read 座標の重複を防ぐ（duplicate metric 決定論解決の DB 側担保）。
  CONSTRAINT career_aggregate_artifacts_coord_uniq
    UNIQUE (metric_key, feature_key, cohort_type, cohort_value, time_bucket, calculation_version, batch_id)
);
COMMENT ON TABLE career_aggregate_artifacts IS
  'Layer4 safe aggregate artifacts. sample size is a bucket, NOT a raw count. NO identifiers. read only when batch published+valid+complete and not invalidated.';

CREATE INDEX IF NOT EXISTS career_aggregate_artifacts_batch_idx
  ON career_aggregate_artifacts (batch_id);

ALTER TABLE career_aggregate_artifacts ENABLE ROW LEVEL SECURITY;
-- default deny.

-- ── invalidations ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_aggregate_invalidations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_key       text NOT NULL,
  trigger               text NOT NULL
                          CHECK (trigger IN ('consent_revoke','user_deletion','contribution_exclusion')),
  metric_key            text NOT NULL,
  affected_window_start timestamptz NOT NULL,
  affected_window_end   timestamptz NOT NULL,
  propagation_state     text NOT NULL DEFAULT 'requested'
                          CHECK (propagation_state IN
                            ('requested','affected_identified','invalidated','regeneration_requested','completed','failed')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  failure_reason        text,
  CONSTRAINT career_aggregate_invalidations_correlation_uniq UNIQUE (correlation_key)
);
COMMENT ON TABLE career_aggregate_invalidations IS
  'Layer4 revoke/deletion propagation. NO user identity; only opaque correlation_key + metric/window coordinates.';

ALTER TABLE career_aggregate_invalidations ENABLE ROW LEVEL SECURITY;

-- ── regeneration requests ──────────────────────────────────
CREATE TABLE IF NOT EXISTS career_aggregate_regeneration_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invalidation_id    uuid NOT NULL
                       REFERENCES career_aggregate_invalidations (id) ON DELETE RESTRICT,
  metric_key         text NOT NULL,
  requested_state    text NOT NULL DEFAULT 'requested'
                       CHECK (requested_state IN ('requested','running','completed','failed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
COMMENT ON TABLE career_aggregate_regeneration_requests IS
  'Layer4 regeneration requests. fail-closed: affected artifacts are not served until completed.';

ALTER TABLE career_aggregate_regeneration_requests ENABLE ROW LEVEL SECURITY;

-- ── audit events ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_aggregate_audit_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type          text NOT NULL,
  subject_key         text NOT NULL,
  correlation_key     text NOT NULL,
  reason_code         text,
  calculation_version text,
  policy_version      integer,
  occurred_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE career_aggregate_audit_events IS
  'Layer4 audit events. NO user identity, NO raw content, NO exact sensitive counts. opaque keys only.';

ALTER TABLE career_aggregate_audit_events ENABLE ROW LEVEL SECURITY;

COMMIT;

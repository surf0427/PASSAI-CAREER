-- ============================================================
-- career_company_knowledge — Layer 5 Company Knowledge Base production tables (DRAFT)
--
-- NOT APPLIED
-- DO NOT APPLY UNTIL DECISION REGISTER GATES ARE CLOSED
-- TARGET PROJECT UNDECIDED
-- DEFAULT DENY
-- SERVICE/BATCH WRITER POLICY UNDECIDED
-- LEGAL/CONSENT VALUES NOT FINAL
--
-- migration header:
--   - 未適用の草案。schema.sql へ統合しない。手動 review 後にのみ適用する。
--   - RLS enabled + policy 無し（default deny）。anon/authenticated への GRANT は作らない。
--   - public/shared read policy は今回作らない（project / moderation 運用決定後）。
--   - ON DELETE は撤回・法的保持・履歴要件を考慮し、単純 CASCADE を無条件採用しない（RESTRICT 基本）。
--
-- privacy regime（絶対）:
--   - contributor name / email / 大学 / 応募 ID / auth user id / private research 本文を保存しない。
--   - 撤回・dedup 用の contributor_opaque_key は内部専用（shared read へ絶対に出さない）。
--   - consent 無し / moderation 前は published にしない（lifecycle + RLS で担保予定）。
--   - consent text / retention 値を SQL に hard-code しない。
-- ============================================================

BEGIN;

-- ── company master ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_company_master (
  company_id        text PRIMARY KEY,
  display_name      text NOT NULL,
  legal_name        text,
  normalized_name   text NOT NULL,
  corporate_group_id text,
  parent_id         text REFERENCES career_company_master (company_id) ON DELETE RESTRICT,
  identity_version  integer NOT NULL DEFAULT 1,
  effective_from    timestamptz,
  effective_to      timestamptz,
  resolution_state  text NOT NULL DEFAULT 'resolved'
                      CHECK (resolution_state IN ('resolved','ambiguous','unresolved')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE career_company_master IS
  'Layer5 canonical company identity. historical names kept separately (aliases). NO contributor data. privacy regime: shared_company_knowledge (company-level, non-personal).';

ALTER TABLE career_company_master ENABLE ROW LEVEL SECURITY;

-- ── company aliases（過去社名含む・現在名で上書きしない）────────────
CREATE TABLE IF NOT EXISTS career_company_aliases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     text NOT NULL REFERENCES career_company_master (company_id) ON DELETE RESTRICT,
  alias          text NOT NULL,
  normalized_alias text NOT NULL,
  alias_kind     text NOT NULL DEFAULT 'alias'
                   CHECK (alias_kind IN ('alias','historical_name')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_company_aliases_uniq UNIQUE (company_id, normalized_alias, alias_kind)
);
COMMENT ON TABLE career_company_aliases IS
  'Layer5 company aliases and historical names. collisions resolved by review, never silently.';

ALTER TABLE career_company_aliases ENABLE ROW LEVEL SECURITY;

-- ── contributions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_company_knowledge_contributions (
  contribution_id       text PRIMARY KEY,
  company_id            text NOT NULL REFERENCES career_company_master (company_id) ON DELETE RESTRICT,
  content_category      text NOT NULL,
  source_category       text NOT NULL,
  evidence_kind         text NOT NULL,
  observed_period       text NOT NULL,
  selection_category    text NOT NULL,
  role_category         text NOT NULL,
  -- 構造化された短い要約のみ（本文全文・PII を含めない。moderation 通過が前提）。
  evidence_summary      text NOT NULL,
  lifecycle_state       text NOT NULL DEFAULT 'draft',
  provenance_note       text,
  version               integer NOT NULL DEFAULT 1,
  superseded_by         text,
  legal_hold            boolean NOT NULL DEFAULT false,
  revoked               boolean NOT NULL DEFAULT false,
  expired               boolean NOT NULL DEFAULT false,
  -- 内部専用: 撤回 / dedup 用の匿名 opaque key。shared read へ絶対に出さない。
  contributor_opaque_key text NOT NULL,
  content_fingerprint    text NOT NULL,
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE career_company_knowledge_contributions IS
  'Layer5 contributions. NO contributor name/email/university/application id. contributor_opaque_key is internal-only and MUST NOT appear in shared read projections.';

CREATE INDEX IF NOT EXISTS career_company_knowledge_contributions_company_idx
  ON career_company_knowledge_contributions (company_id, content_category);

ALTER TABLE career_company_knowledge_contributions ENABLE ROW LEVEL SECURITY;

-- ── consent snapshots ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_company_knowledge_consent_snapshots (
  id                text PRIMARY KEY,
  contribution_id   text NOT NULL
                      REFERENCES career_company_knowledge_contributions (contribution_id) ON DELETE RESTRICT,
  scope             text NOT NULL,
  policy_version    integer NOT NULL,
  granted_at        timestamptz,
  revoked_at        timestamptz,
  consent_source    text NOT NULL,
  actor_class       text NOT NULL,
  permitted_uses    text[] NOT NULL DEFAULT '{}',
  prohibited_uses   text[] NOT NULL DEFAULT '{}',
  snapshot_version  integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE career_company_knowledge_consent_snapshots IS
  'Layer5 explicit-share consent snapshots (append-oriented). consent text and commercial scope are NOT hard-coded here.';

ALTER TABLE career_company_knowledge_consent_snapshots ENABLE ROW LEVEL SECURITY;

-- ── moderation ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_company_knowledge_moderation (
  contribution_id     text PRIMARY KEY
                        REFERENCES career_company_knowledge_contributions (contribution_id) ON DELETE RESTRICT,
  state               text NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending','approved','rejected','blocked')),
  pii_scan            text NOT NULL DEFAULT 'not_scanned',
  confidentiality     text NOT NULL DEFAULT 'unknown',
  abuse               text NOT NULL DEFAULT 'none',
  rejection_reason    text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE career_company_knowledge_moderation IS
  'Layer5 moderation state. fail-closed: not approved / pii not clean / confidentiality not low => not readable.';

ALTER TABLE career_company_knowledge_moderation ENABLE ROW LEVEL SECURITY;

-- ── versions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_company_knowledge_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id  text NOT NULL
                     REFERENCES career_company_knowledge_contributions (contribution_id) ON DELETE RESTRICT,
  version          integer NOT NULL,
  observed_period  text NOT NULL,
  supersedes       text,
  superseded_by    text,
  stale_reason     text,
  generated_at     timestamptz NOT NULL,
  CONSTRAINT career_company_knowledge_versions_uniq UNIQUE (contribution_id, version)
);
COMMENT ON TABLE career_company_knowledge_versions IS
  'Layer5 revision lineage. history is kept (older periods not deleted). newer does not silently overwrite older.';

ALTER TABLE career_company_knowledge_versions ENABLE ROW LEVEL SECURITY;

-- ── evidence groups ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_company_knowledge_evidence_groups (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            text NOT NULL REFERENCES career_company_master (company_id) ON DELETE RESTRICT,
  content_category      text NOT NULL,
  selection_category    text NOT NULL,
  role_category         text NOT NULL,
  -- 独立 contributor 数は bucket のみ（生 count を shared read へ出さない）。
  corroboration_bucket  text NOT NULL,
  official_count_bucket text NOT NULL DEFAULT '0',
  user_count_bucket     text NOT NULL DEFAULT '0',
  has_conflict          boolean NOT NULL DEFAULT false,
  trend_eligible        boolean NOT NULL DEFAULT false,
  freshness             text NOT NULL DEFAULT 'unknown',
  generated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_company_knowledge_evidence_groups_uniq
    UNIQUE (company_id, content_category, selection_category, role_category)
);
COMMENT ON TABLE career_company_knowledge_evidence_groups IS
  'Layer5 aggregated evidence groups. corroboration is a bucket, NOT a raw contributor count. single reports are not trends.';

ALTER TABLE career_company_knowledge_evidence_groups ENABLE ROW LEVEL SECURITY;

-- ── audit events ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_company_knowledge_audit_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type       text NOT NULL,
  subject_key      text NOT NULL,
  correlation_key  text NOT NULL,
  reason_code      text,
  policy_version   integer,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE career_company_knowledge_audit_events IS
  'Layer5 audit events. NO contributor identity, NO raw content. opaque keys only.';

ALTER TABLE career_company_knowledge_audit_events ENABLE ROW LEVEL SECURITY;

-- ── takedown requests ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_company_knowledge_takedown_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        text NOT NULL REFERENCES career_company_master (company_id) ON DELETE RESTRICT,
  contribution_id   text REFERENCES career_company_knowledge_contributions (contribution_id) ON DELETE RESTRICT,
  reason_code       text NOT NULL,
  requested_state   text NOT NULL DEFAULT 'received'
                      CHECK (requested_state IN ('received','legal_hold','reviewing','upheld','rejected')),
  correlation_key   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  CONSTRAINT career_company_knowledge_takedown_correlation_uniq UNIQUE (correlation_key)
);
COMMENT ON TABLE career_company_knowledge_takedown_requests IS
  'Layer5 company takedown / complaint requests. legal_hold excludes content from read. process decision is OPEN.';

ALTER TABLE career_company_knowledge_takedown_requests ENABLE ROW LEVEL SECURITY;

COMMIT;

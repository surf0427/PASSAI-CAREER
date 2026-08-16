-- ============================================================
-- career_company_identity — Company Data Spine L0（Company Identity）production DDL
--
-- ⚠ NOT APPLIED（本 slice ではファイル作成のみ。実環境への適用はしていない）
--
-- 位置づけ:
--   Phase A（R1〜R6）で必要なのは **企業を一意に指す ID と別名** だけ。
--   Layer 5 Community（contributions / moderation / consent / versions /
--   evidence_groups / audit_events / takedown_requests）は **本 file の対象外**であり、
--   `supabase/career_company_knowledge_apply.sql` は未適用のまま LOCKED を維持する。
--
-- ★ schema drift 防止:
--   `career_company_master` / `career_company_aliases` の列定義は
--   `supabase/career_company_knowledge_apply.sql` の定義と **完全に同一**にしてある。
--   どちらを先に適用しても IF NOT EXISTS により結果が一致する（冪等）。
--
-- 権威区分: global_shared_server_authoritative
--   - 企業マスタは **個人データではない**（contributor / user_id を一切持たない）。
--   - localStorage canonical の対象外（端末 canonical という概念が無い）。
--   - `CareerSourceKind`（Personal Memory の由来 Source）には **追加しない**。
--
-- RLS 方針:
--   - read : authenticated のみ SELECT 可（anon には GRANT しない）
--   - write: policy を作らない（default deny）。書き込みは service_role 経由の
--            server route のみ（app/api/career/company/register）。
-- ============================================================

BEGIN;

-- ── company master ─────────────────────────────────────────
-- ★ career_company_knowledge_apply.sql と同一定義（drift させない）。
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
  'Company Data Spine L0 canonical company identity. NO personal data, NO contributor data. authority: global_shared_server_authoritative. Writes are service_role only.';

-- 同一企業の乱立防止（登録 route の重複チェックを DB 側でも担保する）。
CREATE UNIQUE INDEX IF NOT EXISTS career_company_master_normalized_name_uniq
  ON career_company_master (normalized_name);

ALTER TABLE career_company_master ENABLE ROW LEVEL SECURITY;

-- ── company aliases（別名・旧社名。現在名で上書きしない）────────────
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
  'Company Data Spine L0 aliases and historical names. Collisions are surfaced to the user, never silently resolved.';

-- Resolver の prefilter（normalized_alias の部分一致）用。
CREATE INDEX IF NOT EXISTS career_company_aliases_normalized_idx
  ON career_company_aliases (normalized_alias);

ALTER TABLE career_company_aliases ENABLE ROW LEVEL SECURITY;

-- ── RLS policy（read only）──────────────────────────────────
-- 企業マスタは個人データではないため authenticated 全員に読ませる。
DROP POLICY IF EXISTS "career_company_master read" ON career_company_master;
CREATE POLICY "career_company_master read"
  ON career_company_master
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "career_company_aliases read" ON career_company_aliases;
CREATE POLICY "career_company_aliases read"
  ON career_company_aliases
  FOR SELECT TO authenticated
  USING (true);

-- ⚠ INSERT / UPDATE / DELETE policy は **作らない**（default deny）。
--   企業登録は service_role を使う server route のみが行う。

-- ── GRANT（★ 最後）─────────────────────────────────────────
GRANT SELECT ON career_company_master  TO authenticated;
GRANT SELECT ON career_company_aliases TO authenticated;
GRANT ALL    ON career_company_master  TO service_role;
GRANT ALL    ON career_company_aliases TO service_role;
-- anon には一切付与しない。

COMMIT;

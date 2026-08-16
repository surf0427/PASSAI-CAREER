-- ============================================================
-- career_company_applications — Application Context（user × company）durable mirror
--
-- ⚠ NOT APPLIED（本 slice ではファイル作成のみ。実環境への適用はしていない）
--
-- canonical ownership:
--   localStorage 'careerCompanyApplications' が canonical。本 table は member の
--   best-effort mirror（既存 career_* family と同じ Class 1 = device_canonical_mirrored）。
--
-- 位置づけ:
--   「その人がその企業をどう受けるか」だけを持つ。企業の事実（Official Sourced Facts）でも、
--   本人が得た企業情報（User Private Evidence）でもない。混ぜない。
--
-- ★ Application Tracking にしない: 締切 / 面接日程 / 合否 / ステータス履歴 / TODO /
--   リマインダ / companyMemo / 企業事実 / AI 分析の列は **作らない**。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS career_company_applications (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 企業マスタ（career_company_master）の company_id。
  -- ★ FK は張らない: 企業マスタが未適用の環境でも mirror が壊れないようにする
  --   （canonical は localStorage であり、この table は best-effort mirror）。
  company_id      text        NOT NULL,
  interest_level  text,
  job_type        text,
  selection_type  text,
  selection_phase text,
  selection_year  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_company_applications_natural_key UNIQUE (user_id, company_id)
);

COMMENT ON TABLE career_company_applications IS
  'Application Context (user x company). localStorage key=careerCompanyApplications is canonical; this table is a best-effort mirror. Contains NO company facts and NO user-collected company evidence.';

CREATE INDEX IF NOT EXISTS career_company_applications_user_idx
  ON career_company_applications (user_id, updated_at DESC);

-- ── RLS（owner-scoped）─────────────────────────────────────
ALTER TABLE career_company_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS career_company_applications_owner_select ON career_company_applications;
CREATE POLICY career_company_applications_owner_select
  ON career_company_applications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS career_company_applications_owner_insert ON career_company_applications;
CREATE POLICY career_company_applications_owner_insert
  ON career_company_applications
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS career_company_applications_owner_update ON career_company_applications;
CREATE POLICY career_company_applications_owner_update
  ON career_company_applications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS career_company_applications_owner_delete ON career_company_applications;
CREATE POLICY career_company_applications_owner_delete
  ON career_company_applications
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON career_company_applications TO authenticated;
-- anon には一切付与しない。

COMMIT;

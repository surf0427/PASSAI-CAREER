-- ============================================================================
-- ⛔ PRODUCTION CANDIDATE — NOT APPLIED ⛔
--
-- PASSAI CAREER — Layer 5 read contract（`D-P6`）。
--
-- 2 系統を厳密に分ける:
--   (a) contributor 本人 → owner-scoped（I2 対応表越し）
--   (b) 一般 member     → published のみ・contributor 非開示（専用 view）
--
-- ★ 順序: ENABLE RLS（既に有効）→ CREATE POLICY → GRANT。
-- 依存: 020_contributor_subject_identity.sql
-- ============================================================================

BEGIN;

-- ── 1. (a) contributor 本人の owner-scoped read ─────────────────────
--   ★ contribution table に auth user id 列を **足さない**のが I2 の要点。
--     対応表越しの subquery で auth.uid() と照合する。
DROP POLICY IF EXISTS "career_ck_contributions owner select" ON career_company_knowledge_contributions;
CREATE POLICY "career_ck_contributions owner select"
  ON career_company_knowledge_contributions
  FOR SELECT TO authenticated
  USING (
    contributor_opaque_key IN (
      SELECT s.opaque_key
        FROM career_ck_contributor_subjects s
       WHERE s.auth_user_id = auth.uid()
         AND s.unlinked_at IS NULL
    )
  );

-- ⚠ INSERT / UPDATE policy は **作らない**。
--   寄与作成は moderation を挟むため SECURITY DEFINER RPC 経由（直 INSERT 禁止）。

-- ── 2. (b) 一般 member 向け published view ──────────────────────────
--   ★ contributor 由来の内部 field を **含めない**:
--     contributor_opaque_key / content_fingerprint / provenance_note は SELECT しない。
--     （provenance は internal 監査用であり public payload ではない）
CREATE OR REPLACE VIEW career_company_knowledge_published AS
  SELECT
    c.company_id,
    m.display_name          AS company_display_name,
    c.content_category,
    c.evidence_summary,
    c.evidence_kind,
    c.observed_period,
    c.selection_category,
    c.role_category,
    c.version
  FROM career_company_knowledge_contributions c
  JOIN career_company_master m ON m.company_id = c.company_id
  JOIN career_company_knowledge_moderation md ON md.contribution_id = c.contribution_id
 WHERE c.lifecycle_state = 'published'
   AND md.state          = 'approved'
   AND md.pii_scan       = 'clean'
   AND md.confidentiality = 'low'
   AND md.abuse          <> 'upheld'
   AND COALESCE(c.legal_hold, false) = false
   AND COALESCE(c.revoked,    false) = false
   AND COALESCE(c.expired,    false) = false;

COMMENT ON VIEW career_company_knowledge_published IS
  'Public shared-knowledge projection. MUST NOT expose contributor_opaque_key, content_fingerprint, provenance_note, or any auth identifier.';

-- ★ security_invoker: view の実行者権限で下位 table の RLS を評価させる
--   （既定の security definer view だと RLS を迂回してしまう）。
ALTER VIEW career_company_knowledge_published SET (security_invoker = on);

-- ⚠ security_invoker = on のため、view を読むには下位 table の SELECT 権限が要る。
--   一般 member に contribution table 全体を開けたくないので、
--   **published 行だけを許可する追加 policy** を張る。
DROP POLICY IF EXISTS "career_ck_contributions published read" ON career_company_knowledge_contributions;
CREATE POLICY "career_ck_contributions published read"
  ON career_company_knowledge_contributions
  FOR SELECT TO authenticated
  USING (
    lifecycle_state = 'published'
    AND COALESCE(legal_hold, false) = false
    AND COALESCE(revoked,    false) = false
    AND COALESCE(expired,    false) = false
  );

DROP POLICY IF EXISTS "career_ck_moderation published read" ON career_company_knowledge_moderation;
CREATE POLICY "career_ck_moderation published read"
  ON career_company_knowledge_moderation
  FOR SELECT TO authenticated
  USING (state = 'approved' AND pii_scan = 'clean' AND confidentiality = 'low');

DROP POLICY IF EXISTS "career_company_master read" ON career_company_master;
CREATE POLICY "career_company_master read"
  ON career_company_master
  FOR SELECT TO authenticated
  USING (true);  -- 企業マスタは個人データではない

-- ── 3. GRANT（★ 最後）─────────────────────────────────────────────
GRANT SELECT ON career_company_master TO authenticated;
GRANT SELECT ON career_company_knowledge_contributions TO authenticated;
GRANT SELECT ON career_company_knowledge_moderation TO authenticated;
GRANT SELECT ON career_company_knowledge_published TO authenticated;
-- anon には一切付与しない。
-- consent_snapshots / audit_events / takedown_requests / versions /
-- evidence_groups は **開放しない**（運用者向け。GRANT も policy も作らない）。

COMMIT;

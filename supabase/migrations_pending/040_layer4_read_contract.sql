-- ============================================================================
-- ⛔ PRODUCTION CANDIDATE — NOT APPLIED ⛔
--
-- PASSAI CAREER — Layer 4 read contract（`D-P6`）。
--
-- ★ suppressed 行は数値を持たないが「存在自体」が小 cohort を示唆するため、
--   read 対象から外す（complementary suppression）。
-- ★ 順序: ENABLE RLS（既に有効）→ CREATE POLICY → GRANT。
-- ============================================================================

BEGIN;

-- ── 1. read index ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS career_aggregate_artifacts_read_idx
  ON career_aggregate_artifacts (metric_key, feature, cohort_type, cohort_value, time_bucket, audience);

CREATE INDEX IF NOT EXISTS career_aggregate_artifacts_retention_idx
  ON career_aggregate_artifacts (generated_at);

-- ── 2. policy（published かつ valid かつ TTL 内のみ）─────────────────
DROP POLICY IF EXISTS "career_aggregate_artifacts member read" ON career_aggregate_artifacts;
CREATE POLICY "career_aggregate_artifacts member read"
  ON career_aggregate_artifacts
  FOR SELECT TO authenticated
  USING (
    publish_state = 'published'
    AND kind      = 'valid'      -- suppressed / zero は返さない
    AND expires_at > now()       -- TTL 切れは返さない
  );

-- ⚠ canary allowlist は **アプリ層の gate**（evaluateActivation）で行う。
--   RLS に user list を焼き込まない（allowlist 変更のたびに migration したくない）。

-- ── 3. GRANT（★ 最後）─────────────────────────────────────────────
GRANT SELECT ON career_aggregate_artifacts TO authenticated;
-- batches / invalidations / regeneration_requests / audit_events は **開放しない**
--   （window や再生成タイミングが漏れるため。GRANT も policy も作らない）。

COMMIT;

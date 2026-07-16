-- ============================================================================
-- Gate A — CONCURRENCY, SESSION B (career_generation_jobs) — A-13 dedup.
--
-- Run this in a SECOND, independent Supabase SQL Editor tab AFTER Session A
-- (gate_a_concurrency_session_a.sql, STEP A1) has committed its running row.
-- This is the second, independent session that must observe ALREADY_RUNNING
-- and confirm NO duplicate row was created (the natural-key dedup guarantee).
--
-- This script does NOT write or commit any row (the claim on an already-running
-- job returns ALREADY_RUNNING without inserting). Cleanup is done by Session A
-- STEP A2.
--
-- BEFORE RUNNING — use the SAME two values you put in Session A:
--     <<REPLACE_USER_A_UUID>>  → Gate-A test user A id (same as Session A)
--     <<REPLACE_SHARED_KEY>>   → the SAME 'gate-a-...' shared key as Session A
-- ============================================================================

DO $blk$
DECLARE
  v_user_a uuid := '<<REPLACE_USER_A_UUID>>';
  v_key    text := '<<REPLACE_SHARED_KEY>>';
  v_out text; v_cnt bigint;
BEGIN
  IF v_key = '<<REPLACE_SHARED_KEY>>' OR v_user_a::text = '<<REPLACE_USER_A_UUID>>' THEN
    RAISE EXCEPTION 'A-13 Session B: fill USER_A uuid and shared key placeholders first (same as Session A).';
  END IF;
  IF v_key NOT LIKE 'gate-a-%' THEN
    RAISE EXCEPTION 'A-13 Session B: shared key must start with ''gate-a-'' (got %).', v_key;
  END IF;

  -- Session A must have committed exactly one running row for this key.
  SELECT count(*) INTO v_cnt FROM public.career_generation_jobs WHERE idempotency_key = v_key;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'A-13 Session B: expected exactly 1 pre-existing row from Session A, found % (run Session A STEP A1 first).', v_cnt;
  END IF;

  -- Independent claim on the SAME natural key → must dedup to ALREADY_RUNNING.
  SET LOCAL ROLE service_role;
  SELECT outcome INTO v_out
  FROM public.career_generation_job_claim(
    v_user_a, 'self_analysis', 'summary', v_key, 'ir', 'pr', 'osr', 'claude-test',
    360, 3, ARRAY['PARSE_FAILED','SCHEMA_VALIDATION_FAILED']::text[]);
  RESET ROLE;

  IF v_out <> 'ALREADY_RUNNING' THEN
    RAISE EXCEPTION 'A-13 Session B FAIL: expected ALREADY_RUNNING, got % (dedup broken).', v_out;
  END IF;

  -- No duplicate row may have been created.
  SELECT count(*) INTO v_cnt FROM public.career_generation_jobs WHERE idempotency_key = v_key;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'A-13 Session B FAIL: duplicate row created — count=% (expected 1).', v_cnt;
  END IF;

  RAISE NOTICE 'A-13 Session B: PASS — ALREADY_RUNNING, still exactly 1 row (no duplicate).';
  RAISE NOTICE 'A-13 Session B: NOW return to Session A and run STEP A2 to delete the fixture row.';
END
$blk$;

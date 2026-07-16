-- ============================================================================
-- Gate A — CONCURRENCY, SESSION A (career_generation_jobs) — A-13 dedup.
--
-- WHY TWO SESSIONS: true concurrency / cross-session natural-key dedup cannot be
--   proven by sequential statements in one session. Run this Session A script in
--   one Supabase SQL Editor tab, then gate_a_concurrency_session_b.sql in a
--   SECOND tab (independent session/connection), then STEP A2 below to clean up.
--   Single-session sequential runs must NEVER be reported as a concurrency PASS.
--
-- LIVE-WRITE NOTICE (read before running):
--   Unlike the single-session harness, STEP A1 COMMITS exactly ONE row to the
--   live project so Session B can observe it across connections. It references a
--   dedicated Gate-A TEST USER (created via Supabase Auth, deletable afterwards),
--   NOT a real end-user and NOT a SQL fixture INSERT into auth.users. STEP A2
--   deletes that one row (guarded). This is the only committed write in Gate A.
--
-- SAFETY:
--   * Touches ONLY career_generation_jobs + career_generation_job_claim(...).
--   * NO auth.users writes, NO other business table, NO pilot-flag change,
--     NO extensions/dblink/RPC creation.
--   * Every write is guarded by an exact idempotency_key literal + 'gate-a-%'
--     prefix + a rowcount assertion; a mismatch RAISES and touches nothing.
--
-- BEFORE RUNNING — replace the two placeholders in BOTH session scripts with the
--   SAME values:
--     <<REPLACE_USER_A_UUID>>  → the auth.users id of Gate-A test user A
--     <<REPLACE_SHARED_KEY>>   → e.g. 'gate-a-concurrency-<random>' (MUST start
--                                 with 'gate-a-'; identical in Session A and B)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP A1 — claim + COMMIT one running row. Run FIRST, then run Session B.
-- ---------------------------------------------------------------------------
BEGIN;
DO $blk$
DECLARE
  v_user_a uuid := '<<REPLACE_USER_A_UUID>>';
  v_key    text := '<<REPLACE_SHARED_KEY>>';
  v_out text; v_job uuid; v_tok uuid; v_cnt bigint;
BEGIN
  IF v_key = '<<REPLACE_SHARED_KEY>>' OR v_user_a::text = '<<REPLACE_USER_A_UUID>>' THEN
    RAISE EXCEPTION 'A-13 Session A: fill USER_A uuid and shared key placeholders first.';
  END IF;
  IF v_key NOT LIKE 'gate-a-%' THEN
    RAISE EXCEPTION 'A-13 Session A: shared key must start with ''gate-a-'' (got %).', v_key;
  END IF;

  -- preflight: test user must exist (created via Supabase Auth, see runbook)
  PERFORM 1 FROM auth.users WHERE id = v_user_a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A-13 Session A preflight: Gate-A test user A not found in auth.users. Create it via Supabase Auth first (do NOT INSERT into auth.users by SQL).';
  END IF;

  -- must start from a clean key (statement guard)
  SELECT count(*) INTO v_cnt FROM public.career_generation_jobs WHERE idempotency_key = v_key;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'A-13 Session A preflight: % pre-existing row(s) for this key. Run STEP A2 cleanup first.', v_cnt;
  END IF;

  -- claim as the server role (service_role) — the only role allowed to execute.
  SET LOCAL ROLE service_role;
  SELECT outcome, job_id, attempt_token INTO v_out, v_job, v_tok
  FROM public.career_generation_job_claim(
    v_user_a, 'self_analysis', 'summary', v_key, 'ir', 'pr', 'osr', 'claude-test',
    360, 3, ARRAY['PARSE_FAILED','SCHEMA_VALIDATION_FAILED']::text[]);
  RESET ROLE;

  IF v_out <> 'CLAIMED_NEW' OR v_tok IS NULL THEN
    RAISE EXCEPTION 'A-13 Session A: expected CLAIMED_NEW with attempt_token, got outcome=%.', v_out;
  END IF;
  SELECT count(*) INTO v_cnt FROM public.career_generation_jobs WHERE idempotency_key = v_key;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'A-13 Session A: expected exactly 1 row after claim, found %.', v_cnt;
  END IF;

  RAISE NOTICE 'A-13 Session A: CLAIMED_NEW job=% (1 running row committed).', v_job;
  RAISE NOTICE 'A-13 Session A: NOW run gate_a_concurrency_session_b.sql in a SECOND tab. Then run STEP A2 (below) to clean up.';
END
$blk$;
COMMIT;

-- ---------------------------------------------------------------------------
-- STEP A2 — CLEANUP. Run ONLY AFTER Session B has reported ALREADY_RUNNING.
--   Deletes the single concurrency fixture row (guarded), then verifies 0 remain.
-- ---------------------------------------------------------------------------
DO $blk$
DECLARE
  v_user_a uuid := '<<REPLACE_USER_A_UUID>>';
  v_key    text := '<<REPLACE_SHARED_KEY>>';
  v_cnt bigint; v_del bigint;
BEGIN
  IF v_key NOT LIKE 'gate-a-%' THEN
    RAISE EXCEPTION 'A-13 cleanup refused: key must start with ''gate-a-'' (got %).', v_key;
  END IF;
  SELECT count(*) INTO v_cnt
  FROM public.career_generation_jobs
  WHERE idempotency_key = v_key AND user_id = v_user_a;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'A-13 cleanup refused (statement guard): expected exactly 1 row to delete, found %.', v_cnt;
  END IF;

  DELETE FROM public.career_generation_jobs
  WHERE idempotency_key = v_key AND user_id = v_user_a AND idempotency_key LIKE 'gate-a-%';
  GET DIAGNOSTICS v_del = ROW_COUNT;
  IF v_del <> 1 THEN
    RAISE EXCEPTION 'A-13 cleanup: deleted % rows (expected exactly 1).', v_del;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.career_generation_jobs WHERE idempotency_key = v_key;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'A-13 cleanup: % row(s) still remain for key after delete.', v_cnt;
  END IF;

  RAISE NOTICE 'A-13 cleanup: OK — deleted 1 concurrency fixture row; 0 remain for key. (Then delete the Gate-A test users via Auth.)';
END
$blk$;

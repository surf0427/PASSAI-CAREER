-- ============================================================================
-- Gate A — SINGLE-SESSION verification harness (career_generation_jobs)
--
-- CLASSIFICATION: CONTROLLED LIVE-PROJECT DATABASE VERIFICATION.
--   Runs against the existing (production/shared) PASSAI CAREER Supabase project.
--   NOT an isolated test DB. Persists NOTHING: every fixture is created inside an
--   internal PL/pgSQL subtransaction that is always rolled back.
--
-- ----------------------------------------------------------------------------
-- OBSERVABILITY — why this version reports via an ERROR, not NOTICE:
--   The Supabase SQL Editor does NOT display `RAISE NOTICE` output (an earlier
--   NOTICE-based version ran as "Success. No rows returned" with the per-case
--   log invisible). The SQL Editor reliably shows only (a) a Results grid and
--   (b) errors. A `DO` block cannot return a grid, and temp result tables are
--   unreliable across the Editor's statement/commit boundaries (that caused an
--   even earlier `42P01`). So this harness ACCUMULATES every case result into a
--   text buffer and ends with ONE intentional `RAISE EXCEPTION` whose message
--   carries the full A-01..A-22 report + SUMMARY. The Editor always shows it.
--
--   => A successful Gate A run STILL ENDS IN A RED ERROR in the SQL Editor.
--      That is the intended, documented reporting mechanism. Read the error
--      message: the last line `VERDICT|GATE_A_SINGLE_SESSION_PASS` means all
--      executed cases passed. `VERDICT|GATE_A_FAIL` (and the FAIL_IDS in the
--      SUMMARY line) means NO-GO. See generation_job_gate_a_runbook.md §2.
--
-- ----------------------------------------------------------------------------
-- ORDERING GUARANTEE (fixture rollback strictly precedes the report exception):
--   1. All fixture DML + the FK-defer DDL happen inside ONE inner subtransaction
--      `BEGIN … EXCEPTION … END`.
--   2. That block ALWAYS raises the sentinel `GA000` at the end of its try body,
--      which aborts the inner subtransaction (rolling back ALL fixtures) and is
--      caught by the block's own handler. Any unexpected error inside the block
--      ALSO aborts the same subtransaction. Either path => on leaving the block,
--      the fixtures are already gone.
--   3. ONLY AFTER the inner block returns do we build the SUMMARY and raise the
--      final report exception. The outer scope performs NO fixture DML, so the
--      final exception cannot create or leave any fixture — cleanup already
--      completed at step 2, strictly before step 3 in program order.
--   4. The outer transaction has no pending fixture writes to commit (all were in
--      the rolled-back inner subtransaction; structural cases are read-only), so
--      the final exception commits nothing. Residual `gate-a-%` rows = 0.
--
-- WHAT THIS IS / IS NOT:
--   DB-level RLS + GRANT + claim-contract verification via SET LOCAL ROLE and
--   request.jwt.claims. NOT a real-JWT / PostgREST / GoTrue end-to-end test.
--   Roles always restored (RESET ROLE + inner subtransaction rollback).
--
-- SAFETY (Gate A allowlist): touches ONLY career_generation_jobs +
--   career_generation_job_claim(...). NO auth.users writes, NO other business
--   table, NO extensions/dblink, NO arbitrary-SQL RPC, NO new persistent
--   function, NO permanent result table (public or otherwise), NO existing-object
--   change (the FK-defer ALTER is subtransaction-local and rolled back), NO pilot
--   flag. Fixture user ids are RANDOM synthetic UUIDs; the auth.users FK is
--   deferred inside the rolled-back subtransaction. Keys are all 'gate-a-%';
--   setup UPDATEs are guarded by id + 'gate-a-%' + a rowcount assertion.
--
-- PREREQUISITE: apply supabase/career_generation_jobs_apply.sql first (operator).
-- POST-RUN residual check: run the commented query at the bottom — expect 0.
-- ============================================================================

DO $harness$
DECLARE
  v_run   text;
  v_ua    uuid;
  v_ub    uuid;
  v_can   boolean := false;
  v_sig   text := 'public.career_generation_job_claim(uuid,text,text,text,text,text,text,text,integer,integer,text[])';

  -- report buffer + tally (LOCAL — survive the inner subtransaction rollback)
  v_report text := '';
  v_pass  int := 0;
  v_ne    int := 0;
  v_fail  int := 0;
  v_fail_ids text := '';
  st      text;

  -- scratch
  v_fk text; v_missing text; v_col text; v_ok boolean; v_secdef boolean; v_cfg text;

  -- behavioral
  v_out text; v_job uuid; v_t1 uuid; v_t2 uuid; v_cnt int; v_rc int;
  v_status text; v_ecode text; v_res jsonb; v_key text; vis int; hid int; v_step int;

  -- permission
  v_ins boolean; v_upd boolean; v_del boolean; v_sel boolean; v_awrite boolean; v_exec boolean;
BEGIN
  -- Preflight (read-only). Hard stop with a visible message if not applied.
  IF to_regclass('public.career_generation_jobs') IS NULL THEN
    RAISE EXCEPTION 'GATE_A_PREFLIGHT|table public.career_generation_jobs not found — apply supabase/career_generation_jobs_apply.sql first (see runbook).';
  END IF;
  v_run := replace(gen_random_uuid()::text, '-', '');
  v_ua  := gen_random_uuid();
  v_ub  := gen_random_uuid();

  -- Big guard: any unexpected error in the structural (read-only) section still
  -- lands us at the final report instead of surfacing a bare error.
  BEGIN
    -- ======================================================================
    -- STRUCTURAL (read-only)
    -- ======================================================================

    -- A-01 objects exist
    v_missing := '';
    IF to_regclass('public.career_generation_jobs') IS NULL THEN v_missing:=v_missing||'table '; END IF;
    IF to_regprocedure(v_sig) IS NULL THEN v_missing:=v_missing||'claim_fn '; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='career_generation_jobs'
                   AND policyname='career_generation_jobs_owner_select') THEN v_missing:=v_missing||'policy '; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='career_generation_jobs_set_updated_at'
                   AND tgrelid='public.career_generation_jobs'::regclass) THEN v_missing:=v_missing||'trigger '; END IF;
    st := CASE WHEN v_missing='' THEN 'PASS' ELSE 'FAIL' END;
    v_report := v_report || format('A-01|%s|%s', st, CASE WHEN v_missing='' THEN 'table+fn+policy+trigger present' ELSE 'missing: '||v_missing END) || E'\n';
    IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-01 '; END IF;

    -- A-02 idempotent re-apply (operator step)
    v_report := v_report || 'A-02|NOT_EXECUTED|operator re-runs career_generation_jobs_apply.sql; expect no error (IF NOT EXISTS/OR REPLACE). Migration & verify kept separate.' || E'\n';
    v_ne:=v_ne+1;

    -- A-03 columns / types
    v_missing := '';
    FOREACH v_col IN ARRAY ARRAY[
      'id','user_id','feature','operation','idempotency_key','input_revision','prompt_revision',
      'output_schema_revision','model','status','attempt_token','lease_expires_at','attempt_count',
      'result','error_code','provider_duration_ms','total_duration_ms','ttft_ms','started_at',
      'completed_at','failed_at','created_at','updated_at'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.career_generation_jobs'::regclass
                     AND attname=v_col AND attnum>0 AND NOT attisdropped) THEN v_missing:=v_missing||v_col||' '; END IF;
    END LOOP;
    v_ok := (v_missing='')
        AND (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.career_generation_jobs'::regclass AND attname='user_id')='uuid'
        AND (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.career_generation_jobs'::regclass AND attname='result')='jsonb';
    st := CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END;
    v_report := v_report || format('A-03|%s|%s', st, CASE WHEN v_ok THEN 'all 23 columns; user_id uuid; result jsonb' ELSE 'missing/typemismatch: '||v_missing END) || E'\n';
    IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-03 '; END IF;

    -- A-04 indexes + unique natural key
    v_missing := '';
    FOREACH v_col IN ARRAY ARRAY[
      'career_generation_jobs_pkey','career_generation_jobs_natural_key',
      'career_generation_jobs_user_feature_created_idx','career_generation_jobs_running_lease_idx'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                     AND tablename='career_generation_jobs' AND indexname=v_col) THEN v_missing:=v_missing||v_col||' '; END IF;
    END LOOP;
    v_ok := (v_missing='') AND EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid='public.career_generation_jobs'::regclass AND contype='u'
                  AND conname='career_generation_jobs_natural_key');
    st := CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END;
    v_report := v_report || format('A-04|%s|%s', st, CASE WHEN v_ok THEN '4 indexes; natural key UNIQUE' ELSE 'missing: '||v_missing END) || E'\n';
    IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-04 '; END IF;

    -- A-05 function SECURITY DEFINER + search_path
    SELECT prosecdef, array_to_string(proconfig, ',') INTO v_secdef, v_cfg FROM pg_proc WHERE oid=to_regprocedure(v_sig);
    v_ok := COALESCE(v_secdef,false) AND COALESCE(v_cfg,'') LIKE '%search_path=%public%pg_temp%';
    st := CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END;
    v_report := v_report || format('A-05|%s|%s', st, CASE WHEN v_ok THEN 'prosecdef=t; search_path=public,pg_temp' ELSE format('prosecdef=%s proconfig=%s', v_secdef, v_cfg) END) || E'\n';
    IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-05 '; END IF;

    -- A-06 GRANT/REVOKE matrix (table + fn)
    v_ok :=
         has_table_privilege('authenticated','public.career_generation_jobs','SELECT')  = true
     AND has_table_privilege('authenticated','public.career_generation_jobs','INSERT')  = false
     AND has_table_privilege('authenticated','public.career_generation_jobs','UPDATE')  = false
     AND has_table_privilege('authenticated','public.career_generation_jobs','DELETE')  = false
     AND has_table_privilege('anon','public.career_generation_jobs','SELECT')           = false
     AND has_table_privilege('anon','public.career_generation_jobs','INSERT')           = false
     AND has_table_privilege('service_role','public.career_generation_jobs','INSERT')   = true
     AND has_function_privilege('service_role',  v_sig, 'EXECUTE')                      = true
     AND has_function_privilege('authenticated', v_sig, 'EXECUTE')                      = false
     AND has_function_privilege('anon',          v_sig, 'EXECUTE')                      = false;
    st := CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END;
    v_report := v_report || format('A-06|%s|%s', st, CASE WHEN v_ok THEN 'authenticated=SELECT only; anon=none; service_role=write; claim EXECUTE=service_role only' ELSE 'grant matrix mismatch' END) || E'\n';
    IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-06 '; END IF;

    -- S-RLS-ENABLED
    v_ok := (SELECT relrowsecurity FROM pg_class WHERE oid='public.career_generation_jobs'::regclass);
    st := CASE WHEN v_ok THEN 'PASS' ELSE 'FAIL' END;
    v_report := v_report || format('S-RLS-ENABLED|%s|%s', st, CASE WHEN v_ok THEN 'relrowsecurity=t' ELSE 'RLS NOT enabled' END) || E'\n';
    IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'S-RLS-ENABLED '; END IF;

    -- S-POLICY-DEF
    SELECT (cmd='SELECT' AND 'authenticated'=ANY(roles) AND qual IS NOT NULL AND qual LIKE '%uid%' AND qual LIKE '%user_id%')
      INTO v_ok FROM pg_policies
     WHERE schemaname='public' AND tablename='career_generation_jobs' AND policyname='career_generation_jobs_owner_select';
    st := CASE WHEN COALESCE(v_ok,false) THEN 'PASS' ELSE 'FAIL' END;
    v_report := v_report || format('S-POLICY-DEF|%s|%s', st, CASE WHEN COALESCE(v_ok,false) THEN 'SELECT / authenticated / auth.uid()=user_id' ELSE 'policy def mismatch/absent' END) || E'\n';
    IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'S-POLICY-DEF '; END IF;

    -- A-13 concurrency — never single-session
    v_report := v_report || 'A-13|NOT_EXECUTED|requires TWO independent sessions (gate_a_concurrency_session_a.sql then _session_b.sql). Sequential single-session is NOT a concurrency PASS.' || E'\n';
    v_ne:=v_ne+1;

    -- ======================================================================
    -- TABLE-TOUCHING PHASE — inner subtransaction, rolled back by GA000.
    -- ======================================================================
    BEGIN
      -- Defer the auth.users FK for this subtransaction only.
      BEGIN
        SELECT conname INTO v_fk FROM pg_constraint
         WHERE conrelid='public.career_generation_jobs'::regclass AND contype='f' LIMIT 1;
        IF v_fk IS NOT NULL THEN
          EXECUTE format('ALTER TABLE public.career_generation_jobs ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', v_fk);
          v_can := true;
        END IF;
      EXCEPTION WHEN OTHERS THEN v_can := false;
      END;

      -- A-09 authenticated INSERT/UPDATE/DELETE denied
      BEGIN
        SET LOCAL ROLE authenticated;
        BEGIN INSERT INTO public.career_generation_jobs (user_id,feature,operation,idempotency_key,input_revision,prompt_revision,output_schema_revision,model,status)
              VALUES (gen_random_uuid(),'self_analysis','summary','gate-a-a09i-'||v_run,'ir','pr','osr','claude-test','queued');
              v_ins:=false; EXCEPTION WHEN insufficient_privilege THEN v_ins:=true; END;
        BEGIN UPDATE public.career_generation_jobs SET updated_at=now() WHERE idempotency_key='gate-a-a09u-'||v_run;
              v_upd:=false; EXCEPTION WHEN insufficient_privilege THEN v_upd:=true; END;
        BEGIN DELETE FROM public.career_generation_jobs WHERE idempotency_key='gate-a-a09d-'||v_run;
              v_del:=false; EXCEPTION WHEN insufficient_privilege THEN v_del:=true; END;
        RESET ROLE;
        st := CASE WHEN v_ins AND v_upd AND v_del THEN 'PASS' ELSE 'FAIL' END;
        v_report := v_report || format('A-09|%s|insert_denied=%s update_denied=%s delete_denied=%s', st, v_ins, v_upd, v_del) || E'\n';
        IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-09 '; END IF;
      EXCEPTION WHEN OTHERS THEN RESET ROLE;
        v_report := v_report || 'A-09|NOT_EXECUTED|could not SET ROLE authenticated: '||SQLERRM || E'\n'; v_ne:=v_ne+1;
      END;

      -- A-10 anon SELECT + write denied
      BEGIN
        SET LOCAL ROLE anon;
        BEGIN PERFORM 1 FROM public.career_generation_jobs LIMIT 1; v_sel:=false;
              EXCEPTION WHEN insufficient_privilege THEN v_sel:=true; END;
        BEGIN INSERT INTO public.career_generation_jobs (user_id,feature,operation,idempotency_key,input_revision,prompt_revision,output_schema_revision,model,status)
              VALUES (gen_random_uuid(),'self_analysis','summary','gate-a-a10-'||v_run,'ir','pr','osr','claude-test','queued');
              v_awrite:=false; EXCEPTION WHEN insufficient_privilege THEN v_awrite:=true; END;
        RESET ROLE;
        st := CASE WHEN v_sel AND v_awrite THEN 'PASS' ELSE 'FAIL' END;
        v_report := v_report || format('A-10|%s|select_denied=%s write_denied=%s', st, v_sel, v_awrite) || E'\n';
        IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-10 '; END IF;
      EXCEPTION WHEN OTHERS THEN RESET ROLE;
        v_report := v_report || 'A-10|NOT_EXECUTED|could not SET ROLE anon: '||SQLERRM || E'\n'; v_ne:=v_ne+1;
      END;

      -- A-11 authenticated EXECUTE of claim fn denied
      BEGIN
        SET LOCAL ROLE authenticated;
        BEGIN PERFORM 1 FROM public.career_generation_job_claim(gen_random_uuid(),'self_analysis','summary','gate-a-a11-'||v_run,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
              v_exec:=false; EXCEPTION WHEN insufficient_privilege THEN v_exec:=true; END;
        RESET ROLE;
        st := CASE WHEN v_exec THEN 'PASS' ELSE 'FAIL' END;
        v_report := v_report || format('A-11|%s|execute_denied=%s', st, v_exec) || E'\n';
        IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-11 '; END IF;
      EXCEPTION WHEN OTHERS THEN RESET ROLE;
        v_report := v_report || 'A-11|NOT_EXECUTED|could not SET ROLE authenticated: '||SQLERRM || E'\n'; v_ne:=v_ne+1;
      END;

      IF NOT v_can THEN
        FOREACH v_col IN ARRAY ARRAY['A-07','A-08','A-12','A-14','A-15','A-16','A-17','A-18','A-19','A-20','A-21','A-22'] LOOP
          v_report := v_report || v_col || '|NOT_EXECUTED|row fixtures unavailable: FK could not be deferred (need table owner; run as postgres).' || E'\n';
          v_ne:=v_ne+1;
        END LOOP;
      ELSE
        -- A-07 / A-08 RLS owner vs cross-owner
        BEGIN
          INSERT INTO public.career_generation_jobs (user_id,feature,operation,idempotency_key,input_revision,prompt_revision,output_schema_revision,model,status)
          VALUES (v_ua,'self_analysis','summary','gate-a-a07-'||v_run,'ir','pr','osr','claude-test','queued');
          INSERT INTO public.career_generation_jobs (user_id,feature,operation,idempotency_key,input_revision,prompt_revision,output_schema_revision,model,status)
          VALUES (v_ub,'self_analysis','summary','gate-a-a08-'||v_run,'ir','pr','osr','claude-test','queued');
          SET LOCAL ROLE authenticated;
          PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ua::text, 'role','authenticated')::text, true);
          PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
          SELECT count(*) INTO vis FROM public.career_generation_jobs WHERE user_id=v_ua AND idempotency_key LIKE 'gate-a-%';
          SELECT count(*) INTO hid FROM public.career_generation_jobs WHERE user_id=v_ub AND idempotency_key LIKE 'gate-a-%';
          RESET ROLE;
          PERFORM set_config('request.jwt.claims','',true);
          PERFORM set_config('request.jwt.claim.sub','',true);
          st := CASE WHEN vis>=1 THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-07|%s|owner-visible rows=%s (expected >=1)', st, vis) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-07 '; END IF;
          st := CASE WHEN hid=0 THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-08|%s|other-owner rows visible=%s (expected 0)', st, hid) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-08 '; END IF;
        EXCEPTION WHEN OTHERS THEN
          RESET ROLE; PERFORM set_config('request.jwt.claims','',true); PERFORM set_config('request.jwt.claim.sub','',true);
          v_report := v_report || 'A-07|FAIL|'||SQLERRM || E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-07 ';
          v_report := v_report || 'A-08|FAIL|(same block error)' || E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-08 ';
        END;

        -- A-12 service_role claim CLAIMED_NEW
        BEGIN
          SET LOCAL ROLE service_role;
          SELECT outcome, job_id, attempt_token INTO v_out, v_job, v_t1
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary','gate-a-a12-'||v_run,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          RESET ROLE;
          st := CASE WHEN v_out='CLAIMED_NEW' AND v_t1 IS NOT NULL THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-12|%s|outcome=%s attempt_token_present=%s', st, v_out, (v_t1 IS NOT NULL)) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-12 '; END IF;
        EXCEPTION WHEN OTHERS THEN RESET ROLE;
          v_report := v_report || 'A-12|FAIL|'||SQLERRM || E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-12 ';
        END;

        -- A-14 / A-15 / A-16 attempt-token fencing (one job)
        v_step := 0;
        BEGIN
          v_key := 'gate-a-a16-fencing-'||v_run;
          SELECT outcome, job_id, attempt_token INTO v_out, v_job, v_t1
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          UPDATE public.career_generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=v_job AND idempotency_key LIKE 'gate-a-%';
          GET DIAGNOSTICS v_rc=ROW_COUNT; IF v_rc<>1 THEN RAISE EXCEPTION 'stale-lease setup hit % rows', v_rc; END IF;
          SELECT outcome, attempt_token INTO v_out, v_t2
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);

          UPDATE public.career_generation_jobs SET status='completed', result='{"summary":"gate-a"}'::jsonb, completed_at=now(),
                 provider_duration_ms=1, total_duration_ms=1, attempt_token=NULL, lease_expires_at=NULL, updated_at=now()
           WHERE id=v_job AND user_id=v_ua AND attempt_token=v_t1 AND status='running';
          GET DIAGNOSTICS v_rc=ROW_COUNT;
          st := CASE WHEN v_rc=0 THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-14|%s|old-token complete rows=%s (expected 0)', st, v_rc) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-14 '; END IF; v_step:=1;

          UPDATE public.career_generation_jobs SET status='failed', error_code='NETWORK', failed_at=now(),
                 result=NULL, attempt_token=NULL, lease_expires_at=NULL, updated_at=now()
           WHERE id=v_job AND user_id=v_ua AND attempt_token=v_t1 AND status='running';
          GET DIAGNOSTICS v_rc=ROW_COUNT;
          st := CASE WHEN v_rc=0 THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-15|%s|old-token fail rows=%s (expected 0)', st, v_rc) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-15 '; END IF; v_step:=2;

          UPDATE public.career_generation_jobs SET status='completed', result='{"summary":"gate-a"}'::jsonb, completed_at=now(),
                 provider_duration_ms=1, total_duration_ms=1, attempt_token=NULL, lease_expires_at=NULL, updated_at=now()
           WHERE id=v_job AND user_id=v_ua AND attempt_token=v_t2 AND status='running';
          GET DIAGNOSTICS v_rc=ROW_COUNT;
          SELECT status INTO v_status FROM public.career_generation_jobs WHERE id=v_job;
          st := CASE WHEN v_rc=1 AND v_status='completed' THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-16|%s|current-token complete rows=%s status=%s', st, v_rc, v_status) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-16 '; END IF; v_step:=3;
        EXCEPTION WHEN OTHERS THEN
          IF v_step<1 THEN v_report:=v_report||'A-14|FAIL|fencing group error: '||SQLERRM||E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-14 '; END IF;
          IF v_step<2 THEN v_report:=v_report||'A-15|FAIL|fencing group error'||E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-15 '; END IF;
          IF v_step<3 THEN v_report:=v_report||'A-16|FAIL|fencing group error'||E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-16 '; END IF;
        END;

        -- A-17 stale reclaim
        BEGIN
          v_key := 'gate-a-a17-'||v_run;
          SELECT attempt_token, job_id INTO v_t1, v_job
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          UPDATE public.career_generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=v_job AND idempotency_key LIKE 'gate-a-%';
          GET DIAGNOSTICS v_rc=ROW_COUNT; IF v_rc<>1 THEN RAISE EXCEPTION 'setup hit % rows', v_rc; END IF;
          SELECT outcome, attempt_token, attempt_count INTO v_out, v_t2, v_cnt
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          st := CASE WHEN v_out='CLAIMED_RETRY' AND v_t2 IS DISTINCT FROM v_t1 AND v_cnt=2 THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-17|%s|outcome=%s token_rotated=%s attempt_count=%s', st, v_out, (v_t2 IS DISTINCT FROM v_t1), v_cnt) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-17 '; END IF;
        EXCEPTION WHEN OTHERS THEN v_report:=v_report||'A-17|FAIL|'||SQLERRM||E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-17 '; END;

        -- A-18 completed reuse
        BEGIN
          v_key := 'gate-a-a18-'||v_run;
          SELECT job_id, attempt_token INTO v_job, v_t1
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          UPDATE public.career_generation_jobs SET status='completed', result='{"summary":"gate-a"}'::jsonb, completed_at=now(),
                 provider_duration_ms=1, total_duration_ms=1, attempt_token=NULL, lease_expires_at=NULL, updated_at=now()
           WHERE id=v_job AND user_id=v_ua AND attempt_token=v_t1 AND status='running';
          GET DIAGNOSTICS v_rc=ROW_COUNT; IF v_rc<>1 THEN RAISE EXCEPTION 'complete setup hit % rows', v_rc; END IF;
          SELECT outcome INTO v_out
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          st := CASE WHEN v_out='ALREADY_COMPLETED' THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-18|%s|outcome=%s', st, v_out) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-18 '; END IF;
        EXCEPTION WHEN OTHERS THEN v_report:=v_report||'A-18|FAIL|'||SQLERRM||E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-18 '; END;

        -- A-19 retryable failed reclaim
        BEGIN
          v_key := 'gate-a-a19-'||v_run;
          SELECT job_id INTO v_job
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          UPDATE public.career_generation_jobs SET status='failed', error_code='NETWORK', failed_at=now(),
                 result=NULL, attempt_token=NULL, lease_expires_at=NULL, updated_at=now()
           WHERE id=v_job AND idempotency_key LIKE 'gate-a-%';
          GET DIAGNOSTICS v_rc=ROW_COUNT; IF v_rc<>1 THEN RAISE EXCEPTION 'fail setup hit % rows', v_rc; END IF;
          SELECT outcome INTO v_out
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          st := CASE WHEN v_out='CLAIMED_RETRY' THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-19|%s|outcome=%s (NETWORK not in nonretryable)', st, v_out) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-19 '; END IF;
        EXCEPTION WHEN OTHERS THEN v_report:=v_report||'A-19|FAIL|'||SQLERRM||E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-19 '; END;

        -- A-20 non-retryable fixed
        BEGIN
          v_key := 'gate-a-a20-'||v_run;
          SELECT job_id INTO v_job
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          UPDATE public.career_generation_jobs SET status='failed', error_code='PARSE_FAILED', failed_at=now(),
                 result=NULL, attempt_token=NULL, lease_expires_at=NULL, updated_at=now()
           WHERE id=v_job AND idempotency_key LIKE 'gate-a-%';
          GET DIAGNOSTICS v_rc=ROW_COUNT; IF v_rc<>1 THEN RAISE EXCEPTION 'fail setup hit % rows', v_rc; END IF;
          SELECT outcome INTO v_out
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          st := CASE WHEN v_out='FAILED_NON_RETRYABLE' THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-20|%s|outcome=%s (PARSE_FAILED in nonretryable)', st, v_out) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-20 '; END IF;
        EXCEPTION WHEN OTHERS THEN v_report:=v_report||'A-20|FAIL|'||SQLERRM||E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-20 '; END;

        -- A-21 MAX_ATTEMPTS terminal
        BEGIN
          v_key := 'gate-a-a21-'||v_run;
          SELECT job_id INTO v_job
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          UPDATE public.career_generation_jobs SET attempt_count=3, lease_expires_at=now()-interval '1 second', updated_at=now()
           WHERE id=v_job AND idempotency_key LIKE 'gate-a-%';
          GET DIAGNOSTICS v_rc=ROW_COUNT; IF v_rc<>1 THEN RAISE EXCEPTION 'setup hit % rows', v_rc; END IF;
          SELECT outcome INTO v_out
          FROM public.career_generation_job_claim(v_ua,'self_analysis','summary',v_key,'ir','pr','osr','claude-test',360,3,ARRAY['PARSE_FAILED']::text[]);
          SELECT status, error_code INTO v_status, v_ecode FROM public.career_generation_jobs WHERE id=v_job;
          st := CASE WHEN v_out='RETRY_LIMIT_REACHED' AND v_status='failed' AND v_ecode='RETRY_LIMIT_REACHED' THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-21|%s|outcome=%s row_status=%s error_code=%s', st, v_out, v_status, v_ecode) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-21 '; END IF;
        EXCEPTION WHEN OTHERS THEN v_report:=v_report||'A-21|FAIL|'||SQLERRM||E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-21 '; END;

        -- A-22 raw non-persistence
        BEGIN
          SELECT string_agg(attname, ' ') INTO v_col
          FROM pg_attribute
          WHERE attrelid='public.career_generation_jobs'::regclass AND attnum>0 AND NOT attisdropped
            AND attname NOT IN ('input_revision','prompt_revision','output_schema_revision')
            AND attname ~ '(prompt|conversation|messages|raw|provider_response|provider_request|pii|email|output_text|input_body|result_text)';
          SELECT result INTO v_res
          FROM public.career_generation_jobs
          WHERE user_id=v_ua AND idempotency_key='gate-a-a16-fencing-'||v_run AND status='completed' LIMIT 1;
          st := CASE WHEN v_col IS NULL AND v_res='{"summary":"gate-a"}'::jsonb THEN 'PASS' ELSE 'FAIL' END;
          v_report := v_report || format('A-22|%s|%s', st, CASE WHEN v_col IS NULL AND v_res='{"summary":"gate-a"}'::jsonb
               THEN 'no raw-body columns; completed result is structured jsonb only'
               ELSE format('raw_body_columns=[%s] result=%s', COALESCE(v_col,''), v_res) END) || E'\n';
          IF st='PASS' THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-22 '; END IF;
        EXCEPTION WHEN OTHERS THEN v_report:=v_report||'A-22|FAIL|'||SQLERRM||E'\n'; v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'A-22 '; END;
      END IF;

      -- SENTINEL: discard ALL fixtures + the FK-defer DDL (rolls back this subtxn).
      RAISE EXCEPTION USING ERRCODE='GA000', MESSAGE='__gate_a_rollback_fixtures__';
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE <> 'GA000' THEN
        v_report := v_report || 'INNER|FAIL|unexpected error in fixture phase: '||SQLERRM || E'\n';
        v_fail:=v_fail+1; v_fail_ids:=v_fail_ids||'INNER ';
      END IF;
      -- On leaving here the inner subtransaction is rolled back: no fixtures,
      -- FK back to NOT DEFERRABLE, role restored.
    END;
  EXCEPTION WHEN OTHERS THEN
    -- Unexpected error in the structural (read-only) section; still report.
    v_report := v_report || 'HARNESS|FAIL|unexpected structural error: '||SQLERRM || E'\n';
    v_fail := v_fail + 1; v_fail_ids := v_fail_ids || 'HARNESS ';
  END;

  -- ==========================================================================
  -- FINAL REPORT — fixtures are already rolled back (above). This intentional
  -- exception is the ONLY reliable way to surface results in the Supabase SQL
  -- Editor. A PASSING run still shows as a red ERROR; read VERDICT below.
  -- ==========================================================================
  -- Lead with VERDICT + SUMMARY (survives any UI truncation), then per-case lines.
  v_report := E'\n===== GATE_A_REPORT (single session, run_id=' || v_run || E') =====\n'
    || 'Intentional display exception — expected even on full PASS. Nothing persisted (fixtures rolled back).' || E'\n'
    || 'VERDICT|' || CASE WHEN v_fail=0 THEN 'GATE_A_SINGLE_SESSION_PASS' ELSE 'GATE_A_FAIL' END || E'\n'
    || format('SUMMARY|PASS=%s|FAIL=%s|NOT_EXECUTED=%s|FAIL_IDS=%s',
              v_pass, v_fail, v_ne, CASE WHEN v_fail_ids='' THEN '(none)' ELSE v_fail_ids END) || E'\n'
    || '(A-02 re-apply + A-13 concurrency are separate operator/two-session steps; run the residual query below to confirm 0 rows.)' || E'\n'
    || E'\n----- per case (CASE|STATUS|DETAIL) -----\n'
    || v_report;

  RAISE EXCEPTION USING
    MESSAGE = v_report,
    DETAIL  = format('PASS=%s FAIL=%s NOT_EXECUTED=%s FAIL_IDS=%s', v_pass, v_fail, v_ne, CASE WHEN v_fail_ids='' THEN '(none)' ELSE v_fail_ids END),
    HINT    = 'Intentional Gate A report exception — expected even when everything PASSes. No rows were persisted.';
END
$harness$;

-- ============================================================================
-- POST-RUN residual check — run this AS A SEPARATE QUERY after the DO block.
-- The DO block committed nothing, so expected: 0
--
--   SELECT count(*) AS gate_a_rows_remaining
--   FROM public.career_generation_jobs
--   WHERE idempotency_key LIKE 'gate-a-%';
-- ============================================================================

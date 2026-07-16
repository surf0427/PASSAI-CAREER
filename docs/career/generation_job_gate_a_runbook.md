# Gate A — Operator Runbook (career_generation_jobs, members pilot)

**Classification: CONTROLLED LIVE-PROJECT DATABASE VERIFICATION.**
Gate A is executed against the **existing (production/shared) PASSAI CAREER
Supabase project** — this is **not** an isolated test DB. The migration is
applied for real and kept; only the *verification fixtures* are transient.

This runbook is executed manually by the operator in the Supabase SQL Editor.
Claude Code does **not** connect to the DB and does **not** apply the migration.

Deliverables (in this repo):

| File | Purpose |
| --- | --- |
| `supabase/career_generation_jobs_apply.sql` | The migration (applied & **kept**). |
| `supabase/gate_a/gate_a_single_session_verify.sql` | Single-session verify (A-01–A-12, A-14–A-22). Fully rolled back. |
| `supabase/gate_a/gate_a_concurrency_session_a.sql` | Concurrency Session A (A-13): claim + commit + cleanup. |
| `supabase/gate_a/gate_a_concurrency_session_b.sql` | Concurrency Session B (A-13): observe ALREADY_RUNNING. |

---

## 0. What Gate A does and does NOT prove

**Proves (DB layer):** schema/constraints/indexes/trigger/function exist; RLS
enabled + owner policy; GRANT/REVOKE matrix; owner vs cross-owner SELECT; browser
(authenticated/anon) write denial; claim-function EXECUTE restricted to
service_role; atomic claim outcomes; attempt-token fencing; stale reclaim;
completed/failed reuse; MAX_ATTEMPTS terminal; no raw prompt/Claude output
persisted; cross-session natural-key dedup.

**Does NOT prove (deferred to Gate B / Vercel Preview):** real GoTrue-issued JWT
+ PostgREST HTTP enforcement end-to-end; `after()` background continuation and
Fluid Compute; 300 s Max Duration; log redaction; non-silent-fallback. The
single-session harness verifies RLS/GRANT using `SET ROLE` + `request.jwt.claims`
at the **DB level** — this is deliberately **not** a real-JWT / PostgREST E2E test.

---

## 1. Prerequisites

1. **Apply the migration (kept permanently).** In the SQL Editor, run the full
   contents of `supabase/career_generation_jobs_apply.sql`. Expect success, no
   errors. → this is **A-01**.

2. **A-02 idempotent re-apply.** Run the same file a **second** time. Expect no
   error (guarded by `IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP POLICY IF
   EXISTS` / trigger existence check). If it errors, **STOP** (NO-GO).

3. **Create two Gate-A test users** (only needed for the concurrency test A-13).
   Create them through **Supabase Auth** — Dashboard → Authentication → Users →
   *Add user* (or an OTP sign-up). **Do NOT `INSERT INTO auth.users` by SQL.**
   Record their UUIDs as *User A* and *User B*. They are throwaway identities and
   are deleted in step 6. (The single-session harness needs **no** auth users —
   it uses synthetic UUIDs with a deferred FK inside a rolled-back transaction.)

---

## 2. Single-session verification (A-01–A-12, A-14–A-22)

Paste **all** of `supabase/gate_a/gate_a_single_session_verify.sql` into the SQL
Editor and Run. It is a single `DO` block (one statement). Every fixture is
created inside an internal PL/pgSQL subtransaction that is **always rolled back**
(via a `GA000` sentinel), so the script persists nothing. No temp tables, no
script-level `BEGIN/ROLLBACK`.

> **The run ENDS IN A RED ERROR on purpose — even when every case passes.** The
> Supabase SQL Editor does not display `RAISE NOTICE`, and a `DO` block cannot
> return a grid, so the harness reports by raising ONE intentional exception whose
> **error message contains the full A-01–A-22 report**. This is the reliable,
> observable output channel. (An earlier NOTICE version showed only
> "Success. No rows returned"; an even earlier temp-table version failed with
> `42P01`. Both are fixed by this report-via-error design.)

**Where to read it:** the Editor's error panel (the red box shown below the
editor after Run). The message body looks like:

```
===== GATE_A_REPORT (single session, run_id=...) =====
Intentional display exception — expected even on full PASS. Nothing persisted (fixtures rolled back).
VERDICT|GATE_A_SINGLE_SESSION_PASS
SUMMARY|PASS=..|FAIL=0|NOT_EXECUTED=..|FAIL_IDS=(none)
(A-02 re-apply + A-13 concurrency are separate steps; run the residual query to confirm 0 rows.)

----- per case (CASE|STATUS|DETAIL) -----
A-01|PASS|table+fn+policy+trigger present
A-02|NOT_EXECUTED|operator re-runs career_generation_jobs_apply.sql; ...
A-03|PASS|all 23 columns; user_id uuid; result jsonb
... (through A-22) ...
```

**Interpreting it:**

- Read the top two report lines. `VERDICT|GATE_A_SINGLE_SESSION_PASS` with `FAIL=0`
  ⇒ the single-session portion passed (the red ERROR is expected and benign).
- `VERDICT|GATE_A_FAIL` (with `FAIL>0` and the failing Case IDs in `FAIL_IDS`) ⇒
  **NO-GO**. Each failing case's line shows `CASE|FAIL|DETAIL`.
- Per-case status is `PASS` / `FAIL` / `NOT_EXECUTED` in the second `|` field.
  Expected `NOT_EXECUTED`: **A-02** (operator re-apply, step 1.2) and **A-13**
  (concurrency, section 3). If A-07/A-08/A-12/A-14–A-22 are `NOT_EXECUTED` with
  "FK could not be deferred", the SQL Editor role does not own the table — re-run
  as the project `postgres` role.

> Fixture rollback happens strictly BEFORE this report exception (the `GA000`
> sentinel rolls the inner subtransaction back; only afterwards is the report
> raised). The report exception therefore cannot leave any fixture behind —
> confirm with the residual query in 2.1.

### 2.1 S-ROLLBACK — confirm nothing persisted

The `DO` block rolls fixtures back internally and commits nothing, but confirm it
independently. After the run above, execute this **as a separate query**:

```sql
SELECT count(*) AS gate_a_rows_remaining
FROM public.career_generation_jobs
WHERE idempotency_key LIKE 'gate-a-%';
```

Expected: **0**. (Non-zero here would indicate leftover fixtures — investigate
before proceeding; but the single-session harness commits nothing, so the only
source of `gate-a-%` rows is an un-cleaned concurrency run — see 3.4.)

---

## 3. Concurrency verification (A-13) — two independent sessions

A-13 needs true cross-session dedup and therefore **two** independent SQL Editor
sessions. Sequential single-session execution is **not** a concurrency PASS.
This is the **only** step that commits a row to the live project (then deletes it).

1. Edit **both** concurrency files: replace `<<REPLACE_USER_A_UUID>>` with User
   A's UUID and `<<REPLACE_SHARED_KEY>>` with a fresh key such as
   `gate-a-concurrency-001` (must start with `gate-a-`; identical in both files).

2. **Session A tab** — run `gate_a_concurrency_session_a.sql` **STEP A1 only**
   (the `BEGIN;`…`COMMIT;` block). Expect `A-13 Session A: CLAIMED_NEW job=…`.

3. **Session B tab** (a second browser tab / connection) — run
   `gate_a_concurrency_session_b.sql`. Expect
   `A-13 Session B: PASS — ALREADY_RUNNING, still exactly 1 row`.
   If it reports anything other than `ALREADY_RUNNING`, or count ≠ 1, that is a
   dedup failure ⇒ **NO-GO**.

4. **Session A tab** — run **STEP A2** (the cleanup `DO` block) from
   `gate_a_concurrency_session_a.sql`. Expect
   `A-13 cleanup: OK — deleted 1 … 0 remain`. The delete is guarded: it refuses
   unless exactly one `gate-a-%` row for the key/user exists.

> Optional stricter race (psql only, not the hosted editor): in Session A run
> `BEGIN;` + the claim and **do not commit**; in Session B run the claim — it will
> **block** on Session A's uncommitted unique tuple; then `COMMIT` Session A and
> Session B unblocks to `ALREADY_RUNNING`. The hosted SQL Editor cannot reliably
> hold a transaction open between runs, so the committed variant above is the
> supported path.

---

## 4. Gate A pass criteria

**GO** only if **all** of:

- A-01 PASS and A-02 re-apply clean (step 1).
- Single-session A-03–A-12, A-14–A-22 all **PASS** (no FAIL, no unexpected
  `NOT_EXECUTED`).
- S-RLS-ENABLED, S-POLICY-DEF **PASS**.
- S-ROLLBACK query returns 0.
- A-13 Session B reports `ALREADY_RUNNING` with exactly 1 row; cleanup returns 0.

Any FAIL, any raw/secret persistence, any cross-user read, any browser direct
write success, any duplicate job, any stale-token overwrite, any MAX_ATTEMPTS
breach, or inability to clean up ⇒ **NO-GO**.

A Gate A GO means only that the **generation-job schema** passed DB verification.
It does **not** mean production-ready and does **not** enable the pilot flag.
`CAREER_SELF_ANALYSIS_JOB_PILOT_ENABLED` stays **OFF**. Gate B is a separate step.

---

## 5. Sensitive-data / log audit

Confirm none of the following appear in SQL Editor output, notices, or logs for
these runs: real profile/activity/values/conversation bodies, prompt text, raw
provider request/response/error, auth tokens, anon/service keys, DB connection
strings, real user emails, chain-of-thought. The harness stores only structured
fixtures (`{"summary":"gate-a"}`), hash-style revisions (`ir`/`pr`/`osr`), fixed
error codes, and numeric durations.

---

## 6. Cleanup (after Gate A)

1. Concurrency fixture row: removed by Session A STEP A2 (section 3.4). Re-run the
   S-ROLLBACK query (2.1) — expect 0 `gate-a-%` rows.
2. **Delete the two Gate-A test users** via Supabase Auth (Dashboard →
   Authentication → delete User A and User B). Their `ON DELETE CASCADE` also
   removes any stray job rows they owned.

**Keep** (these are the real pilot schema): the `career_generation_jobs` table,
its indexes/constraints, the RLS policy, and the `career_generation_job_claim`
function. Do **not** drop or truncate them.

---

## 7. Teardown / rollback of the migration (ONLY if removing Gate A objects)

Do **not** run this after a successful Gate A — the objects are the pilot schema
and must be kept. Use it only to roll back the migration itself. **No CASCADE.**
Drop the function first (full signature), then the table (its indexes, policy,
and trigger drop automatically with it). **Never drop the shared
`set_updated_at()`** — it is used by other tables.

```sql
-- 1) function first, by full signature (no CASCADE)
DROP FUNCTION IF EXISTS public.career_generation_job_claim(
  uuid, text, text, text, text, text, text, text, integer, integer, text[]);

-- 2) then the table (no CASCADE; owned indexes/policy/trigger go with it)
DROP TABLE IF EXISTS public.career_generation_jobs;

-- DO NOT: DROP FUNCTION public.set_updated_at()  -- shared by other tables
```

---

## 8. A-01–A-22 execution map

| Case | Where | Executable here |
| --- | --- | --- |
| A-01 migration applied | apply file (step 1.1) + single-session objects check | ✅ |
| A-02 idempotent re-apply | operator re-run (step 1.2) | ✅ operator step (harness marks NOT_EXECUTED) |
| A-03 columns/types | single-session | ✅ |
| A-04 indexes + unique | single-session | ✅ |
| A-05 fn SECURITY DEFINER/search_path | single-session | ✅ |
| A-06 GRANT/REVOKE matrix | single-session | ✅ |
| S-RLS-ENABLED / S-POLICY-DEF | single-session | ✅ |
| A-07 RLS owner SELECT | single-session (SET ROLE + jwt claims) | ✅ DB-level (not PostgREST E2E) |
| A-08 RLS cross-owner denied | single-session | ✅ DB-level |
| A-09 authenticated write denied | single-session | ✅ |
| A-10 anon denied | single-session | ✅ |
| A-11 authenticated EXECUTE denied | single-session | ✅ |
| A-12 service_role claim CLAIMED_NEW | single-session | ✅ |
| **A-13 concurrent claim dedup** | **Session A + Session B** | ✅ two sessions (single-session = NOT_EXECUTED) |
| A-14 old-token complete fenced | single-session | ✅ |
| A-15 old-token fail fenced | single-session | ✅ |
| A-16 current-token complete | single-session | ✅ |
| A-17 stale reclaim | single-session | ✅ |
| A-18 completed reuse | single-session | ✅ |
| A-19 retryable failed reclaim | single-session | ✅ |
| A-20 non-retryable fixed | single-session | ✅ |
| A-21 MAX_ATTEMPTS terminal | single-session | ✅ |
| A-22 raw non-persistence | single-session | ✅ |
| S-ROLLBACK | separate post-rollback query (2.1) | ✅ operator query |

## 9. References

- Gate plan / expected results: [generation_job_step4_readiness.md](generation_job_step4_readiness.md) §5
- Deploy gates: [generation_job_deployment_gates.md](generation_job_deployment_gates.md)
- Migration: `supabase/career_generation_jobs_apply.sql`

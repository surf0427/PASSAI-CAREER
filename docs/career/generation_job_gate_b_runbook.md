# Gate B — Operator Runbook (Vercel Preview canary, self-analysis generation job)

**Classification: CONTROLLED VERCEL PREVIEW CANARY.**
Gate B exercises the full runtime path (`after()` background continuation,
Fluid Compute, 300 s Max Duration, log redaction, non-silent-fallback) on a
**Preview deployment** with **one** canary member. **Production must remain
unchanged** for the entire gate.

This runbook is executed manually by the operator. Claude Code does **not**
deploy, does **not** set env vars, does **not** call Claude, and does **not**
write to the live Supabase project.

> **Prerequisite gates:** Gate A (`generation_job_gate_a_runbook.md`) is CLOSED
> (A-01–A-22 + RLS/policy PASS), and offline QA is green:
> `npm run qa:careerGenerationJob` (sql-contract / core / step2 / step3 / step4 /
> **canary**) ALL PASS.

---

## 0. What Gate B does and does NOT prove

**Proves (only with real Preview evidence):**
- 202-before-Claude fast return; `after()` continuation to `completed`.
- Fluid Compute + 300 s Max Duration actually granted by the platform.
- status-poll retrieval, reload recovery, duplicate suppression, stale reclaim.
- log redaction (fixed event names + numbers + fixed codes only).
- non-silent-fallback (storage-unavailable → 503, never legacy Claude).
- guest / non-canary regression stays on the legacy synchronous path.

**Does NOT prove (design-level, not per-invocation):**
- Exactly-once Claude invocation. A terminated-then-reclaimed job may call Claude
  again (bounded by `MAX_ATTEMPTS=3`). This is intentional.
- Hard platform termination completing the *current* invocation — recovery is
  **eventual** via lease (360 s) expiry + client resubmit, not in-invocation.

---

## 1. Absolute guardrails (read first)

1. **Production is not touched.** Set flags only on the **Preview** environment
   (Vercel → Project → Settings → Environment Variables → *Preview* scope). Do
   **not** add them to *Production*. Confirm Production `Deployments` are
   unchanged before and after.
2. **No secret values in this repo / in tickets / in logs pasted back.** Only env
   **names** and boolean/enum states.
3. **No real user UUID committed.** The canary UUID lives only in the Vercel
   Preview env var, never in git.
4. **Live Supabase is read-only for the operator here** except the rows the
   canary member's own job path writes via the app. Do not hand-edit rows.

---

## 2. Preview environment variables (names only)

| Env name | Scope | Set to | Notes |
| --- | --- | --- | --- |
| `CAREER_SELF_ANALYSIS_JOB_PILOT_ENABLED` | **Preview** | `true` | Any other value / unset ⇒ pilot OFF (fail-closed). |
| `CAREER_SELF_ANALYSIS_JOB_CANARY_USER_IDS` | **Preview** | single canary UUID | comma-separated; **empty / malformed / `*` / `all` ⇒ nobody** (fail-closed). |
| Supabase URL / anon / **service-role** keys | Preview | existing project values | service-role is server-only; never `NEXT_PUBLIC_`. |

**Fail-closed contract (must hold):**
- unset/false `PILOT_ENABLED` → nobody uses the job path.
- `PILOT_ENABLED=true` + empty/missing/malformed/`*`/`all` allowlist → **nobody**.
- `PILOT_ENABLED=true` + valid non-empty allowlist → **only exact-listed UUIDs**.
- guest → never the member job path. non-canary member → legacy path.
- Production stays OFF (these vars absent from the Production scope).

---

## 3. Canary UUID validation procedure

1. The canary member signs in on the Preview deployment (email OTP).
2. Obtain that member's `auth.users.id` **UUID** (Supabase → Authentication →
   Users → the canary account). It must match
   `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (case
   preserved; matching is case-insensitive).
3. Put **exactly that one UUID** into the Preview `..._CANARY_USER_IDS`. No
   wildcard, no `all`, no extra whitespace-only entries.
4. Redeploy Preview (env change requires a new Preview build).
5. Sanity: a **second, non-listed** member on the same Preview must get the
   legacy path (§B-02).

---

## 4. Platform verification (B-06)

- **Fluid Compute:** Vercel → Project → Settings → Functions → confirm **Fluid
  Compute is enabled**. `after()` continuation after the flushed 202 depends on
  it (docs: serverless `after` extends the invocation via `waitUntil`).
- **Max Duration:** confirm the route's function Max Duration is **300 s** on the
  active plan. The route exports `maxDuration = 300` (literal, equals
  `ROUTE_MAX_DURATION_SECONDS`); the platform must actually grant it.
- **Runtime:** route is `runtime = 'nodejs'` (Anthropic SDK / node:crypto /
  service-role). Confirm no Edge override.
- **Budget invariant (code, already green):**
  `PROVIDER_DEADLINE(225 s) + PREP(15 s) + FINALIZATION(60 s) = 300 s ≤ maxDuration`,
  `LEASE(360 s) > maxDuration(300 s)`. **Zero slack** — do not shrink one without
  shrinking provider deadline (QA D1/D2 detects drift).

---

## 5. Preview deployment identification

- Record the Preview deployment URL + commit SHA under test.
- Confirm it is a **Preview** (not Production) deployment in the Vercel UI.
- All B-01–B-17 evidence must reference this single Preview URL/SHA.

---

## 6. Evidence checklist B-01–B-17

For each: perform the action, capture **HTTP status**, **DB row state** (via
owner-scoped read as the canary member / service-role read of *only* structured
columns), **client-visible state**, and **log lines** (must be redacted).

| # | Test | Setup | Expected HTTP | Expected DB | Expected client | Expected logs |
| --- | --- | --- | --- | --- | --- | --- |
| B-01 | non-canary legacy | pilot OFF (or member not listed) | 200 `{result}` | no job row | legacy sync completes | no `job` event |
| B-02 | guest legacy | anonymous | 200 `{result}` | no job row | legacy completes | no `job` event |
| B-03 | canary → 202 | canary member submit | **202** `running`,`jobId` | `running` row, `attempt_token` set | submitting→running | `job` event, numbers only |
| B-04 | fast 202 | canary | 202 returns **before** Claude finishes (measure) | — | — | — |
| B-05 | after() → completed | canary, leave tab | — | row →`completed`, `result` structured | poll → completed → result page | `complete applied=true` |
| B-06 | Fluid/300 s | Dashboard | — | — | — | Fluid ON + 300 s (screenshot names only) |
| B-07 | status poll | after completion | 200 `completed` | `completed` | completed→navigate | — |
| B-08 | reload recovery | reload mid-run | GET 200 | `running`/`completed` | resume → complete | — |
| B-09 | duplicate suppression | resubmit same input mid-run | `ALREADY_RUNNING`/reclaim | **one** job row | no double gen | — |
| B-10 | stale reclaim | force lease expiry | `resubmit`→ new claim | new `attempt_token`, `attempt_count+1` | completes | — |
| B-11 | provider timeout | induce slow provider | fenced fail `PROVIDER_TIMEOUT` | `failed` retryable | manual retry shown | `errorCode` only |
| B-12 | function termination | provider forced long | (no completion this invocation) | `running` until lease, then reclaim | recheck → complete | — |
| B-13 | retryable failure + retry | induce transient fail | 200 `failed` retryable | `failed` | retry → complete | — |
| B-14 | MAX_ATTEMPTS | 3 failures | 409 `RETRY_LIMIT_REACHED` | `failed` terminal | retry button hidden | — |
| B-15 | log redaction | inspect all logs | — | — | — | **no** raw input/prompt/result/provider body/email/token/service-role key/full DB error |
| B-16 | storage unavailable non-fallback | canary + storage unreachable | **503** `GENERATION_JOB_STORAGE_UNAVAILABLE` | no row | reconnecting | **no legacy Claude call** |
| B-17 | legacy regression | anonymous + member non-canary | 200 `{result}` | no row | legacy completes | job path unused |

**Redaction allowlist for logs (B-15):** fixed event names (`[career/self-analysis/job]`),
`stage`, `applied` (bool), fixed `errorCode` (allowlist), `providerDurationMs`,
`totalDurationMs`, and optionally jobId. Anything else = STOP.

`stage` の値は `claim`（POST 時の atomic claim 結果）/ `complete` / `fail` の 3 種。
`stage: 'claim'` の event は追加で以下のみを含む（いずれも固定 enum / 数値）:
`outcome`（`CLAIMED_NEW` / `CLAIMED_RETRY` / `ALREADY_RUNNING` / `ALREADY_COMPLETED` /
`FAILED_NON_RETRYABLE` / `RETRY_LIMIT_REACHED`）、`attemptCount`（数値）、
`status`（`queued` / `running` / `completed` / `failed`）。
B-01 / B-02 の「no `job` event」は **legacy 経路では claim 自体が発生しない**ことで満たされる
（claim event が出たら legacy ではない ⇒ NO-GO）。
静的 redaction 検査: `npm run qa:careerJobPathDataSpine`（[7]）。

---

## 7. Stop conditions (immediate NO-GO)

- B-15: any raw input / prompt / Claude response / provider body / email / token
  / service-role key / full Supabase error object appears in logs.
- B-16: a storage/job-path failure silently falls back to the legacy synchronous
  Claude call.
- B-17: guest or non-canary member is routed into the job path (row created).
- B-05/B-06: `after()` does not continue, or 300 s / Fluid Compute not actually
  granted (jobs stall in `running` and only recover by reclaim).
- Any Production deployment or Production env var changed during the gate.

---

## 8. Rollback procedure

1. **Flag OFF:** remove / set `CAREER_SELF_ANALYSIS_JOB_PILOT_ENABLED` to a
   non-`true` value on **Preview** → all members immediately back to legacy sync
   (job table unused).
2. **Canary shrink:** to narrow rather than stop, remove the UUID from
   `..._CANARY_USER_IDS`.
3. **In-flight jobs:** `running` rows self-terminate after lease (360 s) via
   reclaim or `RETRY_LIMIT_REACHED`. `completed` results are already in the
   member's localStorage (canonical) — no loss.
4. **Table retained:** do **not** drop / truncate `career_generation_jobs`
   (audit + resume). RLS keeps it owner-read-only.
5. **Confirm:** after rollback, one anonymous and one member sync generation each
   succeed on Preview.

---

## 9. Cleanup procedure

- Remove the Preview canary env vars once the gate closes (or intentionally keep
  for staged rollout — decide explicitly).
- Delete the throwaway canary/non-canary Preview test accounts if they were
  created only for this gate.
- The canary member's own job rows may be left (owner-scoped) or removed by the
  operator via service-role; never hand-edit other owners' rows.
- Confirm Production env + deployments are unchanged (diff before/after).

---

## 10. Gate B close-out template

```
GATE B — SELF-ANALYSIS GENERATION JOB (Vercel Preview canary)
Preview URL:            <preview-url>
Commit SHA:             <sha>
Fluid Compute:          ENABLED / DISABLED
Max Duration:           <n> s   (expect 300)
Runtime:                nodejs
Canary members listed:  1 (UUID in Preview env only — NOT recorded here)
Production unchanged:    YES / NO   (env diff + deployments verified)

B-01 ... B-17:          <PASS/FAIL each, with HTTP + DB + client + log evidence>
Redaction (B-15):       PASS / FAIL
Non-silent-fallback (B-16): PASS / FAIL
Guest/legacy regression (B-17): PASS / FAIL

FAIL count:             <n>
STOP conditions hit:    <none / list>

Decision:               GATE B PASS  /  NO-GO
Operator:               <name>   Date: <date>
```

**Gate B PASS requires all B-01–B-17 expected, zero stop conditions, and
Production verified unchanged.** Only the actual Preview canary execution can
close Gate B — a passing offline QA / build does **not** close it.

# PASSAI CAREER — Claude Data Spine Implementation Protocol

**Goal:** Let Claude Code execute approved Data Spine slices with minimal handoff while preserving
Human architectural control.

---

# 1. Session start protocol

Before planning any Data Spine work:

1. read `DATA_SPINE_ARCHITECTURE.md`
2. read `DATA_SPINE_STATE.md`
3. read `DATA_SPINE_DECISIONS.md`
4. read this file
5. run read-only repository checks: current branch / HEAD / working-tree status
6. inspect only the files relevant to the requested slice
7. compare current implementation with documented state

If the repository differs materially from the docs: do not silently fix the docs, do not silently
trust stale docs. Report the discrepancy in PLAN and state whether it changes scope or risk.

---

# 2. Default workflow

```text
READ DOCS → READ REPO → PLAN → HUMAN APPROVE → IMPLEMENT → QA → SELF-REVIEW
→ FIX IN-SCOPE FAILURES → QA AGAIN → UPDATE DATA_SPINE_STATE.md → FINAL REPORT → STOP
```

Do not start the next slice automatically.

---

# 3. PLAN requirements

objective / current observed implementation / files to change / files explicitly out of scope /
architecture invariants touched / decision IDs touched / expected behavior change /
expected non-change / risks / QA plan / rollback note / open Human questions.

If a Human-required decision blocks implementation, stop at PLAN
（例外: Human が明示的に「暫定解で前進してよい」と指示した handoff。その場合は
`PROVISIONAL_IMPLEMENTATION_DECISION` として `DATA_SPINE_DECISIONS.md` に記録する）。

---

# 4. Implementation autonomy inside an approved slice

After approval, Claude may independently: inspect nearby files in the same slice / make the smallest
implementation / run relevant QA / diagnose failures caused by its own changes / revise / rerun QA /
self-review / update `DATA_SPINE_STATE.md`.

Claude does **not** need to ask after every ordinary compile/test failure if the fix stays inside the
approved slice.

---

# 5. Mandatory stop / escalation conditions

1. a `HUMAN_REQUIRED` decision must be decided（暫定解の明示許可がない場合）
2. a required fix expands beyond approved paths/domain
3. a privacy or consent classification is ambiguous
4. an unrelated baseline failure blocks validation
5. a destructive migration is required
6. a service-role bypass appears necessary
7. an existing guard must be weakened to get green
8. data authority / precedence would change
9. product behavior must change although the task is QA/infrastructure-only
10. commit / push / merge is requested but not explicitly approved

---

# 6. QA discipline

- never delete an assertion solely to obtain green
- never reduce a security/isolation test without documenting the changed contract
- distinguish: regression caused by current slice / stale test reference / unrelated pre-existing failure
- run narrow QA first, then required regression suites
- include `git diff --check`
- include typecheck and lint when supported
- preserve fail-closed behavior where required

## 6.1 stale guard を直すときの原則（NEXT-1 の教訓）

QA が消えたパスを参照して落ちるときは、**assertion を削らず manifest を現構造へ追随させ、
さらに「次に同じことが起きたら自動検知される」網羅性 check を足す**。
例: `career-event-callsite-contract-qa.ts` [6] は `app/` の実 call site 集合と manifest の
完全一致を assert するため、機能が移動しても manifest の陳腐化が即座に FAIL になる。

---

# 7. Self-review checklist

- Does the diff match PLAN?
- Did any out-of-scope file change?
- Did data authority change?（変えたなら decision へ記録したか）
- Did privacy classification change?
- Did prompt inputs broaden?
- Did any guard become weaker?
- Did any Layer 4/5 production import appear?
- Did any service-role usage appear?
- Did any new duplicate truth store appear?
- Is the change reversible?（env で戻せるか）
- Are docs/state now accurate?

---

# 8. State update protocol

After the slice is verified, update `DATA_SPINE_STATE.md` with:
date / branch / HEAD / slice completed / changed files / QA results / newly closed blocker /
newly discovered blocker / next recommended slice / whether a Human decision is required.

Do not rewrite historical audit facts; append/update operational status clearly.
If the task only repairs QA and does not change architecture, say so explicitly.

---

# 9. Final report format

## Result（PASS / PARTIAL / BLOCKED）
## Scope completed
## Files changed
## Architecture invariants（preserved / changed）
## QA（command → result）
## Self-review（notable findings）
## State update
## Blockers（real remaining only）
## Next（next recommended slice / Human decision required: YES/NO）

Then stop.

---

# 10. Git policy

Unless explicitly authorized: no commit / no push / no merge / no branch switch /
no reset / clean / destructive git action.

Working-tree changes are allowed only after PLAN approval.

---

# 11. Operating model

```text
Human   → gives slice + approval
Claude  → reads architecture/state/decisions → implements → debugs in-scope → validates
        → self-reviews → updates state
Human   → reviews final result / makes architectural decisions only when needed
```

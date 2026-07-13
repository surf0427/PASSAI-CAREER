# Personal Memory Shadow Pipeline — Offline E2E Failure Matrix（P16-H）

## 目的

Personal Memory shadow write の全主要層を **実 Supabase / 実 env / deployment / 実データを使わず**、
fixture・fake session・fake eligibility・in-memory repository・DI で接続し、単体 QA では拾いづらい
**接続不整合・failure handling・race・section 分離**を固定するオフライン E2E QA の設計。

対象パイプライン:
`master flag → session → canary eligibility → Source load → section rebuild → validation → revision → repository read → compare-and-set → upsert → read adapter`

実装 QA: [scripts/career-personal-memory-shadow-pipeline-qa.ts](../../scripts/career-personal-memory-shadow-pipeline-qa.ts)
（`npm run qa:careerPersonalMemoryShadowPipeline`・オフライン）。**production code は変更せず既存 DI seam / export のみ接続。**

## 接続する実関数（再実装しない）

| 層 | 実関数 |
|---|---|
| master gate | `shadowWriteBaseMemory` 等の同期 flag gate（`ShadowWriteGateDeps.isEnabled`） |
| eligibility | `resolveCanaryEligibility`（client resolver）→ 疑似 fetch → `evaluateEligibility` + `buildCanaryConfig`（server core + pure gate） |
| gated pipeline | `runGatedShadowWrite`（eligibility→load→coordinate） |
| builder / revision | `buildBaseMemorySection` / `buildSelfAnalysisMemorySection` / `buildEsMemorySection` / `buildInterviewMemorySection` |
| coordinator | `coordinateShadowWrite`（DI: session / store / now） |
| compare-and-set / writer | `shadowWriteSection` + `decideWrite`（`coordinateShadowWrite` 経由） |
| validation | `validateCareerPersonalMemorySection`（repository upsert 内で再検証） |
| repository | `PersonalMemoryStore`（QA 側 in-memory fake）+ `readCareerPersonalMemorySections` |
| read adapter | `readPersonalMemorySection` |

## Failure Matrix

`Src`=Source load / `Rd`=repository read / `Up`=upsert / `Row`=persisted row 効果 / `S/UI`=Source保存・UI 影響 /
`Retry`=リトライ / `Outcome`=sanitized 結果 / `RT`=runtime 実機検証要否。

| layer | failure | expected | Src | Rd | Up | Row | S/UI | Retry | Outcome | RT |
|---|---|---|---|---|---|---|---|---|---|---|
| master flag | OFF | 即 return | 0 | 0 | 0 | 変化なし | なし | なし | `master_disabled`(harness) | — |
| session | guest / no session | eligibility deny | 0 | 0 | 0 | 変化なし | なし | なし | gate deny→未 write | — |
| canary config | 未設定/空/不正UUID/不正section/cap超過 | default deny | 0 | 0 | 0 | 変化なし | なし | なし | `not_eligible` | — |
| auth verification | unauth / anonymous / auth error / no-config | deny | 0 | 0 | 0 | 変化なし | なし | なし | `not_eligible` | 実 getUser は RUNTIME |
| eligibility client | timeout/network/401/403/500/malformed/no-token | false→deny | 0 | 0 | 0 | 変化なし | なし | なし | `eligibility_unavailable` | 実 endpoint は RUNTIME |
| Source load | loader throw | `safe()` fallback（空/null） | 1(試行) | 状況次第 | 状況次第 | — | なし | なし | build は継続 | — |
| rebuild | — | 決定的 projection | — | — | — | — | なし | なし | — | — |
| validation | malformed/mismatch/PII/forbidden/oversized | upsert 拒否 | 1 | 1 | 0 | 既存 row 不変 | なし | なし | `invalid` | — |
| revision | 同一 Source | 同一 revision | — | — | — | — | — | — | `unchanged` | — |
| repository read | read が error/throw | `[]`＝missing 扱い→**write 継続** | 1 | 1 | 1 | 新規/更新 | なし | なし | `written`（下記★） | — |
| compare-and-set | 既存 fresh 同一 revision | skip | 1 | 1 | 0 | 不変 | なし | なし | `unchanged` | — |
| compare-and-set | 既存が新しい Source 由来 | stale skip | 1 | 1 | 0 | 不変 | なし | なし | `stale_write` | — |
| upsert | upsert が error/throw | never-throw | 1 | 1 | 1(試行) | 不変 | なし | **なし（1回のみ）** | `failed` | — |
| read adapter | fresh/stale/failed/unsupported | 状態導出 | — | — | — | — | — | — | fresh/stale/unusable/unsupported_schema | 実 row parity は RUNTIME |

★ **repository read failure → write 継続（設計上の根拠）**: `readCareerPersonalMemorySections` は never-throw で
read 失敗時 `[]` を返す（best-effort read）。coordinator は current=null＝missing と見なし upsert を行う。
これは **write の順序保証を correctness の前提にしない**（`state.ts` 明文）設計に基づく — 古い Source 由来 Memory が
書かれても、prompt 使用時に `deriveMemoryState` の **revision 一致（fresh）でのみ使用**されるため、stale は使われず
request-time fallback + rebuild される。よって read failure 時の write は churn であって correctness bug ではない。
本 QA はこの実挙動を検証・明記し、期待値を都合よく変えない。

## Race の扱い

- **Case 8（B commit → A が後追い write）**: A の repository read が B の upsert 後に走る interleaving では、
  A は B の row を読み `decideWrite` が **Source recency で stale_write skip**（`state.ts`）。→ 現行 contract で防御可能。
- **Case 9（同一 revision 同時 write）**: 先行が missing→written、後続は read で fresh 同一 revision を見て
  `unchanged` skip。in-memory は `(user_id, section_key)` key で 1 row。
  ただし **DB レベルの真の同時 INSERT による UNIQUE 競合（23505）は in-memory では完全再現不可** → **RUNTIME HOLD**。
- read が両者とも missing を返す真の read-both-empty race は、write 順序では守られず **read-time revision 権威**で担保する
  設計。DB 原子性の最終確認は **RUNTIME HOLD**。

## RUNTIME HOLD（本 QA では確認しない）

実 Supabase row parity / DB 固有 UNIQUE 競合 / 実 auth getUser / 実 eligibility endpoint /
runtime canary / prompt read / Context Orchestrator projection / Interview 実データ / Production rollout。

## Sanitized outcome（観測のみ・機微情報を出さない）

`master_disabled` / `no_session` / `not_eligible` / `eligibility_unavailable` / `no_client` /
`invalid` / `unchanged` / `stale_write` / `written` / `failed`。
coordinator の実 outcome（`disabled`/`guest`/`no_client`/`written`/`unchanged`/`stale_write`/`invalid`/`failed`）を
source of truth とし、gate 段の deny は harness 側で `not_eligible`/`eligibility_unavailable` として観測する。
結果・log に user ID / email / UUID / token / cookie / env 値 / payload 本文 / raw error / Supabase URL / API key を
**含めないことを静的検証**する。

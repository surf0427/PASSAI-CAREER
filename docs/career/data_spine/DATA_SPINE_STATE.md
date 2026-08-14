# PASSAI CAREER — Data Spine State

**Purpose:** Operational snapshot.
**Update rule:** Claude Code must update this file after each approved Data Spine slice that changes the verified state.
**Do not rewrite architecture here.**

---

# 1. Snapshots

## 1.1 Handoff audit snapshot（起点）

- Audit date: **2026-08-14**
- Repository: `/Users/yk/PASSAI-CAREER`
- Branch: `feature/career-mvp`
- HEAD: `4c2bd8c442b742531713ff7d30f562b2adade22e`
- Last Data Spine work before handoff: `5ed8ddb`（2026-07-18, P17-M1 memory read pilot）

## 1.2 Implementation snapshot（本 handoff の作業結果）

- Date: **2026-08-14**
- Branch: `feature/career-mvp`
- Base HEAD: `4c2bd8c`（**未 commit**。作業は working tree に保持）
- Completed slices: **NEXT-1 / NEXT-2 / NEXT-3 / NEXT-4 / NEXT-5 / NEXT-6（第一 slice）/ NEXT-7（gated）**
  \+ **D-S1 source-sync veto（D-R2 closure / H-1・H-2 closed）**
  \+ **hardening: `D-S2` unsafe rollback 削除 / `D-S3` write ordering（W3・W4 修正 + 限界の明記）**
  \+ **`D-S4` canary activation foundation（user-scoped Server Context gate + observability + runbook）**
  \+ **`D-S5` Server Context Expansion Batch 1（consultation / company_research_review + 重複注入防止）**
- Human decision で止めた項目: H-3 write-back / H-4 rollout / H-6 / H-7 / H-8（fail-closed のまま）

---

# 2. Maturity snapshot

| Layer | Structural | Operational | 現在の解釈 |
|---|---:|---:|---|
| Layer 1 — Source Data | 95 | 90 | **server-readable（owner RLS）**。mirror は依然 best-effort |
| Layer 2 — Personal Memory | 95 | 60 | 永続 + **sync 証明付き freshness** + request-local rebuild。read は canary gate |
| Layer 3 — Career Event Log | 90 | 80 | 11 writers / 2 readers / **stale QA guard 修復済み** |
| Layer 4 — Aggregated Insight | 80 | 5 | scaffold 完成・production consumer ゼロ（意図的） |
| Layer 5 — Company Knowledge | 75 | 0 | scaffold 完成・live shared KB なし（意図的） |
| Context Orchestrator | 90 | 80 | purpose 単位の server-driven base context 経路を新設（default OFF） |
| Data Usage / Privacy | 92 | 58 | consent capture surface をコード完成・三重 gate で閉止。sync signal は revision token のみ |

---

# 3. 解消した bottleneck

## Layer 1 に server 側 read path が無い → **解消（NEXT-2）**

結果として次が可能になった:

- server が expected Personal Memory revision を再算出できる（NEXT-3）
- mirror 基準の freshness を独立に検証できる（D-R1 退役 / 残存ギャップは D-R2）
- server-side rebuild ができる（NEXT-4・request-local）
- source 削除に対する invalidation が構造的に成立する（NEXT-5）
- client request-body bridge を purpose 単位で退役できる（NEXT-6）

---

# 4. Current operational edges

## Present

- Feature → Layer 1 client/localStorage source
- Feature → Layer 1 Supabase best-effort mirror
- **Layer 1 → server reader（owner-scoped RLS・service role 不使用）**
- **Client → sync revision signal（header・veto 専用）→ server 照合**
- **Layer 1 → server 再算出 revision → Layer 2 freshness 判定（sync 証明済みのときのみ）**
- **Layer 1 → request-local rebuild → prompt（stale/missing 時）**
- **Layer 1 → server base context → Orchestrator（purpose opt-in・既定 OFF）**
- Feature → Layer 3 event writes
- Layer 3 → My Page timeline
- Layer 3 → consultation event-signal pilot（gated off by default）
- Layer 2 → company research review（gated canary purpose）
- Cross-feature client selector → request body → Orchestrator（**base 以外はまだ現役**）

## Absent（意図的 / 未着手）

- server rebuild の DB write-back（H-3 待ち・`D-P3`）
- Layer 3 → Layer 4 production ETL
- Layer 4 → production prompt
- live Layer 5 shared path
- consent の **production 永続 repository**（DDL の production 適用 + H-6 / H-7 待ち。
  ★ member 向け read/write に service-role は **不要**＝`D-A1` で訂正済み）
- `selfAnalysis` / `es` / `matching` / `consultationInsights` / `companyResearch` の bridge 退役

## Deliberately absent

- Layer 3 → Layer 2
- Layer 3 / Event Signal → matching ability signal
- 自動的な personal company research → shared knowledge

---

# 5. Completed phase reconstruction

| Phase | Status |
|---|---|
| P2–P3 Orchestrator | Complete |
| P4 Memory types/selectors | Complete |
| P6 PII policy | Complete |
| P7–P8 ES summary / compaction | Complete |
| P9 Event Log + timeline | Complete |
| P10 Event Signal pilot | Complete, gated off |
| P11–P12 Privacy / consent foundation | Complete |
| P15 Orchestrator consolidation | Complete |
| P16 Personal Memory persistence | Complete |
| P17-A–E Layer 4/5 production scaffold | Complete, gated off |
| P17-M1 Memory read pilot | Complete |
| **NEXT-1 Layer 3 QA guard 修復** | **Complete** |
| **NEXT-2 Layer 1 server reader** | **Complete** |
| **NEXT-3 server 再算出 freshness（D-R1 退役）** | **Complete** |
| **NEXT-4 rebuild-on-stale（request-local）** | **Complete** |
| **NEXT-5 source reset → memory invalidation** | **Complete（primitive + server safety net）** |
| **NEXT-6 bridge 退役（interview_practice / base context）** | **Complete（default OFF）** |
| **NEXT-7 consent capture surface** | **Complete（三重 gate で閉止・production repo 未接続）** |
| **Batch 1 server context（consultation / company_research_review base）** | **Complete（default OFF）** |
| **Batch 2 cross-feature bridge 退役（`D-S6`）** | **Complete（default OFF）** |

---

# 5.1 purpose 別 bridge retirement status（`D-S6` / Batch 2 時点）

## 5.1.1 server context 対象 purpose

| purpose | status | server 化済み（kind 単位・verified 時） | 恒久 bridge のまま | 理由 |
|---|---|---|---|---|
| `interview_practice` | **NEAR_FULL_SERVER** | base(profile/activity/values) / selfAnalysis / es / matching / consultationInsights / companyResearch | — | 残 bridge なし。body は **fallback 専用**として残す |
| `consultation` | **NEAR_FULL_SERVER** | base / selfAnalysisHistory / esHistory / interviewHistory / presentationHistory / companyResearch / matching | `gd` / `gdRoom` / `eventSignals` | mirror 無し / server 書き込み / Layer 3 分離（`D-S6`） |
| `company_research_review` | **NEAR_FULL_SERVER** | base / selfAnalysis / matching（+ Personal Memory dedupe 済み） | — | 残 bridge なし |

> **FULL_SERVER と呼ばないのは意図的。** request body の bridge field は
> **削除していない**（未 verify / gate OFF / 非 canary のときの fallback として必須）。
> 「server が権威になった」であって「bridge が消えた」ではない。

## 5.1.2 全 purpose inventory（2026-08-14 実測）

| purpose | live callsite | server context | Personal Memory | 判定 |
|---|---|---|---|---|
| `consultation` | `consultation/consultationPrompt.ts` | ✅ Batch 1+2 | ❌（重複回避・`D-S5`） | LIVE |
| `interview_practice` | `interview/interviewPrompt.ts` | ✅ Batch 1+2 | ❌ | LIVE |
| `company_research_review` | `company-research/route.ts` | ✅ Batch 1+2 | ✅（dedupe 済み） | LIVE |
| `presentation_feedback` | `presentation/presentationPrompt.ts` | ❌ | ❌ | LIVE（未移行） |
| `matching` | `matching/route.ts` | ❌ | ❌ | LIVE（未移行） |
| `self_analysis_deep_dive` | `self-analysis/deepDivePrompt.ts` | ❌ | ❌ | LIVE（未移行） |
| `es_generation` | **なし** | — | — | ★ **ORPHAN**（`D-S7`） |
| `es_review` | なし | — | — | DORMANT（registry のみ） |
| `interview_complete` | なし（complete route は `interview_practice` を使用） | — | — | DORMANT（registry のみ） |
| `gd_feedback` | なし（GD route は静的 prompt） | — | — | DORMANT（registry のみ） |
| `self_analysis` | なし（self-analysis route は静的 prompt） | — | — | DORMANT（registry のみ） |
| `mypage_summary` | なし | — | — | DORMANT（registry のみ） |

## 5.1.3 Layer 1 source kind inventory

| kind | table | server read | sync view | 備考 |
|---|---|---|---|---|
| `profile` | `career_profiles` | ✅ | 全体 jsonb | |
| `activity` | `career_activities` | ✅ | 全体 jsonb | |
| `values` | `career_values` | ✅ | `updatedAt` 除外 | DB trigger 上書き |
| `self_analysis` | `career_self_analysis_results` | ✅ | id/createdAt/userInput/result | |
| `es` | `career_es_logs` | ✅ | 昇格列 + meta のみ | body/mode/groupId 等は mirror 非往復 |
| `interview` | `career_interview_results` | ✅ | mode/turns/result/企業研究連携 | |
| **`matching`** | `career_matching_results` | ✅ **Batch 2** | id/createdAt/userInput/result | |
| **`company_research`** | `career_company_research_logs` | ✅ **Batch 2** | 昇格列 + jsonb（`updatedAt` 除外） | DB trigger 上書き |
| **`presentation`** | `career_presentation_results` | ✅ **Batch 2** | 昇格列 + result/qa | |
| **`consultation`** | `career_consultation_threads` | ✅ **Batch 2** | id/createdAt/title/messages（`updatedAt` 除外） | DB trigger 上書き |
| `gd`（ソロ） | **なし** | ❌ 不可 | — | ★ Supabase mirror が存在しない |
| `gd_room` | `career_gd_room_results` | ❌ 意図的除外 | — | ★ server 側が書くデータ（canonical 前提が異なる） |

## 5.1.4 context budget（Batch 2 前後）

**変化なし（payload byte 完全一致）。**

server 経路は client と同じ pure selector を使うため、同一データに対する出力は同一。
QA `B2-5` が interview / consultation の全 field で `JSON.stringify` 一致を固定している。
selector 側の cap（history 3 件 / companyResearch 5 件 / matching 2 件 等）が効くため、
log 件数を 1 → 5 → 20 と増やしても payload は上限で頭打ちになる（実測で確認）。

---

# 5.2 ★ 未実施の検証（隠さない）

> **Actual signed-in browser E2E remains outstanding.**

Human 指示により実ブラウザ session での E2E は延期。
現在の検証範囲は real env-derived config / fixture auth simulation / route-level logic /
parity harness / adversarial QA まで。実ユーザー click-through と実 AI call は未実施。

---

# 6. 既知の残課題

0. **~~D-R2~~ は closed**（`D-S1`）。残るのは下記のみ。

1. **~~NEXT-6 の残り~~ は Batch 2 で解消**（`D-S6`）。残る恒久 bridge は `gd` / `gd_room` /
   `eventSignals` のみで、いずれも **意図的**（mirror 無し / server 書き込み / Layer 3 分離）。
   なお request body の bridge field 自体は fallback 用に残す（削除しない）。
2. **NEXT-5 の wiring 先が存在しない**: 現在 Personal Memory の由来 Source（profile / activity /
   values / self_analysis / es / interview）を reset・delete する UI が repository に無い。
   primitive（`invalidatePersonalMemoryForSourceReset`）は用意済みで、将来 reset 機能を足すときに
   呼ぶ契約。
3. **consent production repository 未実装**: prototype DDL は `supabase/prototype/` にあり production 未適用。
   append は「INSERT policy を張らず RPC 経由」設計のため、production 用 RPC を **`auth.uid()` 束縛版**で
   書き直したうえで `authenticated` へ EXECUTE を付与する必要がある（`D-A1`）。
   ★ member 向け read / write に **service-role credential は不要**。真の blocker は
   H-6（placement / identity）・H-7（法務文言と policy manifest 行）・DDL の production 適用。
4. **Layer 4 / Layer 5 は production consumer ゼロのまま**（意図的）。
5. **`es_generation` purpose は ORPHAN（Batch 2 で確定・`D-S7`）**。live callsite ゼロ。
   削除は行わず、retirement か `es_review` への再マッピングかを **Human decision** として残す。
   同様に `lib/careerServerContext/baseContext.server.ts` は Batch 2 以降
   **production から呼ばれない QA 対象 module**（DORMANT_INTENTIONAL / `D-S7`）。
6. **別端末 stale write による mirror 巻き戻り（`D-S3` W2/W5）は未防止**。
   read 安全性は `D-S1` veto が担保するが、mirror integrity は保証していない。
   完全防止には未適用 draft（`supabase/prototype/career_source_write_guard_draft.sql`）の適用と
   conflict 解決ポリシーの Human decision が必要。

---

# 7. 追加された env（すべて server-only・既定は安全側）

| Env | 既定 | 効果 |
|---|---|---|
| `CAREER_PERSONAL_MEMORY_SERVER_REBUILD_DISABLED` | 未設定（= false） | true で rebuild-on-stale を停止 |
| `CAREER_SERVER_CONTEXT_PURPOSES` | 未設定（= 空 / OFF） | purpose 単位で server-driven base context を opt-in |
| `CAREER_SERVER_CONTEXT_CANARY_USER_IDS` | 未設定（= 誰も許可しない） | ★ Server Context の **user allowlist**。purpose だけでは有効化されない |
| `CAREER_DATA_SPINE_CANARY_DIAGNOSTICS_ENABLED` | 未設定（= OFF） | canary counters の operator inspection path |
| `CAREER_CONSENT_CAPTURE_ENABLED` | 未設定（= OFF） | consent capture surface の運用側有効化 |
| `CAREER_CONSENT_POLICY_LEGAL_APPROVED` | 未設定（= 未承認） | 同意文言の法務承認 flag |

★ `D-S1` の source-sync veto は **flag を持たない**（常時有効）。
「検証できないものを使わない」は既定の安全契約であり、opt-in にすると既定が危険側になるため。

既存: `CAREER_PERSONAL_MEMORY_READ_ENABLED` / `CAREER_PERSONAL_MEMORY_READ_CANARY_USER_IDS` /
`CAREER_DATA_SPINE_READY_*` / `CAREER_AGGREGATED_INSIGHT_*` / `CAREER_COMPANY_KNOWLEDGE_*`。

## 7.1 到達可能性（2026-08-14 audit で実測）

env 未設定の既定状態で各 gate を実評価した結果:

| gate | 実測値 |
|---|---|
| consent capture gate | `enabled:false`（`flag_off`） |
| Personal Memory read master | `false` |
| server context purposes | `[]`（bridge 退役 OFF） |
| server context canary allowlist | 未設定（= 誰も許可しない） |
| canary diagnostics | `false` |
| Data Spine readiness | `ready:false` |
| L4 read / consultation | `false` / `false` |
| L5 read / research | `false` / `false` |

**重要:** `CAREER_PERSONAL_MEMORY_READ_ENABLED` が未設定である限り、
`loadPersonalMemorySectionsForPrompt` は **I/O ゼロで `skipped`** を返す。

さらに canary を開けた後も、`D-S1` の source-sync veto により
「client canonical と mirror の一致を証明できない request では Personal Memory を使わない」。
旧 `D-R2` の Case A / A' / B は **architecture level で発生しない**（QA T1〜T3）。

---

# 8. Verified QA snapshot（2026-08-14 実装後）

| Suite | Result |
|---|---|
| `qa:careerPersonalMemoryAll`（+ source reader / invalidation / bridge を包含） | PASS |
| `qa:careerSourceReader` | PASS |
| `qa:careerPersonalMemoryInvalidation` | PASS |
| `qa:careerServerContextBridge` | PASS |
| `qa:careerSourceSync` | PASS |
| `qa:careerMirrorWriteOrdering` | PASS |
| `qa:careerDataSpineHardening`（H1〜H8） | PASS |
| `qa:careerCanaryActivation`（C1〜C13） | PASS |
| `qa:careerCanaryObservability`（O1〜O5 / P1〜P2） | PASS |
| `qa:careerServerContextBatch1`（Q1〜Q8 / R1〜R6 / D1〜D3） | PASS |
| `qa:careerEvents`（callsites 含む） | PASS |
| `qa:careerEventSignalSeries`（5 suite 全て） | PASS |
| `qa:careerAggregateSeries` | PASS |
| `qa:careerConsentSeries`（+ capture） | PASS |
| `qa:careerConsentProtoSeries` | PASS |
| `qa:careerMemoryAll`（byte parity 系） | PASS |
| `npx tsc --noEmit` | PASS |
| `npx eslint`（変更ファイル） | PASS |
| `git diff --check` | PASS |

---

# 9. Ordered remaining slices

## NEXT-5b — source reset UI（将来）
**Size:** S / **Human decision:** No
reset/delete 機能を追加するときは **必ず `resetCareerSourceData()` を通す**こと
（mirror 削除 → Memory 無効化 → 失敗を `fullyPropagated:false` で報告）。
localStorage を消すだけの実装にしない。read 安全性自体は `D-S1` veto が担保する。

## NEXT-6b — interview_practice の残り bridge 退役
**Size:** M / **Human decision:** No（`D-P1` / `D-P4` の延長）
Layer 1 reader に `matching` / `company_research` / `consultation` kind を追加し、
cross-feature context を server 側で組む。byte parity harness を維持。

## NEXT-6c — 他 purpose への横展開
**Size:** L（purpose 単位に分割）
`consultation` → `company_research_review` → `es_generation` の順を推奨。

## NEXT-7b — Canary 運用（実施可能・未実施）
**Size:** S / **Human decision:** canary user UUID の指定のみ
`docs/career/data_spine/CANARY_RUNBOOK.md` の Stage 1 → Stage 2 を実施し、
`rates.syncVerified` / `syncMismatch` / `contextUsed` / `bridgeFallback` を観測する。
★ 拡大（他ユーザー）は H-4 の decision。canary では広げない。

## NEXT-8 — Personal Memory rollout
**Size:** S / **Human decision:** H-4
`origins`（persisted / rebuilt / legacy）・`sourceRead`・**`vetoed`（unreadable / unclaimed / mismatch）**
の観測値を基に canary を広げる。
★ `vetoed.mismatch` が多い = mirror 同期が実運用で追いついていない兆候であり、
rollout 判断の主要指標になる（`unclaimed` は signal 未送信 route の残存を示す）。

## NEXT-9 — server rebuild write-back（任意）
**Human decision:** H-3。現状は `D-P3` により実装していない。

## NEXT-10 — consent production repository
**Human decision:** H-6 / H-7 + DDL の production 適用 + production RPC を `auth.uid()` 束縛版で用意（`D-A1`）。
service-role credential は不要。

## NEXT-11 — Layer 4 / Layer 5 production activation
**Human decision:** H-7 / H-8 + `CAREER_DATA_SPINE_READY_*` の全承認。

---

# 10. Current stop rule

1. read all Data Spine blueprint files
2. inspect current git HEAD and working tree
3. compare current code with this snapshot
4. if this file is stale, update only after verifying the repository
5. execute only the Human-approved slice
6. do not auto-advance to the next slice

---

# 11. Post-slice update template

```text
Last verified date:
Branch:
HEAD:
Working tree:
Completed slice:
Files changed:
QA executed:
QA result:
Architecture discrepancy found:
Open blockers:
Next recommended slice:
Human decision required before next slice:
```

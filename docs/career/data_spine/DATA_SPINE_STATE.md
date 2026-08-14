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

# 5.1 Personal Optimization — 最終 inventory（Closure Batch / 2026-08-14）

## 5.1.0 `FULL_SERVER` の定義（`D-S8`）

```text
FULL_SERVER =
  この purpose が通常の verified flow で使う personal-context source が
  **すべて server-derived にできる**。
  bridge は unverified / flag OFF / non-canary / unreadable のときの
  safety fallback としてのみ残る。
```

★ 「request body に fallback field が物理的に存在しない」ことでは **ない**。
canary 期間中は fallback safety のため bridge payload が残り続ける。これは仕様であり debt ではない。

## 5.1.1 Purpose matrix

| Purpose | Live? | Status | Server sources | Safety fallback bridge | Structural bridge | Notes |
|---|---:|---|---|---|---|---|
| `interview_practice` | ✅ | **FULL_SERVER** | profile / activity / values / self_analysis / es / matching / consultation / company_research | 全 field（未 verify 時） | — | `companyResearch.logId` は selection input（RLS で owner に限定） |
| `company_research_review` | ✅ | **FULL_SERVER** | profile / activity / values / self_analysis / matching | 全 field | — | Personal Memory 併用（dedupe 済み・`D-S5`） |
| `presentation_feedback` | ✅ | **FULL_SERVER** | profile / activity / values / self_analysis / es / interview / matching / consultation | 全 field | — | `config.useCareerContext` は user の同意 toggle（source ではない） |
| `self_analysis` | ✅ | **FULL_SERVER** | profile / activity / values / self_analysis | base + pastSummaries | — | `conversation` / `userInput` は request 固有入力（source ではない） |
| `self_analysis_deep_dive` | ✅ | **FULL_SERVER** | profile / activity / values / self_analysis | base + pastSummaries | — | 同上 |
| `consultation` | ✅ | **HYBRID** | profile / activity / values / self_analysis / es / interview / presentation / company_research / matching / **gd_room** | 上記すべて | **solo `gd`** | Event Signal は Layer 3 として分離（`D-L3`） |
| `matching` | ✅ | **HYBRID** | profile / activity / values / self_analysis / es / interview / consultation / **gd_room** | 上記すべて | **solo `gd`** | 決定的スコアエンジンの入力も同じ resolver 経由 |
| `es_review` | ❌ | DORMANT_INTENTIONAL | — | — | — | registry のみ。es-review route は静的 SYSTEM_PROMPT |
| `interview_complete` | ❌ | DORMANT_INTENTIONAL | — | — | — | complete route は `interview_practice` を使用 |
| `gd_feedback` | ❌ | DORMANT_INTENTIONAL | — | — | — | GD route は transcript 主体・career context 不使用 |
| `mypage_summary` | ❌ | DORMANT_INTENTIONAL | — | — | — | route 未実装（予約） |
| ~~`es_generation`~~ | — | **RETIRED**（`D-S12`） | — | — | — | live callsite ゼロ。enum / registry / renderer / mapping を削除 |

### INTENTIONALLY_CONTEXT_FREE な live route（purpose を持たない）

`es/deep` / `es/organize` / `es-review` / GD 系 route / `self-analysis/job` は
**career context を一切使わない**のが現在の product contract（静的 system prompt + その場の入力のみ）。
purpose enum を持たないため上表には現れない。

## 5.1.2 Source authority matrix

| Source | Authority class | Server-readable | Source-Sync needed | Structural limitation |
|---|---|---:|---:|---|
| `profile` | Class 1 device-canonical + mirrored | ✅ | ✅ | — |
| `activity` | Class 1 | ✅ | ✅ | — |
| `values` | Class 1 | ✅ | ✅ | `updated_at` は DB trigger 上書きのため sync view 除外 |
| `self_analysis` | Class 1 | ✅ | ✅ | — |
| `es` | Class 1 | ✅ | ✅ | body / mode / groupId / version / deepDive は mirror 非往復 |
| `interview` | Class 1 | ✅ | ✅ | — |
| `matching` | Class 1 | ✅ | ✅ | — |
| `company_research` | Class 1 | ✅ | ✅ | `updated_at` は trigger 上書きのため除外 |
| `presentation` | Class 1 | ✅ | ✅ | — |
| `consultation` | Class 1 | ✅ | ✅ | `updated_at` は trigger 上書きのため除外 |
| **`gd_room`** | **Class 2 server-authoritative** | ✅ | ❌（`D-S10`） | theme / format / 所要時間は table に無く既定値になる |
| **solo `gd`** | **Class 3 client-only / no mirror** | ❌ | — | ★ **table も mirror module も存在しない**（`D-S11`） |

### Class の意味

- **Class 1**: canonical は端末の localStorage、Supabase は mirror。server が読んだ内容が要求端末の
  canonical と一致する保証が無いため **Source-Sync claim（負の安全ゲート）が必須**。
- **Class 2**: **server が著者**（`career_gd_room_results` は result route が service-role で upsert）。
  client の copy は表示 cache。client canonical という概念が無いため Source-Sync を適用すると
  「client cache が古い ⟹ 正しい server データを使えない」という **逆向きの誤り**になる。
  authority は `authenticated owner + owner-scoped RLS + server state`。
  ★ canary gate（purpose opt-in AND canary user）は **免除されない**。
- **Class 3**: server-visible authoritative representation が存在しない。

## 5.1.3 Bridge inventory（2 種類を厳密に分ける）

### (A) Safety fallback bridge — **architecture debt ではない**

server path は完成しており、以下のときだけ使われる:
`Source-Sync mismatch` / `flag OFF` / `non-canary` / `unreadable` / `server 空 + bridge 有`。

対象: 全 migrated purpose の全 personal field（上表 "Safety fallback bridge" 列）。

> canary 期間中は **意図的に残す**。これを削ると未 verify 時に context が消える。

### (B) Structural bridge dependency — **architecture debt**

server-readable source が存在せず、**normal verified flow でも** client bridge が必要:

| Source | 使用 purpose | 影響 | 解消に必要なもの |
|---|---|---|---|
| solo `gd`（`careerGdResults`） | `consultation`（gd block）/ `matching`（gdSnapshot） | 補助文脈のみ（主情報は活動・自己分析・就活軸。matching では決定的エンジンに入れず AI 補助 10〜20% 相当） | 新 table + RLS + client mirror writer + Source-Sync kind（`D-S11` で **見送り決定**） |

観測では `gd_solo:not_server_capable` として **safety fallback とは別に**数える（`D-S11`）。

## 5.1.4 Layer 1 read efficiency / snapshot semantics

- **1 request / 1 Layer 1 snapshot**（`D-S13`）。`Request` を key にした WeakMap で
  Server Context resolver と Personal Memory resolver が **同じ kind を二度読まない**。
  （Closure Batch 前は `company_research_review` が 1 request で 2 回読んでいた。実測して修正済み。）
- 観測は purpose あたり 1 件（`company_research_review` は Personal Memory の 1 件へ合流）。

### 保証していること / していないこと（過大主張しない）

```text
保証する  : read-once per kind per request（同一 request 内で同じ kind を二度読まない）
保証しない: 複数 table を跨いだ single transaction snapshot
```

kind ごとに別 select であり、その間に他端末の write が入れば異なる時点のデータが混ざりうる。
ただし read 安全性は `D-S1` の Source-Sync veto が担保する
（mirror != 要求端末 claim ⟹ その source を veto ⟹ stale prompt 注入なし）。

## 5.1.5 Personal Optimization completion（誇張しない評価）

| 観点 | 評価 | 根拠 |
|---|---|---|
| **structural implementation** | **~98%** | Layer 1 reader / Source-Sync / authority class / per-source merge / shared selector / canary gate / observability / request snapshot がすべて実装・QA 済み。残りは W2/W5 の write integrity のみ |
| **live-purpose migration** | **100%（7/7）** | live purpose 7 件すべてが server context 経路に接続済み（5 FULL_SERVER + 2 HYBRID）。LEGACY はゼロ |
| **safety fallback dependence** | **意図的に 100%** | 全 purpose が未 verify 時に bridge へ倒れる。**これは debt ではなく設計**（canary 期間の必須安全装置） |
| **structural bridge debt** | **1 source（solo GD）のみ** | 全 personal source 12 種のうち 1 種。補助文脈用途に限定。`D-S11` で意図的に据え置き |
| **browser validation** | **0%** | ★ **NOT PERFORMED — deferred by Human instruction** |

> 完成度を「bridge field が物理的に残っているから未完」とは数えない（`D-S8`）。
> 逆に「意図的な safety fallback がある」ことを理由に過小評価もしない。
> **未解決の architecture work は solo GD mirror（意図的据え置き）と W2/W5 write integrity の 2 件のみ。**

---

# 5.2 ★ 未実施の検証（隠さない）

> **Actual signed-in browser E2E remains outstanding.**

Human 指示により実ブラウザ session での E2E は延期。
現在の検証範囲は real env-derived config / fixture auth simulation / route-level logic /
parity harness / adversarial QA まで。実ユーザー click-through と実 AI call は未実施。

---

# 6. 既知の残課題

0. **~~D-R2~~ は closed**（`D-S1`）。残るのは下記のみ。

1. **~~NEXT-6 の残り~~ は Batch 2 + Closure Batch で解消**。`gd_room` は Class 2 として server 化
   （`D-S10`）。残る structural bridge は **solo `gd` の 1 件のみ**（`D-S11` で意図的据え置き）。
   `eventSignals` は Layer 3 であり Personal Optimization の source ではない（`D-L3`）。
   request body の bridge field 自体は safety fallback 用に残す（削除しない・`D-S8`）。
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
5. **~~`es_generation`~~ は Closure Batch で retire 完了**（`D-S12`）。enum / registry / orchestrator
   branch / renderer / purposeMapping / QA fixture をすべて削除し、実 call graph と一致させた。
   `lib/careerServerContext/baseContext.server.ts` は依然 **DORMANT_INTENTIONAL**
   （production から呼ばれない QA 対象 module。Batch 3 で suite 移行後に削除予定）。
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

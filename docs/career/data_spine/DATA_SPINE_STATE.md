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

`es/deep` / `es/organize` / `es/materials` / `es-review` / GD 系 route / `self-analysis/job` は
**server 側で career context を組み立てない**のが現在の product contract。
purpose enum を持たないため上表には現れない。

★ ES 材料選択（V1・2026-08-15）による限定的な変更:
`es/deep` / `es/organize` は、**ユーザーが画面で明示的に選択した既存 Career Data**を
`knownFacts`（'ラベル: 値' の行）/ `missingAxes`（観点 key）として **request body から**受け取る。

```text
client（localStorage canonical）
  → buildEsMaterialCandidates（純関数・決定論）
  → ユーザーが選択
  → knownFacts / missingAxes を request body へ
  → es/deep・es/organize（bounded・normalize 済み）
```

したがって次はいずれも **変化していない**:

- server の Layer 1 read: **なし**（`loadPurposeServerContext` を呼ばない）
- purpose enum / registry / orchestrator: **不変**（`es_deep_dive` purpose は作っていない）
- Source-Sync / canary gate: **対象外**（server が mirror を読まないため veto の必要がない）
- 未指定時の prompt: **byte 一致**（`scripts/career-es-material-selection-qa.ts` の golden が固定）

`es/materials`（関連度の順位付け）も同様に body の候補ラベルのみを見る。
将来 server 側で Layer 1 を読む設計へ移す場合は、purpose 追加を伴う別 slice として Human decision を要する。

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

# 5.3 Collective Intelligence（Layer 4 / Layer 5 / Consent）— Closure Batch 2026-08-14

## 5.3.0 `ACTIVATION_READY` の定義（`D-C7`）

```text
ACTIVATION_READY =
  code path complete + schema complete/drafted + RLS complete
  + consent gates complete + privacy guards complete
  + moderation gate complete（Layer 5 のみ必須）+ QA complete + default OFF
```

```text
ACTIVATION_READY ≠ LEGALLY_APPROVED
ACTIVATION_READY ≠ PRODUCTION_ENABLED
```

実装が完成していることと、有効化してよいことは **別**。
有効化には `evaluateActivation()` の全条件（flag AND canary AND infra AND policy AND consent
AND legal AND retention/cohort AND moderation）が必要で、そのほとんどは Human decision。

## 5.3.1 Layer 4 matrix

| Component | Status | Production-ready? | Human blocker |
|---|---|---|---|
| projection（default-deny allowlist） | COMPLETE | ✅ | — |
| contribution bounding（user-level boolean） | COMPLETE | ✅ | — |
| cohort guard（absolute / audience 閾値） | COMPLETE | ⚠ 閾値が PROVISIONAL | H-L1 |
| rare category / 交差 dimension 禁止 | COMPLETE | ✅ | — |
| artifact（suppressed は数値を持たない） | COMPLETE | ✅ | — |
| provenance（source class / version / policy） | COMPLETE | ✅ | — |
| **source eligibility 表**（`D-C2`） | COMPLETE（本 Batch 新設） | ✅ | — |
| **retention policy**（`D-C3`） | COMPLETE（構造のみ・期間は未確定） | ⚠ fail-closed で未設定 | H-L2 |
| invalidation / regeneration | COMPLETE | ⚠ executor 未実装 | H-L8 |
| **deletion propagation matrix**（`D-C6`） | COMPLETE（本 Batch 新設） | 一部 human_policy_required | H-L5 |
| renderer（disclaimer / 禁止表現） | COMPLETE | ⚠ 文言の法務確認 | H-L7 |
| DDL（table / RLS enabled / policy 無し） | COMPLETE | ⚠ read policy 未作成（意図的） | H-L8 |
| read repository / batch repository | COMPLETE | ⚠ 実 DB 未接続 | H-L8 |
| ETL | SCAFFOLD_ONLY（offline synthetic） | ❌ production batch 無し | H-L8 |
| shadow dispatcher（consultation） | COMPLETE | ⚠ synthetic-only 固定 | H-L8 |
| **production consumer** | **0** | — | 意図的（増やさない） |

## 5.3.2 Layer 5 matrix

| Component | Status | Production-ready? | Human blocker |
|---|---|---|---|
| company identity resolution（alias collision 検出） | COMPLETE | ✅ | — |
| contribution 型 / fingerprint / validation | COMPLETE | ✅ | — |
| **source class 分類**（`D-C4`） | COMPLETE（本 Batch 新設） | ✅ | — |
| **explicit sharing admission gate**（`D-C4`） | COMPLETE（本 Batch 新設） | ✅ | — |
| PII scan（not_scanned を安全と見なさない） | COMPLETE | ⚠ regex ベースの限界あり | H-L7 |
| moderation FSM（raw → published 不可） | COMPLETE | ⚠ 運用者不在 | H-L6 |
| lifecycle 遷移表 | COMPLETE | ✅ | — |
| dedupe / conflict（自動統合しない） | COMPLETE | ✅ | — |
| provenance（internal / public 分離） | COMPLETE | ✅ | — |
| consent snapshot（append-only） | COMPLETE | ⚠ policy version 未確定 | H-L4 |
| projection（published のみ・contributor 非開示） | COMPLETE | ✅ | — |
| DDL（table / RLS enabled / policy 無し） | COMPLETE | ⚠ owner 列 / read view 未作成 | H-L8 |
| repository（supabase read/write） | PARTIAL | ❌ 実 DB 未接続 | H-L8 |
| takedown / legal hold | COMPLETE（型・状態のみ） | ❌ 運用 process 無し | H-L6 |
| VERIFIED_PUBLIC_SOURCE 取り込み | SCAFFOLD_ONLY（型のみ） | ❌ 実装なし | H-L4 |
| **production consumer** | **0** | — | 意図的 |

## 5.3.3 Data eligibility matrix

| Data class | Personal | Aggregate | Shared KB |
|---|---:|---:|---:|
| `source.profile` / `activity` / `values` | ✅ | ❌ | ❌ |
| `source.self_analysis` / `es` / `interview` | ✅ | ❌ | ❌ |
| `source.matching` / `presentation` / `consultation` | ✅ | ❌ | ❌ |
| `source.gd_room` / `gd_solo` | ✅ | ❌ | ❌ |
| **`source.company_research`** | ✅ | ❌ | ❌ **自動共有なし** |
| `memory.base` / `self_analysis` / `es` / `interview` | ✅ | ❌ | ❌ |
| **`event.feature_usage`** | ✅ | ⚠ **条件付き可** | ❌ |
| `event.signal_summary` | ✅ | ❌ | ❌ |
| **`contribution.company_knowledge`** | — | ❌ | ⚠ **条件付き可** |
| `raw.free_text` | ✅ | ❌ | ❌ |
| *未知の data class* | ✅ | ❌ | ❌ （default deny） |

★ 「条件付き可」は **分類上の上限**であって許可ではない。
consent scope + cohort 閾値 + suppression（Layer 4）/ 明示 consent + PII scrub + provenance +
moderation（Layer 5）をすべて満たしたときだけ実際に通る。

★ `ANONYMOUS_AGGREGATABLE` は **1 種類のみ**（`event.feature_usage`）。
「Event Log があるから全 event を aggregate してよい」は構造的に成立しない。

## 5.3.4 Consent matrix

| Purpose (scope) | Family | Explicit consent? | Default | Revocable |
|---|---|---:|---|---:|
| `personal_service_processing` | personal_optimization | 不要（サービス提供） | **deny** | ✅ |
| `internal_aggregated_analytics` | aggregate_contribution | **必要** | **deny** | ✅ |
| `user_facing_aggregated_insight` | aggregate_contribution | **必要** | **deny** | ✅ |
| `ai_context_aggregated_insight` | aggregate_contribution | **必要** | **deny** | ✅ |
| `externally_shared_insight` | aggregate_contribution | **必要** | **deny** | ✅ |
| `company_knowledge_contribution` | company_knowledge_sharing | **必要** | **deny** | ✅ |

★ `defaultGranted` は型レベルで `false` に固定してある（「既定で同意済み」の entry を **書けない**）。
★ family が同じでも scope が違えば別 consent（`isSameConsentPurpose` は同一 scope のみ true）。
★ missing / unknown / invalid version / unsupported version はすべて **NOT CONSENTED**。

## 5.3.5 Activation gates

```text
Layer 4 activated =
    feature flag ON
AND requesting user が canary allowlist
AND infrastructure ready
AND policy readiness（LAYER4_REQUIRED_DECISIONS 全承認）
AND consent ready
AND legal approved
AND retention configured（期間 + policy version）
AND cohort threshold configured

Layer 5 activated =
    上記の共通条件（Layer 5 の readiness decision 集合）
AND moderation ready          ← Layer 5 のみ追加
```

いずれか 1 つでも欠ければ **OFF**。既定（何も設定しない状態）では
`blockers = [consent_not_ready, flag_off, infrastructure_not_ready, legal_not_approved,
policy_not_ready, user_not_canary, …]` となり、決して有効化されない。

**事故 ON の否定**（`isAccidentalEnablePattern`）: `NODE_ENV=production` / env 未設定の true 化 /
空 allowlist の全許可 / 法務未設定の approved 化 / moderation module の存在だけ、
これらはいずれも activation の根拠として認めない。

## 5.3.6 ~~residual boundary~~ → **解決済み**（`D-R1` / 2026-08-14）

Closure Batch では以下を residual boundary として記録していた:

```text
app/api/career/consultation/route.ts（member request）
  → dispatchAggregatedInsightConsultationShadow
    → createAggregatedInsightRuntime.server
      → getSharedServiceRoleReadPort   ← service role
```

**Decision Resolution Batch で構造的に解消した。**

| | 変更前 | 変更後 |
|---|---|---|
| member path | shadow runtime（privileged port を import） | `server/memberGateProbe.server.ts`（**privileged 非 import / DB read ゼロ**） |
| privileged path | 同上（route から到達可能） | `batch/aggregatedInsightPrivilegedShadow.batch.ts`（**route から到達不能**） |

検証（QA `HDR-1` / `HDR-2` が **推移的 import graph** を実測）:

```text
app/ 配下 363 ファイル → sharedServiceRolePorts への到達経路: 0
app/ 配下 363 ファイル → *.batch.ts への到達経路:            0
```

member path が行う I/O は **auth 解決のみ**（canary 判定用）。DB read は一切ない。
返り値の型 `MemberGateProbeResult` は `performedRead: false` / `privilegedAccess: false` を
**型として**持ち、契約が構造的に固定されている。

## 5.3.7 Layer 5 identity strategy = **I2**（`D-R2`）

`contributor が opaque key のままでは owner-scoped RLS を張れない` という blocker を解決した。

| 案 | 判定 |
|---|---|
| I1 contribution row が直接 `auth.uid()` を持つ | ❌ contribution table が「誰が何を投稿したか」の台帳になる |
| **I2 subject 対応表（`auth.uid()` ↔ opaque key）** | ★ **採用** |
| I3 完全 anonymous | ❌ 撤回・削除・本人確認が原理的に不可能 |

I2 の利点:
- contribution 本体に識別子が入らないまま owner RLS を張れる（対応表越しの subquery）
- **subject を unlink すると contribution は再識別不能になる**（強い削除手段）
- `revoked → future contributions blocked` を構造的に保証できる（unlink 後は opaque key を解決できない）

純粋ロジックは `lib/careerCompanyKnowledge/contributorIdentity.ts` に実装済み。
DDL は `supabase/prototype/collective_intelligence_activation_draft.sql` に draft（**未適用**）。

## 5.3.8 ETL / batch infrastructure（`D-R3`）

`lib/careerAggregate/batch/batchRunner.ts` に **provider-neutral** runner を実装した。
特定 cloud SDK を import せず、I/O はすべて injected port（`BatchPorts`）。

| 要件 | 実装 |
|---|---|
| idempotency | `runKey = (metric, version, window)`。succeeded なら再実行を skip |
| retry safety | 失敗しても cursor を進めず、同じ window を再試行できる |
| cursor / checkpoint | window 単位。中断しても続きから |
| dry-run | 書き込みゼロで「実行されるか」だけ返す |
| failure state | 失敗を enum で記録（握り潰さない） |
| rebuild | invalidation 由来を通常実行と同じ経路で処理 |

**保証しないこと（誇張しない）:** 分散ロック（排他は port 実装＝DB の UNIQUE / advisory lock の責務）、
scheduling（cron の時刻・再試行間隔は provider 側）。

---

# 5.4 Policy Freeze（Human 承認済み / 2026-08-14）

## 5.4.1 承認結果

| ID | Status | 内容 |
|---|---|---|
| **H-L1** cohort 閾値 | **APPROVED** | 10 / 20 / 50 / 100（+ rare category 20） |
| **H-L2** retention | **PROVISIONALLY_APPROVED_PENDING_LEGAL** | 5 種別（90 / 30 / 730 / 400 / 180 日） |
| **H-L3** 利用目的 | **APPROVED** | 許可 = internal analytics + user-facing trend。**AI context 除外** |
| **H-L4** sharing | **APPROVED** | master opt-in **AND** per-contribution 確認（二段） |
| **H-L5** 撤回後 | **PROVISIONALLY_APPROVED_PENDING_LEGAL** | 状態別（delete / unpublish / legal gate） |
| **H-L6** moderation | **APPROVED** | 自動 pre-screen → 人手承認 → 公開 |
| **H-L7** legal | **PENDING_LEGAL_REVIEW** | `COLLECTIVE_INTELLIGENCE_LEGAL_REVIEW.md` の 10 項目 |
| **H-L8** infra | **TECHNICALLY_RESOLVED / PROVISIONING_PENDING** | migration 準備済み・未適用 |

## 5.4.2 policy の単一 source（`D-P1`）

```text
lib/careerCollectiveIntelligence/policy/registry.ts
```

policy version（`CURRENT_POLICY_VERSION = 1`）を持ち、consent record /
aggregate provenance / shared knowledge provenance から追跡できる。
**未サポート version は fail-closed**（serve しない・cleanup も計画しない）。

★ 既存 module（`careerAggregate/policy.ts` / `rareCategory.ts`）の値と
registry の値が **一致していること**を QA `PF-1` が検証する（二重管理の検出）。

## 5.4.3 承認内容の実装先

| 承認 | 実装 |
|---|---|
| H-L1 cohort | `policy/registry.ts` の `COHORT_POLICY`（既存 guard と値一致） |
| H-L2 retention | `policy/retentionPlanner.ts`（期限計算 / planner / dry-run / safe-delete port） |
| H-L3 purpose | `registry.ts` の `ALLOWED_/FORBIDDEN_AGGREGATE_PURPOSES` + 静的 guard（`PF-3`） |
| H-L4 sharing | `policy/sharingGate.ts` の `evaluateSharingStages`（二段 gate） |
| H-L5 withdrawal | `sharingGate.ts` の `planWithdrawal`（legal 未承認時は `unpublish` へ倒す） |
| H-L6 moderation | `moderation/moderatorAuthorization.ts`（**provider 未設定は全拒否**） |
| H-L7 legal | `preflight.ts` の `isLegalApproved`（承認 source 必須） |
| H-L8 infra | `supabase/migrations_pending/`（4 SQL + README・**未適用**） |

## 5.4.4 destructive 操作が起きない構造

retention cleanup が実際に削除するのは、以下が **すべて**揃ったときだけ:

```text
dryRun === false（明示）
AND policy version がサポート対象
AND legalApproved === true
AND SafeDeletePort の実装が渡されている
```

★ 現在 `SafeDeletePort` の production 実装は **repo に存在しない**（`PF-11` が固定）。
つまりコードから destructive cleanup を起動する経路が無い。

## 5.4.5 production candidate migration（**未適用**）

```text
supabase/migrations_pending/
  README.md                              … 適用条件・順序・rollback・preflight・post-apply 検証
  010_consent_policies_and_ledger.sql    … consent manifest + append-only ledger + append RPC
  020_contributor_subject_identity.sql   … I2 対応表 + ensure/unlink RPC
  030_layer5_read_contract.sql           … owner-scoped policy + published view（security_invoker）
  040_layer4_read_contract.sql           … published/valid のみ SELECT + index
```

**RLS 安全性:** すべての migration が
`CREATE TABLE → ENABLE RLS → CREATE POLICY → GRANT` の順序。
GRANT を最後にすることで「保護なしで公開される瞬間」を作らない（`PF-13` が静的に検査）。

**適用済み DDL 側は変更していない**（依然 policy 無し・deny-by-default）。

## 5.4.6 moderator 認可（`D-P3`）

本 repo に admin / moderator の認可基盤は **存在しない**（監査で確認）。
そこで **interface + fail-closed gate** までを実装し、実 provider は provisioning 項目とした。

```text
provider 未設定 → no_moderator_provider で **全拒否**
（「adapter が無いから素通し」には絶対にしない）
```

client 由来の `isAdmin` / `moderatorId` / `role` を根拠にする実装が repo に無いことを
`PF-7` が静的に固定する。

## 5.4.7 batch provider（推奨）

| | provider | 備考 |
|---|---|---|
| **推奨** | Supabase `pg_cron` + SECURITY DEFINER RPC | DB 内で完結。排他・retry を同 transaction で扱える。member path と物理的に分離 |
| 代替 A | Vercel Cron + 専用 route | route である以上 member path と同じ入口になる点に注意 |
| 代替 B | GitHub Actions schedule | 完全外部。secret 管理が増える |

どれを選んでも `batchRunner.ts` は変更不要（provider-neutral）。
**concurrency は 1**（runner は分散ロックを提供しないため provider 側で保証する）。

---


# 5.5 Operational Validation（2026-08-14 / production 未変更）

詳細: `COLLECTIVE_INTELLIGENCE_OPERATIONAL_VALIDATION.md`

## 5.5.1 実行環境の制約

実 DB apply 検証（Option 1）を試みたが、`psql` / `docker` / Supabase CLI /
postgres client library が **いずれも本環境に存在しない**。production DB へは接続しないため、
**Option 2（静的実行検証）** を採用した。

```text
担保できた  : statement 分割 / transaction 境界 / RLS 順序 / 依存順序 / 冪等性 /
              RPC の owner 束縛 / published view の漏洩
担保できない: Postgres parser による文法検証 / 実行時権限 / RLS の実効性
              → staging（実 DB）で要実施。runbook Step 3 がその工程
```

## 5.5.2 検証結果サマリ

| 領域 | 結果 |
|---|---|
| Migration（M1〜M10） | ✅ 全項目 pass（owner-scoped policy 3 / 想定外 broad policy 0） |
| Layer 4 dry-run（L4-1〜L4-10） | ✅ 61 projections → 60 contributions（heavy user 畳み込み）→ valid artifact |
| Layer 4 suppression | ✅ n=3/15/30/80 すべて suppressed。suppressed に数値なし |
| ETL（idempotency / retry / cursor / dry-run） | ✅ 再実行で execute 1 回。失敗時 cursor 据え置き。dry-run 書き込み 0 |
| Layer 5 dry-run（L5-1〜L5-12） | ✅ draft→…→published を一本通し。拒否経路も全て検証 |
| I2 identity lifecycle | ✅ unlink 後は本人にも他人にも紐づかない（provenance は保持） |
| Consent lifecycle | ✅ grant→contribute→revoke→blocked / 未知 version で fail closed |
| Retention 境界 | ✅ 10 fixture 中 境界超過 5 件だけが candidate |
| Preflight（3 mode） | ✅ dev=ready / staging・production=NOT READY |

## 5.5.3 ★ Legal Q3 の technical trace（法務へ渡す evidence）

```text
consent revoked
  → 以後の projection が reject          【future input blocked】     ✅ 実測
  → 以後の batch 入力に現れない           【future rebuild excludes】  ✅ 実測
  → 影響 window を invalidate + regenerate                            ✅ 実装済み
  → 生成済み artifact から個人寄与だけを差し引く                      ❌ 構造的に不可能
```

**技術的根拠:** artifact の field は集計値と provenance のみで、
**個人を辿れる field が 1 つも無い**（QA が検証済み）。
逆引きを保持すれば差し引き可能になるが、それは匿名集計の前提そのものを壊す。

法務判断（A: 制約を許容 / B: 差し引き必須 → Layer 4 再設計）は Human が行う。

## 5.5.4 Moderator adapter 判定 = **Case B**

repo を再監査した結果、**trusted server-side admin identity source は存在しない**
（role table / app_metadata role / admin route いずれも無し）。

→ provider interface + provisioning contract のみを残した。
production code path では `moderator provider missing → DENY`。
QA では synthetic adapter を使う（production には存在しない）。
Human approver は **hardcode していない**。

## 5.5.5 Preflight target mode（`D-O2`）

```text
development  ready=true   （policy の整合のみ必須）
staging      ready=false  blocking=[infra, migration, moderator, rls]
production   ready=false  blocking=[infra, legal, migration, moderator, rls]
mode 未指定  → production として評価（既定は最も厳しい側）
```

★ **environment による自動 approve はしない。** mode は「どの check を必須にするか」を
変えるだけで、どれかを自動的に満たしたことにはしない。

★ **blocking はすべて運用項目**。architecture 起因の blocker は **0**（QA `OD-12` が固定）。

## 5.5.6 Canary stage と consumer 必要地点

```text
CI-0 all OFF                     … consumer 不要（現在ここ）
CI-1 consent surface canary      … consumer 不要
CI-2 contribution collection     … ★ Layer 5 投稿 UI が必要（初の consumer）
CI-3 Layer 4 batch dry-run       … consumer 不要
CI-4 Layer 4 canary serving      … ★ trend 表示 consumer が必要
CI-5 Layer 5 moderation          … ★ moderation UI が必要
CI-6 Layer 5 canary serving      … ★ 参考表示 consumer が必要
```

★ **CI-3 までは consumer 0 のまま到達できる**（legal → migration → batch → dry-run）。

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

# 9-C. Slice log — Personal Memory production rollout hardening（2026-08-20）

```text
Last verified date: 2026-08-20
Branch: gate-b-preview
HEAD (before): 88f4ca2
Working tree: clean（本 slice の変更のみ）
Completed slice: Layer 2 read gate に rollout scope / emergency deny を追加 + boundary escape 封じ
Files changed:
  lib/careerMemory/persistence/readGate.ts
  lib/careerMemory/persistence/readGateConfig.server.ts
  lib/careerMemory/personalMemoryPromptContext.ts
  scripts/career-personal-memory-rollout-qa.ts（新設・常設 harness / PersonalMemoryAll へ組込）
  package.json / .env.example
  docs/career/personal_memory_read_pilot_operator_packet.md
QA executed: tsc / eslint / next build / qa:careerPersonalMemoryAll（rollout 含む）/
  qa:careerPersonalMemoryWiring / qa:careerMemoryPromptGolden / qa:careerPersonaSpotcheck /
  qa:careerMemory{Matching,Interview,Consultation,Presentation} / qa:careerSourceSync /
  qa:careerDataSpinePersonalOptimizationClosure / qa:careerMypageDataSpine 他 13 本
QA result: ALL PASS
Architecture discrepancy found:
  ★ P0: **GA path が存在しなかった。** master flag を ON にしても allowlist が空なら
    `evaluatePersonalMemoryReadGate` は全員 deny を返す（実測）。wildcard は parser が
    設定全体 invalid にする設計のため、全開放手段が「全 UUID 列挙（cap 50・運用不能）」しか
    無かった。＝ flag を開けても **no-op なのに通電したように見える**状態だった。
    → `CAREER_PERSONAL_MEMORY_READ_ROLLOUT`（既定 'canary'）を追加して解消。
  ★ P1: **boundary escape が成立していた。** `<personal_memory>` block に載る文字列には
    本人の自由入力（ES の企業名 / 設問、profile の志望条件、活動の代表タイトル）が含まれ、
    そこに `</personal_memory>` を混ぜると block が早期に閉じ、後続行が境界の **外** に出た（実測）。
    → renderer で境界タグ相当の並びを可視置換して封じた（cap/trim より前に実施）。
  ★ 観測（欠陥ではない）: `consultation` purpose は renderer allowlist にあるが
    `loadPersonalMemorySectionsForPrompt` の callsite が無く、実際には常に空（dead contract）。
    Layer 2 が prompt へ到達するのは interview 3 route + company-research の 4 route のみ。
Open blockers:
  Production env（Vercel）への書込手段がこの環境に無い（vercel / gh CLI 不在）。
  コードは rollout 可能な状態だが、Phase 7 の env 設定は operator が実施する必要がある。
Next recommended slice: Phase 7（Production env 設定 + smoke）→ 観測を見て consultation の通電判断
Human decision required before next slice: Phase 7 実行の可否（H-4）
```

## この slice で変わった辺（edges）

- **追加**: read gate に `scope`（canary / all）と `deniedUserIds`（緊急 deny）。
  既定は `canary` で、2 引数の従来呼び出しは **完全に従来挙動**（後方互換）。
- **強化**: `<personal_memory>` の境界。本文由来の閉じタグで block を脱出できない。
- **不変**: source-sync veto / rebuild-on-stale / RLS / service-role 不使用 / purpose filter /
  matching への Layer 2 非注入 / Company Data Spine / Layer 3・4・5。

---

# 9-B. Slice log — My Page rebuilt on the User Data Spine（2026-08-20）

```text
Last verified date: 2026-08-20
Branch: gate-b-preview
HEAD (before): 8a13052
Working tree: clean（本 slice の変更のみ）
Completed slice: My Page = User Data Spine の presentation / editing layer 化
Files changed:
  types/careerProfile.ts
  app/career/profile/ProfileClient.tsx
  app/career/mypage/{page.tsx,mypageSummary.ts,mypageDataSpineView.ts,
                     saveCareerAspiration.ts,AspirationCard.tsx,SpineSections.tsx,
                     canonicalSnapshotStore.ts}
  scripts/career-mypage-data-spine-qa.ts（新設・常設 harness）
  scripts/career-personal-memory-wiring-qa.ts（callsite manifest 追加＝強化）
  package.json（qa:careerMypageDataSpine）
QA executed: tsc / eslint / next build / qa:careerMypageDataSpine /
  qa:careerPersonalMemoryAll / qa:careerPersonalMemoryWiring / qa:careerSourceSync /
  qa:careerDataSpinePersonalOptimizationClosure / qa:careerMemory*（golden 群）/
  qa:careerMatchingDeferral / qa:careerEventsTimeline / qa:careerConsentCapture /
  qa:career*OrchestratorParity / qa:careerRestoreTrigger 他
QA result: ALL PASS（baseline も全て緑。regression なし）
Architecture discrepancy found:
  ★ profile の 志望条件 5 field（targetIndustries / targetJobs / targetCompanies /
    jobHuntingStatus / preferredLocations）が **dead prompt input** だった。
    lib/careerAi/prompts.ts:renderProfile と Layer 2 rebuild.ts:projectProfile が
    以前から読んでいたのに、書き込む UI が 1 つも存在せず常に空だった。
    本 slice で My Page を canonical な編集面として通電し、gap を解消した。
Open blockers: なし（本 slice に関して）
Next recommended slice: 変更なし（NEXT-8 canary rollout / H-3 / H-6 待ちのまま）
Human decision required before next slice: なし（本 slice は既存 gate を一切開けていない）
```

## この slice で変わった辺（edges）

- **追加**: `My Page → Layer 1 canonical write`（profile 志望条件）
  → 既存の 3 段（localStorage canonical → `career_profiles` mirror → Layer 2 base 再構築）
  をそのまま再利用。新しい writer / store / table / DDL は **ゼロ**。
- **追加**: `Layer 1 → 同一 projection（projectSectionFromSource）→ My Page 表示`
  → 「PASSAI が理解しているあなた」は server が prompt へ載せる Layer 2 payload と
  **同じ builder** の出力を翻訳したもの。別 formatter を作っていない。
- **不変**: `mypage_summary` purpose は **DORMANT のまま**（live callsite 0）。
  My Page は AI を呼ばない。closure QA の分類は変更していない。
- **不変**: Layer 3 / Layer 4 / Layer 5 / Company Data Spine / consent gate は無接続のまま。

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

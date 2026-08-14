# PASSAI CAREER — Data Spine Architecture

**Status:** Normative architecture document
**Audience:** Human maintainer + Claude Code
**Architecture snapshot source:** 2026-08-14 Data Spine handoff audit
**Last implementation sync:** 2026-08-14（NEXT-1〜NEXT-7 slice）

---

## 0. How to use this document

This file is the **implementation constitution** for PASSAI CAREER's Data Spine.

Read, in this order, before any Data Spine task:

1. `DATA_SPINE_ARCHITECTURE.md`（本ファイル）
2. `DATA_SPINE_STATE.md`
3. `DATA_SPINE_DECISIONS.md`
4. `CLAUDE_DATA_SPINE_PROTOCOL.md`
5. the current repository code relevant to the approved slice

### Authority rules

- Explicit Human decisions in `DATA_SPINE_DECISIONS.md` are authoritative.
- This architecture document defines intended invariants and boundaries.
- `DATA_SPINE_STATE.md` defines the last audited / verified operational state.
- The repository is the evidence of what is actually implemented.
- If repository code unexpectedly disagrees with this document, **do not silently rewrite either side**. Report the discrepancy before implementation.

---

# 1. Mission

PASSAI CAREER must move from `feature A → feature B → ad-hoc bridge context` to a stable Data Spine that supports:

1. **Personal optimization** — AI can use a compact, purpose-specific understanding of the current user.
2. **Collective intelligence** — privacy-preserving aggregate patterns can eventually improve product value.
3. **Reusable company knowledge** — explicitly shareable company-research knowledge can eventually become reusable.
4. **Context control** — the AI receives only the minimum data needed for the current purpose.

The architecture must prevent convenience-driven data leakage, duplicate truth stores, uncontrolled prompt growth, and silent cross-user inference.

---

# 2. System overview

```text
PASSAI feature surfaces
  ├─ Profile / basic info ├─ Activities ├─ Values ├─ Self analysis
  ├─ ES ├─ Interview ├─ GD ├─ Presentation ├─ Company research ├─ Consultation AI
        │
        ▼
┌───────────────────────────────────────────┐
│ Layer 1 — Source Data                     │
│ localStorage canonical + career_* mirror  │
└───────────────────────────────────────────┘
        │ deterministic projection（rebuild.ts / sourceProjection.ts）
        ▼
┌───────────────────────────────────────────┐
│ Layer 2 — Personal Career Memory          │
│ career_personal_memory（owner-scoped）    │
└───────────────────────────────────────────┘

Layer 1 ───────────────► Layer 3 — Career Event Log
                           │ privacy-preserving ETL only
                           ▼
                        Layer 4 — Aggregated Insight DB（fail-closed）

Explicit share contribution ──► Layer 5 — Company Knowledge Base（fail-closed）

Layer 1 / Layer 2 / approved L4 / approved L5
        │
        ▼
Context Orchestrator ──► purpose-specific AI output
```

### Correction to the concept image

- **Layer 3 does not feed Layer 2 Personal Memory.**
- Event metadata must not become ability, motivation, weakness, ranking, or matching evidence.
- Layer 4 and Layer 5 are fail-closed and have zero production consumers.
- Shared knowledge requires explicit consent and separate legal/product decisions.

---

# 3. Data classification model

## 3.1 PERSONAL_ONLY

self-analysis text / ES body / interview answers / consultation text / profile PII /
personal company-research notes / Personal Career Memory.

- owner-scoped only
- must not become shared aggregate raw input unless an explicit approved projection exists
- must not appear in shared company knowledge
- must not be exposed to another user
- raw personal text must not enter Event Log

## 3.2 ANONYMOUS_AGGREGATABLE

feature used / coarse usage period / coarse industry or role category / transition sequence /
broad improvement trend / privacy-safe bucketed counts.

- no raw body text / no direct user identifiers / no contributor identity lists
- minimum cohort / anonymity rules apply before production use
- aggregated output is reference-only unless a separate decision explicitly changes that

## 3.3 EXPLICITLY_SHAREABLE

a user's explicitly submitted company-research contribution / selection-process information
submitted for reuse / content that passed contribution, consent, moderation, provenance, takedown rules.

- explicit opt-in required
- personal research does not automatically become shared research
- contributor identity must not leak into shared read projections
- moderation / provenance / takedown lifecycle is mandatory

---

# 4. Layer 1 — Source Data

## Purpose

Layer 1 preserves the original data produced by each product feature: the `career_*` family
(`career_profiles`, `career_activities`, `career_values`, `career_self_analysis_results`,
`career_self_prs`, `career_matching_results`, `career_es_logs`, `career_interview_sessions`,
`career_interview_results`, `career_presentation_sessions`, `career_presentation_results`,
`career_consultation_threads`, `career_company_research_logs`).

## Canonicality rule

> localStorage is canonical; Supabase tables are best-effort durable mirrors.

これは維持する（`D-S1` でも変更していない）。server が prompt に使ってよいのは
「canonical と一致すると **証明できた** mirror」だけ、という側で安全性を担保する。

★ **multi-device に「グローバル canonical」は存在しない。** localStorage canonical は端末ごとの
canonical であり、server が検証できるのは常に「*その request を出した端末* の申告との一致」。
グローバル canonical が必要になった時点で server-authoritative Layer 1（Option C）へ移行する。
詳細は `DATA_SPINE_DECISIONS.md` の `D-S1`。

## Write integrity（過大主張しないこと・`D-S3`）

mirror への write は **単一レコード系が無条件 upsert（last-writer-wins）** である。
3 つの性質を区別すること:

| 性質 | 現状 |
|---|---|
| **Read safety** — 古い personal context を AI に渡さない | ✅ 保証（`D-S1` veto） |
| **Mirror integrity** — mirror が巻き戻らない | ⚠️ 部分的（同一端末の順序は保証 / 別端末 stale write は未防止） |
| **Global multi-device consistency** — 全端末が同一 canonical を見る | ❌ 未保証（Option C 領域） |

- 同一端末の write は `lib/careerSourceData/mirrorWriteQueue.ts` が直列化し、
  遅延応答による巻き戻り（W4）を防ぐ。**client 時刻は順序判定に使わない。**
- 別端末の stale write（W2 / W5）は防げていない。ただし mirror が巻き戻っても
  要求端末の申告と一致しなくなるため `D-S1` veto が働き prompt は汚染されない。
- 完全な防止には server 採番 seq + compare-and-set RPC が必要
  （未適用 draft: `supabase/prototype/career_source_write_guard_draft.sql`）。

## Required invariant

Layer 1 is the **source of truth for derivation**. Layer 2 is a projection, never the original record.

## Server-read path（実装済み: NEXT-2）

```text
authenticated member
   → server-only Supabase client（lib/careerSupabase/serverClient）
   → owner-scoped RLS
   → lib/careerSourceData/serverReader.server.ts
   → lib/careerSourceData/rowMappers.ts（client mirror と共有の単一実装）
   → typed domain objects（CareerSourceBundle）
```

- No service-role bypass is allowed for normal member reads.
- 履歴系は `CAREER_SOURCE_LOG_MAX_ROWS` で上限を持ち、上限到達は `truncated`。
  **`truncated` / `error` の Source から導いた revision は freshness の権威にしない。**

---

# 5. Layer 2 — Personal Career Memory

## Purpose

Layer 2 is a compact, typed, purpose-usable projection of Layer 1. It prevents every AI feature
from repeatedly shipping large raw histories.

## Design principles

deterministic / AI-free construction / typed / owner-scoped / section-based / bounded size /
raw PII and long raw bodies excluded by structure / Source Data remains original truth.

## Persisted sections

`base` / `self_analysis` / `es` / `interview`（SQL CHECK と一致）。

## Freshness contract（実装済み: NEXT-3）

```text
Layer 1 current source（server read）
   → projectSectionFromSource（= rebuild.ts の builder）
   → computeContentRevision → expected revision
   → compare with persisted source_revision
   → fresh / stale / missing / invalid
```

- 一致 → `origin='persisted'`（**mirror 基準で** fresh）。
- 不一致 / 行なし / invalid → **request-local rebuild**（`origin='rebuilt'`, NEXT-4）。
- Source が権威的に読めない（`error` / `truncated`）→ **fresh と断定しない**（fail-open）。
- 旧 `D-R1`（永続 `status='fresh'` を無検証で信じる）へ戻す経路は **削除済み**（`D-S2`）。
  env も code path も production には存在しない。

### 保証範囲の正確な定義（`D-S1` source-sync veto 導入後）

> **Signal は negative safety gate であって source authority ではない。**
> 偽造 client が得られるのは「自分自身の stale own-data 使用を自分で許可する」ことだけで、
> 他人のデータ・identity 変更・RLS 迂回・Layer 4/5 到達はいずれも不可能（`D-S1` / QA H1）。


server は **2 段階**で検証する。両方通った section だけが prompt に載る。

1. **sync 検証**: client が **申告した** canonical revision == server が mirror から再算出した revision
   → first-party client flow において「申告と server 可視状態に矛盾が無い」ことの検証。
     ★ client-provided claim であり、localStorage 由来であることの **cryptographic proof ではない**
       （trust model は `D-S1` / `lib/careerSourceSync/signal.ts`）。
2. **memory 検証**: 永続 Memory の `source_revision` == 検証済み Source の projection revision
   → 不一致なら同じ検証済み Source から request-local rebuild

未提示 / 不一致 / 読取不能はすべて **veto**＝Personal Memory を使わず続行する。
これにより旧 `D-R2` の 3 ケース（stale 採用 / downgrade / 削除データ復活）は構造的に発生しない。
敵対的 trace は `scripts/career-personal-memory-mirror-divergence-qa.ts`（T1〜T10）が固定する。

## Rebuild / write-back

- rebuild は **request-local のみ**。server から DB へ書き戻さない（second writer を作らない）。
- write-back の可否は `H-3` の Human decision。

## Fail behavior

- Memory writes: best-effort / never-throw。
- Memory reads: fail-open（Memory 無しで従来 prompt）。
- 無効・stale 行を「真に fresh」として扱わない。

## Event Log boundary

**Do not persist Event Signals inside Personal Memory.**

---

# 6. Layer 3 — Career Event Log

privacy-safe behavioral metadata のみ（feature usage / coarse event type / broad timing bucket /
transition ordering / broad improvement pattern）。

## Forbidden content

ES body / interview answers / consultation text / GD transcript / names / emails / universities /
raw scores / prompts / AI responses / other free-form personal bodies.

## Semantics

append-only / owner-scoped read / fire-and-forget writers / client event idempotency /
retention・TTL は legal/product decision。

## Critical interpretation rule

Usage behavior does **not** prove ability / motivation / aptitude / employability / weakness /
pass-fail probability. Event Log / Event Signals must not leak into matching or ranking.

---

# 7. Layer 4 — Aggregated Insight DB

privacy-preserving collective intelligence（period-based behavior patterns / industry-level
difficulty trends / company-category concern patterns / improvement patterns / bucketed counts）。

Production consumers: **zero**（意図的）。

Required privacy boundary: user ID lists / contributor identities / raw personal bodies /
rare-category data を production artifact に出さない。cohorting・k-anonymity・consent snapshot・
watermark/manifest・rare-category suppression・privacy attack QA・invalidation を用いる。

**Activation rule: fail closed.**

---

# 8. Layer 5 — Company Knowledge Base

## Required four-way separation

1. Personal company research — private / owner-scoped
2. Explicitly shareable contribution — opt-in contribution candidate
3. Canonical reusable company knowledge — moderated shared knowledge
4. AI summaries — remain personal unless explicitly promoted

## Hard rule

Personal company research must **never automatically become shared company knowledge**.

## Required lifecycle

```text
explicit contribution → consent snapshot → PII scan → provenance → dedup / identity resolution
→ moderation state → canonicalization / version lineage → shared read projection → takedown / revoke
```

**Activation rule: fail closed.**

---

# 9. Context Orchestrator

The Orchestrator is the single purpose-specific assembly seam:
「この AI purpose に必要な最小の承認済み context は何か」。

## Current shape

```text
purpose
  → purpose policy（lib/careerContext/purpose.ts）
  → approved server-side loaders
      ├─ Layer 2: loadPersonalMemorySectionsForPrompt（gated canary）
      └─ Layer 1: loadServerBaseContext（purpose 単位 opt-in / NEXT-6）
  → minimum sections / context
  → renderers（crossFeature / personalMemory）
  → bounded prompt context
```

Orchestrator 自体は **純関数のまま**（I/O を内部に持たない）。read は route 側の server loader が担う。

### loader directory の使い分け（重要）

| directory | 位置づけ |
|---|---|
| `lib/careerContextLoaders/` | **P17-A の fail-closed scaffold**。常に `disabled` を返す。静的 guard が「production から import 0」を強制している。ここに live loader を置いてはいけない。 |
| `lib/careerServerContext/` | **通電済みの Layer 1 server loader**（NEXT-6）。purpose 単位 opt-in・default OFF。 |
| `lib/careerMemory/persistence/*.server.ts` | 通電済みの Layer 2 server read（canary gate 付き）。 |

## Purpose-specific reduction

Every purpose must be able to declare: allowed source classes / allowed Personal Memory sections /
Event Signal 可否 / aggregate insight 可否 / company shared knowledge 可否 / context budget /
omission・fallback behavior。

---

# 10. Allowed and forbidden edges

## Allowed / target edges

| From | To | Rule |
|---|---|---|
| Feature UI | Layer 1 | Save original product data |
| Layer 1 | Layer 2 | Deterministic owner-scoped projection |
| Feature action | Layer 3 | Privacy-safe behavioral event only |
| Layer 1 | Server Layer 1 reader | Owner-scoped RLS read |
| Layer 1 | Orchestrator | purpose opt-in **かつ sync 証明済み**の server base context のみ |
| Client | Server（sync signal） | revision token のみ。**veto 専用**（content / selector / 権限に使わない） |
| Layer 2 | Orchestrator | Purpose-allowed sections only |
| Layer 3 | Layer 4 | Privacy-preserving approved ETL only |
| Layer 4 | Orchestrator | Only after production gates close |
| Explicit share contribution | Layer 5 | Consent + moderation path only |
| Layer 5 | Orchestrator | Only after production gates close |

## Forbidden edges

| Edge | Reason |
|---|---|
| Layer 3 → Layer 2 | Event behavior must not become Personal Memory |
| Event usage → matching ability signal | Unsupported inference |
| Personal research → shared KB automatically | Consent boundary violation |
| Raw ES/interview/consultation text → Event Log | Privacy boundary violation |
| Layer 4/5 → production prompt before gates close | Fail-closed contract |
| Service role → ordinary member data read | Bypasses owner-scoped RLS |
| Client-declared `fresh` → permanent freshness authority | Retired（D-R1・rollback 専用） |
| Client sync signal → content authority / DB selector / user_id | `D-S1` trust model 違反（veto 専用） |
| D-R1 の再有効化（unsafe rollback） | `D-S2`。production 経路も env も存在しない |
| 証明できない mirror content → prompt | `D-S1` veto（旧 D-R2 の 3 ケース） |
| QA weakening → GREEN | Safety contract violation |

---

# 11. Canonicality and truth-store rules

- Layer 1 source data is the original product truth.
- Layer 2 / Layer 4 / Layer 5 are projections.
- 二つの store が食い違う場合、precedence を明示する（`D-P1`）。
- **第三の権威を追加しない。**

Known transitional duplicates:

- live `CareerContextPurpose` vs design `CareerMemoryPurpose`（`H-5` / 未統合のまま維持）

---

# 12. Freshness, rebuild, invalidation

```text
read Layer 1（server, owner-scoped）
  → compute expected revision
  → read persisted memory
  → fresh? ── yes ──► use（origin=persisted）
      │ no
      ▼
  rebuild from Layer 1（request-local）
      → use rebuilt result（origin=rebuilt）
      → write-back は行わない（H-3）
```

Deletion/reset rule:

```text
Source reset/delete
  → server: revision 変化により旧 Memory は自動的に stale（主権威）
  → client: invalidatePersonalMemoryForSourceReset が該当 section 行を削除（二重防御）
```

---

# 13. Failure philosophy

## Fail-open

★ **fail-open は「Personal Memory 無しで機能を続行する」ことを意味する。**
「証明できない古い personal data を使う」ことでは **断じてない**（`D-S1`）。

Personal Memory read unavailable / sync 未証明 → continue without memory /
optional event signal unavailable → continue without it /
server base context unavailable / sync 未証明 → fall back to request-body bridge
（bridge は *その端末の canonical そのもの* なので product 出力は劣化しない）。

## Fail-closed

Layer 4 production consumption / Layer 5 shared KB / consent capture surface /
consent-dependent sharing / unknown Human decision / unsupported QA authority.

## Rollback contract（`D-S2`）

```text
Safe rollback:
  1. Personal Memory read を無効化（CAREER_PERSONAL_MEMORY_READ_ENABLED を外す）
  2. server context purpose を無効化（CAREER_SERVER_CONTEXT_PURPOSES を空に）
  3. 既存の request-body bridge / no-memory 挙動へ縮退

Unsafe rollback（禁止・経路も存在しない）:
  D-R1 の再有効化（検証なしで永続 Memory を使う）
```

障害時は **context を減らして安全に継続**する。既知の危険な旧 architecture へは戻さない。

---

# 14. Privacy invariants

1. PII stripping must be structural where possible.
2. Raw user bodies should be excluded by type, not only by code review.
3. Aggregates must not reveal contributor identity.
4. Event usage must not become ability evidence.
5. Personal company research is private by default.
6. Explicit sharing requires an affirmative sharing path.
7. Revocation / takedown must have a defined lifecycle before shared production use.
8. `activity.highlights` or other free text must never silently flow into Layer 4.
9. Layer 1 server read returns **原本**（PII を含みうる）。prompt へは必ず Layer 2 projection か
   既存 orchestrator formatter を経由させる。

---

# 15. Change discipline

Every Data Spine implementation slice must be bounded / independently reviewable / additive where
possible / behind existing gates when risk exists / minimal-diff / covered by relevant QA /
stopped at Human architectural decisions.

---

# 16. Definition of architectural success

1. Layer 1 is server-readable under owner RLS. — **達成（NEXT-2）**
2. The server computes Personal Memory freshness independently. — **達成（NEXT-3 + `D-S1`）**
   server は「読めた mirror が *その端末の* canonical と一致すること」を証明したうえで
   Memory の freshness を検証する。証明できない場合は Memory を使わない。
3. Stale/missing memory can be rebuilt from Layer 1. — **達成（NEXT-4, request-local）**
4. Source deletion invalidates dependent memory. — **達成（NEXT-3 + NEXT-5 + `D-S1`）**
   client が削除すると canonical revision が変わり mirror と不一致 → veto。
   mirror delete が失敗しても削除済みデータは AI に届かない（QA T3）。
   mirror の後始末は `resetCareerSourceData()` が担い、失敗を握りつぶさない。
5. Routes can retire client bridge context one purpose at a time. — **経路確立（NEXT-6, base context）**
6. The Orchestrator selects minimal context rather than merely formatting request-body context. — **部分達成**
7. Personal data remains isolated from collective-intelligence layers. — **維持**

Collective-intelligence success is a **separate milestone** requiring consent/legal/product gates
before Layer 4/5 production activation.

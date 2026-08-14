# PASSAI CAREER — Data Spine Decisions

**Purpose:** Human architectural decision register.
**Rule:** Claude Code must never close a `HUMAN_REQUIRED` decision by inference.

---

# 1. Decision status vocabulary

- `LOCKED` — decided; do not reopen without explicit Human instruction.
- `HUMAN_REQUIRED` — Claude may analyze options but may not decide.
- `PROVISIONAL_IMPLEMENTATION_DECISION` — Claude が既存コード・設計思想から導いた**暫定**実装判断。
  Human review で差し替え可能。永久決定ではない。reversible な形で実装する。
- `BLOCKED_BY_LEGAL` / `BLOCKED_BY_PRODUCT` / `BLOCKED_BY_INFRA` — 外部判断待ち。fail-closed を維持。
- `DEFERRED` — known decision intentionally postponed.

---

# 2. Locked architecture decisions

## D-L1 — Source Data remains original truth
**Status:** LOCKED — Layer 1 は原本。Personal Memory は projection であり競合する canonical ではない。

## D-L2 — Personal Memory is section-based and owner-scoped
**Status:** LOCKED — typed / bounded / section-independent / owner-scoped。

## D-L3 — Event Log is separate from Personal Memory
**Status:** LOCKED — Career Event / Event Signal を Personal Memory へ永続化しない。

## D-L4 — Event usage is not ability evidence
**Status:** LOCKED — 利用・非利用・評価バンド・頻度・タイミングを能力/意欲/適性/弱み/合格確率の
証拠として扱わない。特に matching で重要。

## D-L5 — Personal company research is private by default
**Status:** LOCKED — 明示 contribution path なしに shared knowledge にならない。

## D-L6 — Layer 4 / Layer 5 remain fail-closed until gates close
**Status:** LOCKED — scaffold があるだけで production consumer を配線しない。

## D-L7 — Ordinary member reads must not use service-role bypass
**Status:** LOCKED — owner-scoped RLS が通常 server read の権威。

## D-R1 — Persisted `status='fresh'` is a temporary freshness relaxation
**Status:** RETIRED（2026-08-14 / NEXT-3）

- 退役理由: server が Layer 1 を owner-scoped で読めるようになり（NEXT-2）、
  `computeContentRevision` による expected revision の再算出が可能になった。
- 現在の既定: server 再算出 revision が freshness の唯一の権威。
- ★ rollback 経路は **削除済み**（2026-08-14 / `D-S2`）。
  `CAREER_PERSONAL_MEMORY_LEGACY_D_R1` env も legacy code path も production には存在しない。
  安全な rollback は `D-S2` の手順（Memory read / server context を OFF にして context を減らす）のみ。
- 検証: `scripts/career-personal-memory-read-server-qa.ts` [8][11][12][15]。

**★ 退役したのは「D-R1 という特定の緩和」だけである。** 「canonical に対する freshness を証明できない」
という *より広い* 課題は完全には閉じていない。残存分は下記 `D-R2` として独立に管理する。

---

## D-R2 — freshness の保証範囲は「server が読める Layer 1（Supabase mirror）基準」に留まる
**Status:** ✅ CLOSED（2026-08-14 / `D-S1` source-sync veto により解消）
**元 Blocked by:** H-1（precedence）/ H-2（mirror の信頼性契約）→ 両方とも `D-S1` で closed
**Date:** 2026-08-14 に明文化 → 同日 closed

> **本セクションは歴史的記録**。閉じた経緯と、閉じる前に実在した 3 ケースを保存する。
> 現在の契約は `D-S1` を参照すること。

### 【解消前】保証していた freshness の定義

> 永続 Personal Memory の `source_revision` が、**その request 時点で server が owner-scoped で読めた
> Supabase mirror** から `computeContentRevision` で再算出した値と一致すること。

これは「localStorage canonical に対する freshness」**ではなかった**。
以下は 2026-08-14 に実コードパスで trace 済みの事実（`scripts/career-personal-memory-mirror-divergence-qa.ts` が回帰固定）:

| Case | localStorage | mirror | 永続 Memory | 実際の挙動 | prompt に載るデータ |
|---|---|---|---|---|---|
| A  | rev10 | rev9 | rev9 | `origin='persisted'` | **rev9**（canonical に対しては stale） |
| A' | rev10 | rev9 | rev10 | `origin='rebuilt'` | **rev9**（＝より新しい永続 Memory を捨てて mirror へ *ダウングレード*） |
| B  | 削除済 | 削除失敗で残存 | rev9 | `origin='persisted'` | **削除済みデータが再出現** |
| B' | 削除済 | 削除成功 | rev9 | `origin='rebuilt'`（空 projection） | なし（正しく消える） |

### どう塞いだか（2026-08-14）

`D-S1`（source-sync veto）を導入した。client が **生データではなく revision token だけ** を提示し、
server は「自分が読めた mirror から再算出した revision」と照合する。
一致しない / 未提示 / 読めない のいずれでも **Personal Memory を使わない**（＝Memory 無しで続行）。

当初検討して **却下** した案:
- 「永続 Memory の `source_updated_at` が mirror より新しければ永続側を優先」→
  `source_updated_at` は client が書き込む値であり、これを server 判定の権威にすると
  D-R1 と同種の「検証不能な client 申告の信頼」に戻る。`D-S1` は client 値を
  **veto にしか使わない**ため、この問題を回避している。

### 【解消前】残存リスクの性質

- Case A / A' は **本人自身の、やや古いデータ**が prompt に載るだけ。cross-user leak でも
  破損 prompt でもない。個別最適化の質が落ちるのみ。
- Case B は **本人が削除したデータが AI から見える**という、ユーザー期待に反する状態。
  ただし現時点で repository には Personal Memory 由来 Source（profile / activity / values /
  self_analysis / es / interview）の reset・delete 機能が **存在しない**ため、Case B は
  **product 上まだ到達不能**。将来 reset 機能を追加するときの必須要件として `D-P5` に追記した。

### 実際に採った縮小方向

上記の 2「request-scoped の client revision handshake」を、**veto 専用**という制約付きで採用した（`D-S1`）。
Case B の tombstone は **不要**になった（client が空になれば revision が変わり自動的に veto されるため）。
tombstone を作らない判断の根拠は `D-S1` の Deletion semantics を参照。

---

---

## D-S1 — Source-Sync Veto（H-1 / H-2 を閉じる正式 architecture decision）

**Decision ID:** D-S1
**Date:** 2026-08-14
**Status:** LOCKED（実装済み・activation は別 gate）
**Closes:** H-1（precedence）/ H-2（mirror 信頼性契約）/ D-R2（mirror 基準 freshness の限界）

### Human decision / Chosen architecture

**Option A — Client freshness revision / veto** を採用する。

```text
client（canonical localStorage）
  → Source kind 別 revision token を算出（生データは送らない）
  → HTTP header `x-career-source-sync`
server
  → 自分が読めた Supabase mirror から同じ純関数で revision を再算出
  → 照合
      ├─ 一致  → 申告と server 可視状態に矛盾が無いことを **検証できた**
      │           → Personal Memory / server base context を使用してよい
      └─ 不一致 / 未提示 / 読取不能
                → veto。Personal Memory を使わない（Memory 無しで続行）
                   base context は request body bridge へ fallback
```

### ★ trust claim の正確な定義（2026-08-14 hardening で訂正）

> For the first-party client flow, the server **verifies** that the client-claimed current
> source revision matches the server-visible mirror revision.
> The signal is a **negative safety gate**, not an independent source authority.

- ✅ **verified**: client 申告 revision == server 再算出 mirror revision
- ❌ **NOT proven**: その申告が本当に localStorage から生成されたこと
  （client-provided である以上 cryptographic には証明できない）

したがって本 decision では「server proved that mirror == device canonical」とは主張しない。
保証しているのは **「申告と server 可視状態が一致しない限り使わない」** という一方向の制約のみ。

### Why（他候補より優れている理由）

| 基準 | A（採用） | B write-through | C server canonical | D sync ledger |
|---|---|---|---|---|
| stale を AI に載せない | ✅ 構造的 | △ 書込成功時のみ | ✅ | ✅ |
| deletion resurrection 防止 | ✅ 自動（空も revision） | ❌ delete 失敗で残る | ✅ | ✅ tombstone 必要 |
| downgrade 防止 | ✅ | △ | ✅ | ✅ |
| multi-device | ✅ 端末視点で正しい | ❌ 勝者選定が必要 | ✅ | △ |
| offline UX | ✅ 影響なし | ❌ 保存が失敗しうる | ❌ 大 | ✅ |
| network failure | ✅ veto に倒れるだけ | ❌ product 障害化 | ❌ | △ |
| DDL / migration | ✅ **不要** | 中 | 特大 | 必要 |
| service role | ✅ 不要 | 不要 | 不要 | 不要 |
| bridge retirement との相性 | ✅ 促進する | 中立 | ✅ | 中立 |
| 実装複雑度 | 小 | 中 | 特大 | 中 |
| testability | ✅ 純関数照合 | △ | △ | △ |

- **B** は H-2 の「best-effort をやめる」判断そのもので、network / offline 時に
  product regression（保存できない）を生む。しかも書込成功後に別端末が更新すれば再び古くなるため、
  read 時点の currency を証明できない。
- **C** は正しい長期形だが big-bang 禁止・offline UX 破壊のため今回は不可。
- **D** は DDL と ack プロトコルが必要な割に、read 時点の currency 証明には結局
  「その request の client 状態」が要る（＝A を内包する）。
- **A** は DDL ゼロ・既存 UX 不変・実装が純関数照合に閉じる。
  しかも「証明できたときだけ server context を使う」ため **bridge 退役を促進** する。

### Authority model（何が canonical か）

- **product canonical: localStorage（従来どおり・変更しない）。**
- **server が prompt に使ってよいのは「canonical と一致すると証明できた mirror」だけ。**
- mirror を canonical へ昇格させない。localStorage canonical も撤回しない。
- ★ 重要な明文化: **multi-device 環境に「グローバルな canonical」は存在しない。**
  localStorage canonical は *端末ごと* の canonical である。
  したがって server が証明できるのは常に「**この request を出した端末の** canonical と一致すること」であり、
  それがこの architecture が主張する currency の正確な意味である。
  グローバル canonical が必要になった時点で Option C（server-authoritative）へ移行する。

### Trust model（client 提示値の扱い）

client の revision token は **negative guard 専用**:

- ❌ content の権威にしない（token から content を生成しない）
- ❌ DB selector にしない（この値で行を選ばない）
- ❌ user_id / 権限の根拠にしない（owner は server auth + RLS のみ）
- ✅ 「server のデータを使わない」方向へ倒すためだけに使う

**偽造した client に何ができるか / できないか:**

| | 内容 |
|---|---|
| できる | 自分自身の request で veto を回避し、**自分自身の** mirror 由来 Memory を使わせる。<br>＝「自分で自分の stale own-data 使用を許可する」だけ。veto 導入前の既定挙動と同一で、新たな露出は増えない。 |
| できない | 他人のデータ参照 / user identity の変更 / 任意 source の選択 / server 権限の拡大 /<br>RLS 迂回 / Layer 4・5 への到達。owner scoping は signal と無関係に server auth + RLS が決めるため。 |

→ 偽造の被害者は **攻撃者自身に限定** され、cross-user の脅威にならない。
（`scripts/career-source-sync-qa.ts` [7] / `career-data-spine-hardening-qa.ts` H1〜H3 が固定）

### Freshness（server がどう current を証明するか）

2 段階の証明。**両方**通った section だけが prompt に載る。

1. **sync 証明**: client 提示 revision == server が mirror から再算出した revision
2. **memory 証明**: 永続 Memory の `source_revision` == 検証済み Source からの projection revision
   （不一致なら同じ検証済み Source から request-local rebuild）

`unreadable`（read error / truncated）> `unclaimed`（未提示）> `mismatch` の優先順で veto 理由を集約する。

### Failure semantics

**fail-open == 「Personal Memory 無しで機能を続行」**。古い personal data を使うことでは断じてない。

| 状況 | 挙動 |
|---|---|
| signal 未提示（旧 client / header 剥がし） | Memory 不使用。base context は bridge |
| revision 不一致 | 同上 |
| mirror read error / truncated | 同上 |
| 永続 Memory read error だが Source は検証済み | 検証済み Source から rebuild |
| flag OFF（legacy D-R1） | 旧挙動（互換）。★ D-R2 の 3 ケースが再発するため緊急 rollback 専用 |

### Multi-device semantics

`Device A=rev10 / Device B=rev8 / mirror=rev9`:

- A からの request: 不一致 → veto（Memory 不使用）
- B からの request: 不一致 → veto（Memory 不使用）
- mirror が A に追いつく: A は使用可、B は依然 veto

→ server は「勝者」を選ばない。各 request は *その端末* の状態と mirror の一致だけを見る。
古い端末が新しい server 状態を上書きすることもない（veto は read 専用で write に触れない。
write 側の out-of-order 防止は既存 `decideWrite` の `sourceUpdatedAt` 判定のまま）。
（QA T8 / T9 が固定）

### Deletion semantics

client が削除すると canonical revision が「空の revision」に変わる → mirror（残存）と不一致 → **veto**。
mirror delete が失敗しても、削除済みデータが AI に届くことはない（QA T3）。

**tombstone を作らない判断:** veto により read 安全性が構造的に担保されるため、
tombstone / delete marker / revision epoch は read 安全性には **不要**。
ただしストレージ衛生のため `resetCareerSourceData()` が
(1) Layer 1 mirror 削除 → (2) Layer 2 Memory 行削除 を行い、
**失敗を握りつぶさず `fullyPropagated:false` として返す**（§9「silent swallow 禁止」）。

### Migration path

1. 現在: signal を送る route（company-research / interview）から順に有効化。
   送らない route は自動的に veto ＝安全側。段階移行が構造的に安全。
2. 次: 残りの purpose へ signal 送信を横展開（bridge 退役と同じ順序）。
3. 長期: Option C（server-authoritative Layer 1）へ。その時点で本 veto は不要になる。

### Rollback

**`D-S2` の safe rollback contract に従う**（legacy D-R1 への復帰経路は削除済み）。

- `CAREER_PERSONAL_MEMORY_READ_ENABLED` を外す → Personal Memory 読取を停止。
- `CAREER_SERVER_CONTEXT_PURPOSES` を空に → base context は request body bridge のみ。
- client 側は header を送らなくなるだけで安全側に倒れる（コード削除不要）。
- **DDL 変更が無いため DB rollback は存在しない。**

### Activation gate

本 decision は **architecture の完成**であって production 有効化ではない。
`CAREER_PERSONAL_MEMORY_READ_ENABLED` / `CAREER_PERSONAL_MEMORY_READ_CANARY_USER_IDS` /
`CAREER_SERVER_CONTEXT_PURPOSES` はすべて未設定のまま（H-4 の rollout 判断待ち）。

### QA / evidence

- `scripts/career-source-sync-qa.ts` — mirror 往復不変性 / 変化検知 / parse default deny / trust model
- `scripts/career-personal-memory-mirror-divergence-qa.ts` — 敵対的 trace T1〜T10
- `scripts/career-server-context-bridge-qa.ts` — base context の veto と bridge fallback
- `scripts/career-personal-memory-invalidation-qa.ts` — reset coordinator の失敗非隠蔽

---

---

## D-S2 — Rollback contract（unsafe な D-R1 復帰経路の削除）

**Decision ID:** D-S2
**Date:** 2026-08-14（hardening）
**Status:** LOCKED

### Decision

`CAREER_PERSONAL_MEMORY_LEGACY_D_R1` env と legacy read path（`resolveLegacySections`）を
**production code から削除**した。D-R1 挙動を production で再有効化する経路は存在しない。

### Why

D-R1 は「永続 `status='fresh'` を無検証で信じる」既知の stale-injection risk を持つ architecture。
「新 architecture に問題が起きたら既知の危険な architecture へ戻す」rollback は、
障害時にこそ最も危険なデータ露出を招く。rollback は常に **安全側へ縮退**しなければならない。

### Safe rollback（承認された唯一の手順）

```text
問題発生
   ↓
1. CAREER_PERSONAL_MEMORY_READ_ENABLED を外す   → Personal Memory 読取を停止
   ↓
2. CAREER_SERVER_CONTEXT_PURPOSES を空にする     → server base context を停止
   ↓
3. 既存の request-body bridge / Memory 無し挙動へ縮退（product は従来どおり動作）
```

`CAREER_PERSONAL_MEMORY_SERVER_REBUILD_DISABLED=true` も安全（rebuild を止めるだけで、
古い Memory を使う側へは倒れない＝単に Memory 無しになる）。

### Unsafe rollback（禁止）

```text
❌ D-R1 の再有効化（検証なしで永続 Memory を使う）
```

env も code path も存在しない。`career-data-spine-hardening-qa.ts` H4 が
「config builder に freshness を切る余地が無い」「production code に LEGACY_D_R1 が無い」
「docs が legacy rollback を推奨していない」ことを回帰固定する。

### 残す historical 記録

D-R1 / D-R2 の記述（本ファイル §2）は **歴史的記録として残す**。
これは production 挙動ではなく、なぜ現在の設計になったかの根拠である。

---

## D-S3 — Write integrity（multi-device mirror 巻き戻り）の正確な保証範囲

**Decision ID:** D-S3
**Date:** 2026-08-14（hardening）
**Status:** PARTIALLY ENFORCED — 残存分は既知の限界として明記する

### 実コードで trace した write 契約（推測ではなく実測）

| trace | 内容 | 現在の挙動 |
|---|---|---|
| W1 | 通常の前進 write | ✅ 通る |
| W2 | 別端末の stale write | ❌ **防げない**。単一レコード系は無条件 upsert（last-writer-wins） |
| W3 | 同一端末の同時 write | ✅ client 側で直列化（重ならない） |
| W4 | 遅延応答（古い payload が後着） | ✅ **修正済み**（直列化 + coalescing） |
| W5 | 別端末が古い localStorage で再開 | ❌ 単一レコード系は上書きされる / 履歴系は client_id merge で行集合は縮まない |

根拠: `lib/supabase/career{Profile,Activity,Values}.ts` は
`upsert(row, { onConflict: 'user_id' })` を **precondition なし** で発行する
（`.lt()` / `.match(updated_at)` / seq 比較のいずれも無い）。
履歴系は `onConflict: 'user_id,client_id'` の per-record upsert で `delete` を含まない。

### 実施した最小修正（W3 / W4）

`lib/careerSourceData/mirrorWriteQueue.ts` — 同一 (table, user) の mirror write を
**client 側で直列化**し、待機中の古い全文書 write は最新へ coalesce する。

- 解決: 「debounce autosave とアンマウント flush が同時 in-flight になり、
  遅い古い request が後着して mirror が巻き戻る」（W4）。
- **client の wall-clock を一切参照しない**（順序判定に時刻を使わない）。
  「発行順 == 適用順」を構造的に保証するだけ。
- coalescing は全文書 upsert の単一レコード系のみに適用（履歴系は行を取りこぼすため使わない）。

### 実施しなかったこと（と、その理由）

**W2 / W5（別端末の stale write）は防げていない。**

真の invariant「古い snapshot が新しい mirror snapshot を上書きしない」には
**順序情報**が必要だが、現在の Layer 1 には存在しない:

- content revision は **等価性**しか与えない（順序が出ない）。
- `CareerProfile` には `updatedAt` が **無い**。`CareerValues` / `CareerActivity` の
  `updatedAt` は client 生成であり、clock skew があるため順序の権威にしてはいけない（§7）。
- DB `updated_at` は trigger の `now()` ＝ **書込時刻**であって内容の新しさではない。

→ zero-DDL で安全に解ける形が無い。加えて conflict 発生時の解決ポリシー
（merge / remote 優先 / local 優先）は **product 判断**であり、
「端末ごとに localStorage が canonical」という現行前提のままでは一意に決まらない
（＝global multi-device consistency ＝ Option C 領域・今回 out of scope）。

**代わりに idempotent な DDL/RPC draft を用意した（未適用）:**
`supabase/prototype/career_source_write_guard_draft.sql`
— server 採番の単調 `source_seq` + `auth.uid()` 束縛 SECURITY DEFINER RPC による compare-and-set。
RLS 維持・service role 不使用・migration ordering / rollback 手順を併記。適用は Human decision 後。

### 3 つの性質を混同しないこと

| 性質 | 現状 |
|---|---|
| **Read safety**（古い personal context を AI に渡さない） | ✅ **保証**（`D-S1` veto。H6/H7/H8 が固定） |
| **Mirror integrity**（mirror が巻き戻らない） | ⚠️ **部分的**（W3/W4 は防止、W2/W5 は未防止） |
| **Global multi-device consistency**（全端末が同一 canonical を見る） | ❌ **未保証**（Option C が必要） |

mirror が巻き戻っても、要求端末の claim と一致しなくなるため
`D-S1` veto が働き **prompt が汚染されることはない**（H6 が実証）。
ただしこれは read safety であって mirror integrity ではない。**同一視して記述しないこと。**

### QA / evidence

- `scripts/career-mirror-write-ordering-qa.ts` — W1〜W5 の実挙動を pin（防げていないものも pin）
- `scripts/career-data-spine-hardening-qa.ts` — H6 / H7 / H8

---

---

## D-S4 — Canary activation gate（user-scoped Server Context）

**Decision ID:** D-S4
**Date:** 2026-08-14（canary activation foundation）
**Status:** LOCKED（実装済み・**未 activation**）

### 問題

`CAREER_SERVER_CONTEXT_PURPOSES=interview_practice` だけでは、その purpose を使う
**全ユーザー**が新経路に乗る。これは canary ではない（Personal Memory 側には既に
user allowlist があるのに、Server Context 側だけ purpose gate しか無かった）。

### Decision

Server Context にも **user allowlist を必須**にする。gate は 3 条件の AND。

```text
purpose opt-in（CAREER_SERVER_CONTEXT_PURPOSES）
  AND
requesting user ∈ canary allowlist（CAREER_SERVER_CONTEXT_CANARY_USER_IDS）
  AND
Source-Sync verified（D-S1）
        ↓
   server-derived context を使用
```

いずれか欠けたら **既存 request-body bridge**（Server Context）または
**Memory 無し**（Personal Memory）へ fallback する。
`Source-Sync unverified → 古い mirror を使う` は起きない。

### 実装上の要点

- allowlist の parse は既存 `parseCanaryUserIds` を **再利用**（不正 1 件で全体 deny /
  cap / exact match / default deny の意味論を 2 箇所で実装しない）。
- **default deny**: 未設定・空・不正はすべて「誰も許可しない」。
  空 allowlist を「全員許可」と解釈しない。
- user gate は Layer 1 reader の `authorize` hook で評価する。
  → canary 対象外 user では **table read が 1 回も発生しない**（auth のみ）。
- userId は **server auth 由来のみ**。reader は `authorize(userId)` にしか値を渡さず、
  request body を参照しない（QA C8 が静的にも動的にも固定）。
- `NODE_ENV` による自動 ON / default true をコードに置かない（activation は operator 制御）。

### Observability（H-4 evidence path）

`lib/careerDataSpineCanary/` に enum のみの観測語彙と process-local counters を置く。

- Source-Sync: `verified` / `unclaimed` / `mismatch` / `unreadable` / `invalid`
- Personal Memory: `persisted` / `rebuilt` / `stale` / `invalid` / `omitted`
- Server Context: `server_context_used` / `bridge_fallback` / `sync_unverified` /
  `purpose_disabled` / `user_not_canary`

正規化は「失敗理由を成功で覆い隠さない」順序（一部 section が成功していても
mismatch があれば `stale` を表面化）。

**記録するのは enum と件数のみ。** userId / 本文 / prompt / AI response / email / name を
構造的に保持しない（型 + QA O4/O5 で担保）。
operator inspection は `GET /api/career/data-spine-canary`（env + member + canary allowlist の三重 gate）。

★ counters は **process-local の近似値**（再起動でリセット・serverless では instance 別）。
傾向値であり監査値ではない旨を snapshot 自身に含めている。

### Rollback

`D-S2` の safe rollback contract に従う。env を消して再起動するだけ。
code rollback も DB rollback も不要（本 canary は DDL を伴わない）。
D-R1 への復帰経路は存在しない。

### Activation gate

本 decision は **activation ではない**。全 flag は未設定のまま。
実施手順は `docs/career/data_spine/CANARY_RUNBOOK.md`。
必要な Human 入力は canary user の UUID 1 件のみ。

### H-4 との関係

本 canary は H-4（rollout 基準）を **閉じない**。
H-4 を判断するための **evidence path** を用意しただけである。
拡大判断は observed `syncVerified` / `syncMismatch` / `contextUsed` / `bridgeFallback` /
`error` を見てから Human が行う。

### QA / evidence

- `scripts/career-canary-activation-qa.ts` — C1〜C13
- `scripts/career-canary-observability-qa.ts` — O1〜O5 / P1〜P2（shadow parity 含む）

---

---

## D-S5 — Server Context Expansion Batch 1 + 重複注入の禁止

**Decision ID:** D-S5
**Date:** 2026-08-14（Batch 1）
**Status:** LOCKED（実装済み・**未 activation 拡大**。canary 1 user / purpose 単位 opt-in のまま）

### Decision

`consultation` と `company_research_review` の **base context（profile / activity / values）** を
`D-S4` の canary gate（purpose opt-in AND canary user AND Source-Sync verified）配下で
server-driven 化した。共有 resolver `lib/careerServerContext/resolveBaseInputs.server.ts` に集約し、
purpose を増やすたびに分岐を書き直さない形にした。

### ★ 重複注入の禁止（本 Batch の最重要成果）

canary ON 時の `company_research_review` に **実在した欠陥** を修正した:

| 重複 | 内容 |
|---|---|
| base | `orchestrated.systemPrompt`（body の profile/activity/values）＋ Personal Memory `base` projection |
| self_analysis | `renderSelfAnalysis(b.selfAnalysis)` ＋ Personal Memory `self_analysis` |

同じ情報が 2 回 prompt に入り、AI に「別々の根拠」と誤認させる状態だった。

**採用ポリシー: bridge wins / memory fills gaps**
（`lib/careerMemory/personalMemoryDedupe.ts`）

> その section に相当する bridge context が **実際に描画されるなら**、対応する Personal Memory
> section を落とす。bridge が無いところだけ memory で埋める。

この向きを選ぶ理由:
- prompt は「増える」方向にしか変わらない（bridge があるケースは従来と完全に同じ）＝既存 parity を壊さない。
- bridge 退役が進むほど自動的に memory へ主権が移る（migration が単調に進む）。
- 逆向き（memory 優先で bridge を落とす）は memory が compact projection のため情報が減りうる。
  canary 段階で品質を落とす方向は取らない。

判定は「body に field がある」ではなく **「その block を実際に描画するか」** で行う
（空文字で描画されない block は presence=false）。

### purpose 別の bridge retirement status

| purpose | status | server 化した context | bridge に残る context |
|---|---|---|---|
| `interview_practice` | **HYBRID** | base（profile/activity/values） | selfAnalysis / es / matching / consultationInsights / companyResearch |
| `consultation` | **HYBRID** | base（profile/activity/values） | crossFeature 全部（selfAnalysis/es/interview/presentation/gd/gdRoom/matching/companyResearch + 各 History）、Event Signal |
| `company_research_review` | **HYBRID** | base + Personal Memory（`base`/`self_analysis`、dedupe 済み） | selfAnalysis block / matching block |

**FULL_SERVER の purpose はまだ無い。** big-bang より安全な HYBRID を選んでいる。

### consultation に Personal Memory を **敢えて注入していない** 理由

`personalMemorySectionsForPurpose('consultation')` は base/self_analysis/es/interview を許可するが、
consultation の crossFeature bridge が既に同じ情報（自己分析 / ES / 面接）を送っている。
両方入れると本 decision が禁止する重複注入になる。

→ **crossFeature bridge を退役させてから** Personal Memory を通電する（Batch 2 以降）。
   それには Layer 1 reader に `matching` / `company_research` / `presentation` / `gd` kind が必要。

### Event Signal 境界（不変）

Event Signal は consultation route が従来どおり独立に resolve し、
Personal Memory / server context 経路には一切入らない（`D-L3`）。
matching への ability 推論辺も増えていない（`D-L4`）。QA Q7 / Q8 が固定。

### section isolation（部分検証）

Source-Sync は **source kind 単位**。`profile` mismatch / `self_analysis` verified のとき、
`base` section だけを veto し `self_analysis` は使う。
「一部 mismatch だから全部 verified 扱い」も「全部捨てる」もしない（QA R4）。

### QA / evidence

- `scripts/career-server-context-batch1-qa.ts` — Q1〜Q8 / R1〜R6 / D1〜D3 / 静的境界
- `scripts/career-consultation-orchestrator-parity-qa.ts` — 既存 byte parity（ALL_EXACT_MATCH 維持）

### 既知の未実施（隠さない）

> **Actual signed-in browser E2E remains outstanding.**
> Human 指示により実ブラウザ session での E2E は延期。検証は real env-derived config /
> fixture auth simulation / route-level logic / parity / adversarial QA の範囲。

---

# 3. Provisional implementation decisions（2026-08-14 / Human review 可能）

> これらは Human の最終決定ではない。既存コードと設計思想から導いた暫定解であり、
> すべて **env flag で即座に元へ戻せる** 形で実装している。

## D-P1 — server prompt から見た Layer 1 の権威（H-1 の暫定解）
**Status:** SUPERSEDED by `D-S1`（2026-08-14）— 歴史的記録として保存
**Relates to:** H-1（localStorage と server mirror の乖離時の precedence）

**採用した方針:**
「product の canonical は引き続き localStorage。ただし **server が prompt を組むときは、
server が実際に読めた mirror だけを権威とする**。」

**根拠:**
- server は localStorage を観測できない。観測できないものを「新しい」と仮定すると、
  検証不能な freshness 主張になる（それがまさに D-R1 の問題だった）。
- mirror が古い場合でも rebuild-on-stale（NEXT-4）により「mirror から作り直した Memory」が使われる。
  最悪ケースは「わずかに古い Memory」であり、「他人のデータ」や「壊れた prompt」にはならない。
- Source が権威的に読めない（`error` / `truncated`）ときは Memory を使わず従来 prompt へ fail-open するため、
  誤った断定は起きない。

**他の選択肢（不採用）:**
- mirror を必須の source of truth に昇格 → mirror 書き込み失敗が product 障害になる（H-2 の判断が必要）。
- request 単位の client revision handshake → request body 依存を増やし bridge 退役に逆行する。
- server memory を常に近似扱い → 実質 Memory を使えず、Layer 2 の価値が出ない。

**Reversibility:**（本 decision は `D-S1` に SUPERSEDED。rollback 手順は `D-S2` が正）
purpose 別 server context は `CAREER_SERVER_CONTEXT_PURPOSES` を空にすれば即無効。
★ 旧記述にあった `LEGACY_D_R1` による rollback は `D-S2` で **削除** された。

---

## D-P2 — mirror は best-effort のまま（H-2 の暫定解）
**Status:** SUPERSEDED by `D-S1`（2026-08-14）— 結論は維持され、`D-S1` に統合された
**Relates to:** H-2

**採用した方針:** mirror の信頼性契約は変更しない。代わりに
「**server は証明できない freshness を主張しない**」という側で安全性を担保する。

**実装:**
- Source read status（`ok` / `truncated` / `error` / `skipped`）を導入。
- `ok` のみ revision の権威（`isSourceRevisionAuthoritative`）。
- `truncated`（履歴 200 件上限到達）や `error` では section を prompt に載せない。

**Reversibility:** 完全に読み取り側の判定なので、mirror 側の契約を後から強化しても矛盾しない。

---

## D-P3 — server rebuild は request-local のみ（H-3 の暫定解）
**Status:** PROVISIONAL_IMPLEMENTATION_DECISION
**Relates to:** H-3（server rebuild の write-back 可否）

**採用した方針:** rebuild した section は **その request の prompt でのみ使い、DB へは書き戻さない**。

**根拠:**
- write-back は client coordinator に並ぶ **second writer** を生む。
  blueprint が明示的に risk として挙げている（H-3）。
- 書き戻さなくても機能価値は得られる（prompt には rebuilt section が載る）。
- 後から write-back を足すことは容易だが、外すのは難しい（非対称なので保守的側を選ぶ）。

**他の選択肢（不採用）:** gated upsert（H-3 の Human decision 前に second writer を作ることになる）。

**Reversibility:** rebuild 自体は `CAREER_PERSONAL_MEMORY_SERVER_REBUILD_DISABLED=true` で無効化可能。

---

## D-P4 — bridge 退役は purpose 単位 opt-in / base context から（NEXT-6）
**Status:** PROVISIONAL_IMPLEMENTATION_DECISION

**採用した方針:**
- `CAREER_SERVER_CONTEXT_PURPOSES`（comma 区切り・**既定は空 = OFF**）で purpose 単位に opt-in。
- 第一 purpose は `interview_practice`、第一対象は base context（profile / activity / values）のみ。
- Source が読めない / 空のときは request body へ fallback（member から context を奪わない）。
- 経路差で prompt が変わらないことを byte parity QA で固定。

**未対応（次 slice）:** `selfAnalysis` / `es` / `matching` / `consultationInsights` / `companyResearch`
の bridge。これらは Layer 1 の追加 kind（matching / company_research / consultation）が必要。

---

## D-P5 — Personal Memory 無効化は「削除」で行う（NEXT-5）
**Status:** PROVISIONAL_IMPLEMENTATION_DECISION

**採用した方針:** Source reset/delete 時は該当 section 行を `status='stale'` へ更新するのではなく
**削除**する。

**根拠:** 行が消えれば read は missing → Layer 1 から rebuild される。status 更新は payload を残すため
legacy 経路や将来の別 consumer から古い内容が見える余地が残る。削除は冪等で、
server 側 revision 判定が safety net として二重に働く。

**現状の wiring:** repository には source reset を伴う UI が **まだ存在しない**（company-research /
consultation / GD の削除は Personal Memory の由来 Source ではない）。

**★ NEXT-5 が保証する正確な範囲（2026-08-14 audit で明確化）:**

> 「Source の削除で古い Memory が使えなくなる」のは **server が読める mirror から実際に消えたとき** だけ。

localStorage だけ消えて mirror の delete が失敗した場合、server は残存 mirror から
削除前の revision を再算出し、古い Memory を `origin='persisted'` として prompt に載せる（D-R2 Case B）。

**将来 reset 機能を実装するときの必須要件:**

1. localStorage を消すのと同じ操作で **Layer 1 mirror 行の削除も試みる**。
2. `invalidatePersonalMemoryForSourceReset` を呼んで Layer 2 の行を消す。
3. mirror delete が **失敗したまま成功扱いにしない**（失敗を握りつぶすと Case B に落ちる）。
   最低限、失敗を記録し再試行するか、成功するまで Memory 読取を抑止する仕組みを設ける。

この 3 点が揃うまで、「削除が AI から見て確実に反映される」とは宣言してはいけない。

---

## D-P6 — consent capture surface は三重 gate の fail-closed（NEXT-7）
**Status:** PROVISIONAL_IMPLEMENTATION_DECISION

**採用した方針:** capture surface（`/api/career/consent` + mypage カード）は
1. `CAREER_CONSENT_CAPTURE_ENABLED`（運用）
2. `CAREER_CONSENT_POLICY_LEGAL_APPROVED`（法務が文言承認）
3. `CAREER_DATA_SPINE_READY_*`（Layer 別 decision register）

の **3 つがすべて揃うまで開かない**。さらに production 永続 repository は未接続（`repository: null`）で、
gate が開いても現状は `unavailable` を返し 1 件も書かない。

**根拠:** 同意文言・retention・minors・commercial scope は法務判断（H-7）であり、コードで確定できない。
一方でコード側は完成させておかないと、法務決着後に再設計が必要になる。

**Reversibility:** env を外せば即座に閉じる。UI カードは gate 閉時に `null` を返すため現行 UI は不変。

---

# 4. Human decisions still required

## H-1 — Precedence when localStorage and server-read mirror diverge
**Status:** ✅ CLOSED（2026-08-14 / `D-S1`）
結論: localStorage が product canonical のまま。server は
「canonical と一致すると **証明できた** mirror」だけを prompt に使う。
証明できない場合は precedence を争わず **使わない**（Memory 無し / bridge fallback）。

## H-2 — Best-effort mirror vs guaranteed server-readable source
**Status:** ✅ CLOSED（2026-08-14 / `D-S1`）
結論: mirror は **best-effort のまま**でよい。信頼性を上げる代わりに
「同期が証明できないときは使わない」で安全性を担保するため、
mirror 書込失敗が product 障害にならない（offline / network failure 耐性を維持）。

## H-3 — Server rebuild write-back policy
**Status:** HUMAN_REQUIRED（暫定解 `D-P3` = write-back しない）

## H-4 — Personal Memory rollout criteria
**Status:** HUMAN_REQUIRED（`D-S4` で **evidence path** が用意された。基準自体は未決）
どの stale/error/parity 閾値で canary を超えて rollout してよいか。
観測材料として `PersonalMemoryReadMetaSafe.origins`（persisted / rebuilt / legacy）と
`sourceRead` が使えるようになった。

## H-5 — Purpose registry unification
**Status:** HUMAN_REQUIRED / DEFERRED
`CareerMemoryPurpose` と `CareerContextPurpose` は今回も統合していない（無関係 slice で統合しない方針を維持）。

## H-6 — Supabase placement / identity strategy
**Status:** BLOCKED_BY_INFRA（Layer 4 / Layer 5 / consent 永続化）

必要なのは **placement / identity の決定と DDL の production 適用** であって、
service-role credential ではない（下記 `D-A1` で訂正済み）。

---

## D-A1 — consent の member 操作に service-role は不要（2026-08-14 audit の訂正）
**Status:** PROVISIONAL_IMPLEMENTATION_DECISION（設計方針の訂正・実装は未着手）

2026-08-14 の最終報告で「consent repository には service-role RPC credential が必要」と記載したが、
これは **prototype DDL の実装選択を architecture 上の必然と誤読したもの**。正確な分析は以下。

### operation 別の authority model

| operation | 必要権限 | service role |
|---|---|---|
| 本人の consent event 読取 | RLS `career_consent_events owner select`（`auth.uid() = subject_user_id`） | **不要** |
| active policy manifest 読取 | RLS `career_consent_policies active read`（authenticated） | **不要** |
| consent の grant / withdraw（append） | INSERT policy を張らない設計のため RPC 経由 | **設計次第。下記参照** |
| withdrawal outbox の処理 | authenticated policy なし（batch 専用） | 別問題（member 操作ではない・Layer 4/5 activation 側の課題） |

### なぜ prototype は service_role を要求しているか

`supabase/prototype/consent_local_prototype.sql` の
`career_consent_append_prototype(p_subject uuid, ...)` は **subject を引数で受け取り、
関数内で `auth.uid()` と照合していない**。この signature のまま `authenticated` へ EXECUTE を付与すると、
任意の認証ユーザーが **他人の subject_user_id で consent event を捏造できる**。
そのため prototype は `REVOKE ALL ... FROM PUBLIC` とし、service_role gateway だけが実行する形にしている。

つまり service_role は **RPC の引数設計に起因する回避策**であり、architecture 上の要件ではない。

### production で採るべき形（D-L7 と矛盾しない案）

```sql
-- subject を引数で受け取らず auth.uid() から導出する（または auth.uid() と厳密照合して reject）。
CREATE FUNCTION career_consent_append(...)  -- p_subject を廃止
RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DECLARE v_subject uuid := auth.uid(); BEGIN
  IF v_subject IS NULL THEN RETURN jsonb_build_object('status','rejected','reason','unauthenticated'); END IF;
  -- 以降は prototype と同じ（冪等 / advisory lock 採番 / policy 照合 / outbox）
END $$;
REVOKE ALL ON FUNCTION career_consent_append(...) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION career_consent_append(...) TO authenticated;
```

- `SECURITY DEFINER` は依然必要。ただしそれは「直接 INSERT を許さず append-only と
  server 採番 sequence を強制する」ための **1 operation に閉じた昇格**であり、
  service-role key のような **汎用 bypass credential ではない**。D-L7 の精神と矛盾しない。
- user-controlled input から到達できるのはこの 1 関数のみで、subject は関数内で `auth.uid()` に固定される。
  scope / action / version は関数内で active policy manifest と照合され、不一致は `policy_invalid` で拒否。
- 読取は既存 RLS のみで成立するため、member 向け経路に service-role は一切登場しない。

### 結論

- **consent の member 向け read / write に service-role credential は不要。**
- 真の blocker は H-6（placement / identity）+ H-7（法務文言と policy manifest 行）+ DDL の production 適用、
  および「production 用 RPC を `auth.uid()` 束縛版で書き直すこと」。
- prototype の `p_subject` 版 signature を **production へそのまま持ち込んではいけない**。

## H-7 — Cohort, retention, consent text, revoke SLA, minors, commercial scope, confidentiality
**Status:** BLOCKED_BY_LEGAL（Layer 4 / Layer 5 production activation + consent 文言）

## H-8 — Moderation ownership / official-source verification
**Status:** BLOCKED_BY_PRODUCT（Layer 5）

---

# 5. Decisions already resolved — do not reopen casually

Personal Memory schema structure / writer ownership / owner-scoped storage / RLS /
Source Data as original source / section independence / failure fallback semantics /
Event Log append-only semantics / PII boundaries / personal vs shared company-research separation.

---

# 6. Claude decision protocol

## Claude MAY decide

implementation-local / reversible / データ権威を変えない / privacy 分類を変えない /
production access を広げない / consent semantics を変えない / QA・security 境界を弱めない /
承認済み slice の内側に収まる。

## Claude MUST escalate

authoritative source が変わる / AI に届くユーザーデータが変わる / second writer を導入する /
Layer 4/5 の production 利用を有効化する / retention・consent・sharing を変える / RLS 権威を変える /
human-vs-model の承認意味論を変える / `HUMAN_REQUIRED` を解決する / 破壊的 migration が要る /
既存 guard を弱めないと進めない。

> 2026-08-14 の handoff では Human が「HUMAN_REQUIRED を暫定解で前進させてよい」と明示指示したため、
> `D-P1`〜`D-P6` を `PROVISIONAL_IMPLEMENTATION_DECISION` として記録した。
> 通常の slice ではこの例外は適用されない。

---

# 7. Decision record template

```text
Decision ID:
Date:
Status: LOCKED
Human decision:
Chosen option:
Rejected options:
Reason:
Affected slices:
Migration required:
Rollback plan:
QA / evidence required:
```

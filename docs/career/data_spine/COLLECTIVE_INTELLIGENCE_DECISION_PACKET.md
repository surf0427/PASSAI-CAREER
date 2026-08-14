# PASSAI CAREER — Collective Intelligence Decision Packet

> ⚠ **この文書は Closure Batch 時点の版です。**
> Decision Resolution Batch（`D-R1`〜`D-R3`）で H-L8 の technical 部分が解決したため、
> **最新の決裁票は `COLLECTIVE_INTELLIGENCE_RECOMMENDED_DECISIONS.md`** を参照してください。
> そちらには各 decision の **Claude 推奨案**が付いており、YES / NO で処理できます。
>
> 本文書は「何が論点か」の詳細な背景として保持します（推奨案は含みません）。

**目的:** Layer 4 / Layer 5 を有効化する前に **Human が答える必要がある項目だけ**を、
選択肢付きで一覧にする。議論の材料ではなく **決裁票**。

**前提:**

- コード・privacy guard・consent gate・moderation gate・RLS 構造・QA は **完成済み**
  （`ACTIVATION_READY`。`DATA_SPINE_STATE.md` §5.3 参照）
- production consumer は **0**（意図的）
- 全 flag OFF（既定）。決定前でも codebase は安全に閉じている
- **決定するまでの code default は、すべて `FAIL CLOSED`**

> `ACTIVATION_READY ≠ LEGALLY_APPROVED ≠ PRODUCTION_ENABLED`

---

# H-L1 — Minimum cohort threshold（本番値）

**何を決めるか:** 集計結果を返してよい最小 unique-user 数。

現在コードにある値（すべて `PROVISIONAL`・実データ分布未確認・法務未確認）:

| 用途 | 現在値 |
|---|---:|
| absolute lower bound（これ未満は常に suppress） | 10 |
| internal analytics | 20 |
| user-facing | 50 |
| AI context | 100 |

| Option | absolute / internal / user-facing / AI |
|---|---|
| **A（緩い）** | 5 / 10 / 20 / 50 |
| **B（現在の PROVISIONAL 値を追認）** | 10 / 20 / 50 / 100 |
| **C（厳しい）** | 20 / 50 / 100 / 200 |

**判断材料:** AI context は「言い換えによる漏洩」余地があるため最保守にしてある。
user-facing は「自分が数えられている」感覚を避けるため internal より高い。

```text
Code default until decision: FAIL CLOSED
  （閾値は PROVISIONAL のまま。activation gate が cohort_threshold_configured=false で
    Layer 4 を activated=false にする）
```

---

# H-L2 — Aggregate retention 期間

**何を決めるか:** 生成済み aggregate artifact を何日保持するか + その policy version。

| Option | retention |
|---|---|
| **A** | 90 日 |
| **B** | 180 日 |
| **C** | 365 日 |
| **D** | metric ごとに別（要 metric 別表） |

**制約（コード側で既に強制）:**
- 無期限は **表現できない**（`Infinity` / 0 / 負 / 10 年超は invalid）
- policy version が無い設定は無効
- 未設定なら **serve しない**（削除はしない — 未決状態での自動削除を避けるため）

```text
Code default until decision: FAIL CLOSED（NOT_CONFIGURED → serve しない）
```

---

# H-L3 — Aggregation の利用目的

**何を決めるか:** どの audience まで実際に使うか。

| Option | 有効化する audience |
|---|---|
| **A** | internal analytics のみ |
| **B** | internal + user-facing |
| **C** | internal + user-facing + AI context |

**注意:** audience ごとに **別の consent scope** が必要（`AUDIENCE_REQUIRED_SCOPE`）。
B を選ぶなら `user_facing_aggregated_insight` の同意取得 UI が要る。
C は AI prompt へ載るため最保守の閾値（H-L1）と disclaimer 文言（H-L7）が前提。

```text
Code default until decision: FAIL CLOSED（consumer capability は全て not_connected）
```

---

# H-L4 — Company contribution sharing policy

**何を決めるか:** 企業知見の共有を、どの範囲・どの条件で認めるか。

| 論点 | Option |
|---|---|
| 共有範囲 | A: 全 member へ / B: 同一卒年のみ / C: 社内利用のみ |
| 商用利用 | A: 許可 / B: 禁止 / C: 別途同意 |
| `VERIFIED_PUBLIC_SOURCE` | A: 今回は実装しない / B: 実装する（要 official source 検証方針） |
| 秘密情報の定義 | A: 選考内容は可・NDA 明示分は不可 / B: より厳格 / C: 法務が定義 |

**現在のコード既定:** `permittedUses = ['aggregated_display', 'ai_context_reference']`、
`prohibitedUses = ['commercial_resale', 'contributor_identification']`。
商用利用は **permitted に含めていない**（default deny）。

```text
Code default until decision: FAIL CLOSED（commercial は permitted に含めない）
```

---

# H-L5 — 撤回後の既 publish knowledge の扱い

**何を決めるか:** contributor が同意を撤回した / アカウントを削除したとき、
**既に published になった** shared knowledge をどうするか。

| Option | 挙動 |
|---|---|
| **A** | 即時に unpublish（削除） |
| **B** | 匿名のまま残す（寄与は contributor に紐づかないため） |
| **C** | 新規参照を止め、既存 projection は次回再生成で落とす |
| **D** | 法務が個別判断（takedown request 経由） |

**構造的に保証済み（Option に関わらず）:**

```text
revoked → future contributions blocked   ✅ コードで保証
```

**構造的に不可能なこと（隠さない）:**

```text
生成済み aggregate artifact から特定個人の寄与だけを差し引くこと
→ user-level 逆引きを保持しない設計のため不可能。
  対応は window 単位の invalidate + regeneration のみ。
```

```text
Code default until decision: FAIL CLOSED
  （伝播表は human_policy_required。自動削除も自動継続も **しない**）
```

---

# H-L6 — Moderation operational ownership

**何を決めるか:** 誰が moderation を実行するか。

| Option | 体制 |
|---|---|
| **A** | 運営者が全件手動レビュー |
| **B** | 自動 PII/禁止語スクリーニング + 人手は例外のみ |
| **C** | 外部モデレーション事業者 |
| **D** | 決まるまで Layer 5 を有効化しない |

**付随して決めるもの:** SLA（何時間以内に審査するか）/ takedown 受付窓口 /
異議申立プロセス / legal hold の発動権限。

```text
Code default until decision: FAIL CLOSED
  （moderation_ready=false → Layer 5 は activated=false。
    moderation module が存在するだけでは ready と見なさない）
```

---

# H-L7 — Legal / privacy approval

**何を決めるか:** 法務・プライバシー観点の承認。

コードが **結論を出していない**論点（`LEGAL_REVIEW_TOPICS` として列挙済み）:

- 匿名化 / 仮名化のどちらに該当するか
- 明示 opt-in が必要な scope の範囲
- 撤回前に作られた aggregate の扱い
- アカウント削除後の再計算義務
- consent 証跡自体の retention（同意記録は消してよいか）
- 未成年ユーザーの扱い
- 同意文言 / disclaimer 文言の確定
- backup からの削除

```text
Code default until decision: FAIL CLOSED（legalApproved=false → 全 layer activated=false）
```

---

# H-L8 — Production infrastructure activation

**何を決めるか:** インフラ。

| 項目 | 決めること |
|---|---|
| target project | 既存 CAREER Supabase か / 別 project か |
| **identity strategy** | ★ Layer 5 の contributor を opaque key のままにするか、`contributor_user_id uuid` を持たせるか。**opaque key のままでは owner-scoped RLS を張れない** |
| table placement | 同一 schema か / 別 schema か |
| RLS policy 適用 | `supabase/prototype/collective_intelligence_activation_draft.sql` の適用可否 |
| ETL / batch | production batch（cron）の実行基盤 |
| moderation backend | 審査 UI / queue |
| retention sweep | service-role batch（member path から分離） |

**~~real-mode activation の前に必須~~ → 解決済み（`D-R1`）:**

```text
member path  → server/memberGateProbe.server（privileged 非 import / DB read ゼロ）
batch path   → batch/*.batch.ts（route から到達不能）
```

QA `HDR-1` / `HDR-2` が推移的 import graph で到達性ゼロを固定した。**Human 判断は不要。**

**~~identity strategy~~ → 解決済み（`D-R2`）:** I2（subject 対応表）を採用。
**~~ETL 基盤~~ → 解決済み（`D-R3`）:** provider-neutral runner を実装。

```text
Code default until decision: FAIL CLOSED（infrastructureReady=false）
```

---

# 決定サマリ表

| ID | 決めること | Code default until decision |
|---|---|---|
| H-L1 | minimum cohort threshold | FAIL CLOSED（PROVISIONAL のまま） |
| H-L2 | retention 期間 | FAIL CLOSED（NOT_CONFIGURED → serve しない） |
| H-L3 | aggregation 利用目的 | FAIL CLOSED（consumer 全て not_connected） |
| H-L4 | sharing policy | FAIL CLOSED（商用は permitted に含めない） |
| H-L5 | 撤回後の既 publish 扱い | FAIL CLOSED（自動削除も自動継続もしない） |
| H-L6 | moderation ownership | FAIL CLOSED（moderation_ready=false） |
| H-L7 | legal / privacy approval | FAIL CLOSED（legalApproved=false） |
| H-L8 | production infrastructure | FAIL CLOSED（infrastructureReady=false） |

**8 件すべてが決まるまで、Layer 4 / Layer 5 は有効化されない。**
決定前でも codebase は完成しており、安全に閉じている。

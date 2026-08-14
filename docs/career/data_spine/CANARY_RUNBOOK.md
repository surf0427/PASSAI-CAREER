# PASSAI CAREER — Data Spine Canary Runbook

**対象:** Human 本人 1 ユーザーだけで Personal Memory と Server Context
（`interview_practice` / `consultation` / `company_research_review`）を安全に試験運用する手順。
Batch 2（`D-S6`）以降は base だけでなく **cross-feature context も同じ gate 配下**で server 化される。

> ★ **Actual signed-in browser E2E remains outstanding.** 実ブラウザ session での
> click-through と実 AI call は未実施（Human 指示により延期）。

**前提 SHA:** `90608a6` 以降（本 runbook を含む canary commit）
**Status:** 実装完了・**未 activation**（全 flag OFF）

> ⚠️ 本 runbook は **production 全体展開の手順ではない**。
> 1 ユーザー・限定 purpose の evidence 収集（H-4 判断材料）が目的。

---

# 0. Canary gate の全体像

server-derived context が使われるのは、**3 条件すべて**が揃ったときだけ。

```text
purpose が opt-in 済み
  AND
requesting user が canary allowlist に居る（server auth 由来の UUID で exact match）
  AND
Source-Sync が verified（client 申告 revision == server 再算出 mirror revision）
        ↓
   server-derived context を使用
```

1 つでも欠ければ:

| 対象 | fallback |
|---|---|
| Server Context | 既存 request-body bridge（＝その端末の canonical。出力は従来どおり） |
| Personal Memory | Memory 無しで続行（**古い Memory は使わない**） |

---

# 1. Before activation

## 1.1 必須 QA（すべて green であること）

```bash
npm run qa:careerPersonalMemoryAll
npm run qa:careerSourceSync
npm run qa:careerMirrorWriteOrdering
npm run qa:careerDataSpineHardening
npm run qa:careerCanaryActivation
npm run qa:careerCanaryObservability
npm run qa:careerServerContextBatch1
npm run qa:careerServerContextBatch2
npm run qa:careerServerContextBridge
npm run qa:careerDataSpinePersonalOptimizationClosure
npm run qa:careerMemoryAll
npm run qa:careerEvents
npm run qa:careerEventSignalSeries
npm run qa:careerMatching
npm run qa:careerDataSpineProductionScaffold
npx tsc --noEmit
```

## 1.2 必須 gate 状態（activation 前は全 OFF）

```bash
# すべて未設定であることを確認（出力が空ならよい）
grep -E "CAREER_PERSONAL_MEMORY_READ_ENABLED|CAREER_SERVER_CONTEXT_" .env.local
```

## 1.3 必要な Human 入力

**canary user の UUID（Supabase `auth.users.id`）が 1 つだけ必要。**

取得方法（安全な手段のみ・secret を出力しない）:

- ログイン済みブラウザの DevTools Console で
  `(await window.__careerSupabase?.auth?.getUser())?.data?.user?.id` 相当、または
- Supabase Dashboard → Authentication → Users → 自分の行の `UID` をコピー

> ❌ 推測 / email からの生成 / service role での探索は禁止。

## 1.4 Source-Sync の前提

canary user の端末で、**mirror が localStorage と同期していること**。
同期していないと（＝mismatch）意図どおり veto され、
`bridge_fallback` / `omitted` ばかりになる。これは**バグではなく設計どおり**。

同期させるには: 該当機能（プロフィール / 活動整理 / 就活軸）を一度開いて保存する。

---

# 2. Stage 1 — Personal Memory Canary のみ

Server Context はまだ OFF のまま。

```bash
# .env.local
CAREER_PERSONAL_MEMORY_READ_ENABLED=true
CAREER_PERSONAL_MEMORY_READ_CANARY_USER_IDS=<CANARY_USER_ID>
```

再起動（`npm run dev` / 再デプロイ）後、`/career/company-research` で添削を実行する
（現在 Personal Memory を読む purpose は `company_research_review`）。

## 確認すること

| 観測 | 期待 |
|---|---|
| `sync` | `verified`（同期済み端末なら） |
| `memory` | `persisted` または `rebuilt` |
| `omitted` | 同期していない端末では正常に発生する |
| エラー | AI 機能が壊れないこと（fail-open） |

---

# 3. Stage 2 — `interview_practice` Server Context Canary

Stage 1 を維持したまま追加する。

```bash
# .env.local（追加）
CAREER_SERVER_CONTEXT_PURPOSES=interview_practice
CAREER_SERVER_CONTEXT_CANARY_USER_IDS=<CANARY_USER_ID>
```

再起動後、`/career/interview` で面接を開始する。

## 確認すること

| 観測 | 期待 |
|---|---|
| `context` | `server_context_used`（同期済み canary user） |
| `bridge_fallback` | 未同期・読取失敗時に発生（安全側） |
| `user_not_canary` | 別ユーザーからのリクエストで発生すること |
| prompt | 面接の質問品質が従来と変わらないこと（parity QA で byte 一致を固定済み） |

---

# 3b. Stage 2b — Batch 1 purpose を追加する（`D-S5`）

`consultation` / `company_research_review` も同じ canary user で有効化できる。
purpose は comma 区切りで **1 つずつ**足して観測する（一度に全部にしない）。

```bash
CAREER_SERVER_CONTEXT_PURPOSES=interview_practice,consultation
# 観測して問題なければ
CAREER_SERVER_CONTEXT_PURPOSES=interview_practice,consultation,company_research_review
```

## 確認すること

| 観測 | 期待 |
|---|---|
| diagnostics `purpose` 別件数 | 有効化した purpose だけ増える |
| `context` 内訳 | `server_context_used` / `bridge_fallback` が purpose 横断で妥当 |
| `company_research_review` の prompt | ★ 同じ自己分析 / プロフィールが **2 回出ていない**（`D-S5` dedupe） |
| `consultation` の prompt | Event Signal block が従来位置のまま・Personal Memory は入らない |

---

# 3c. Stage 2c — Batch 2（cross-feature bridge 退役 / `D-S6`）

**新しい env は不要。** Batch 2 は既存の `CAREER_SERVER_CONTEXT_PURPOSES` /
`CAREER_SERVER_CONTEXT_CANARY_USER_IDS` の配下で動く。
purpose を有効化すると、その purpose の cross-feature も **source kind 単位**で server 化される。

## 確認すること

| 観測 | 期待 |
|---|---|
| `coverage` | `full_server` / `partial_server` / `bridge_fallback` / `gated_off` の内訳が妥当 |
| `sourceVerdict` | ★ **どの source が同期していないか**が kind 別に分かる（例 `matching:mismatch`） |
| `sourceOrigin` | verified な kind だけ `:server` が増える |
| 面接 / 相談 / 添削の出力 | 従来と変わらない（parity QA が byte 一致を固定済み） |
| prompt | ★ 同じ情報が 2 回出ていない（server と bridge の二重注入なし） |

## `partial_server` が出たときの読み方

**異常ではない。** 「一部 source だけ mirror が追いついていない」状態を正しく表している。
`sourceVerdict` でどの kind が `mismatch` / `unclaimed` かを見る:

- `mismatch` → その機能を一度開いて保存すると mirror が追いつく
- `unclaimed` → client がその kind の claim を送っていない（古い client / 未読込）
- `unreadable` → Layer 1 read 側の問題（`5. Warning signs` を参照）

## Batch 2 で **server 化されないもの**（仕様）

`gd`（ソロ GD）/ `gdRoom` / `eventSignals` は恒久的に request body 由来のまま。
それぞれ mirror が無い / server が書く / Layer 3 分離のため（`D-S6`）。

---

# 3d. Stage 2d — Closure Batch（全 live purpose / `D-S9`〜`D-S14`）

**新しい env は不要。** Closure Batch で **live purpose 7 件すべて**が
既存の `CAREER_SERVER_CONTEXT_PURPOSES` / `CAREER_SERVER_CONTEXT_CANARY_USER_IDS` 配下に入った。

```bash
# 1 つずつ足して観測する（一度に全部にしない）
CAREER_SERVER_CONTEXT_PURPOSES=interview_practice,consultation,company_research_review
# 観測して問題なければ
CAREER_SERVER_CONTEXT_PURPOSES=...,presentation_feedback
CAREER_SERVER_CONTEXT_PURPOSES=...,matching
CAREER_SERVER_CONTEXT_PURPOSES=...,self_analysis,self_analysis_deep_dive
```

## purpose 別の確認ポイント

| purpose | 画面 | 特に見るもの |
|---|---|---|
| `presentation_feedback` | `/career/presentation` | お題生成・評価・QA の 3 経路すべて。`useCareerContext` OFF のとき context が増えていないこと |
| `matching` | `/career/matching` | ★ **スコア（決定的エンジン）が従来と変わらないこと**。AI 出力だけでなく順位・総合点を見る |
| `self_analysis` | `/career/self-analysis` | 要約が従来どおり。job 経路のとき重複生成が起きないこと（identity hash 不変） |
| `self_analysis_deep_dive` | `/career/self-analysis`（深掘り） | 質問の重複回避が効いていること（pastSummaries が server 由来でも同じ 3 件） |

## `gd_room` は claim 無しでも server 由来になる（仕様）

`gd_room` は **server-authoritative**（`D-S10`）。Source-Sync claim を要求しないため、
`sourceVerdict` に `gd_room:*` は出ず、`sourceOrigin` は `gd_room:server` になる。
**これは bug ではない**（server が著者のデータに client cache との一致を求めない）。

ただし canary gate は効くので、非 canary user では `gd_room:bridge` になる。

## solo GD は永続的に bridge（structural / `D-S11`）

`gd_solo:not_server_capable` が観測に出る。これは「同期していない」ではなく
**server-readable な representation がそもそも無い**という意味。
数が減ることは無いので、`bridge` 率の分子として扱わないこと。

---

# 4. 観測（operator inspection）

集計値だけを返す read-only エンドポイントを開く。

```bash
# .env.local（任意・観測したいときだけ）
CAREER_DATA_SPINE_CANARY_DIAGNOSTICS_ENABLED=true
```

```text
GET /api/career/data-spine-canary
```

**三重 gate**（env 有効化 + authenticated member + canary allowlist）。
返るのは enum 別カウンタと率のみで、UUID / 本文 / prompt / AI response は **含まれない**。

```jsonc
{
  "enabled": true,
  "counters": {
    "requests": 12,
    "sync":    { "verified": 10, "mismatch": 2, "unreadable": 0, "unclaimed": 0, "invalid": 0 },
    "memory":  { "persisted": 7, "rebuilt": 3, "stale": 2, "invalid": 0, "omitted": 0 },
    "context": { "server_context_used": 8, "bridge_fallback": 4, ... },
    "coverage": { "full_server": 6, "partial_server": 2, "bridge_fallback": 4, "gated_off": 0 },
    "sourceOrigin":  { "profile:server": 8, "matching:bridge": 3, "gd_room:server": 5,
                       "gd_solo:not_server_capable": 8, ... },
    "sourceVerdict": { "profile:verified": 8, "matching:mismatch": 3, ... },
    "rates":   { "syncVerified": 0.83, "syncMismatch": 0.17, "contextUsed": 0.67, ... },
    "note": "process-local approximate counters; resets on restart/redeploy; ..."
  }
}
```

> ⚠️ counters は **process-local の近似値**。再起動・再デプロイでリセットされ、
> serverless では instance ごとに分かれる。傾向を見るためのものであり、監査値ではない。

---

# 5. Warning signs（何が起きたら止めるか）

| 兆候 | 意味 | 対応 |
|---|---|---|
| `syncMismatch` が高止まり | mirror が canonical に追いついていない（W2/W5 含む） | 即時の危険は無い（veto されている）。原因調査。多発するなら Stage 2 を戻す |
| `unreadable` が出る | mirror 読取失敗 / 200 件上限（truncated） | Stage 2 を戻す。Layer 1 read の調査 |
| `invalid` が出る | signal の wire 不正 / Memory row 破損 | 即 rollback して調査 |
| `bridge_fallback` が 100% | canary gate か sync が通っていない | UUID・env・端末同期を確認 |
| 面接 prompt が明らかに変わった | parity 崩れ | **即 rollback**。parity QA を再実行 |
| matching のスコア / 順位が変わった | 決定的エンジンの入力が変わった（`D-S9`） | **即 rollback**。`qa:careerMatching` を再実行 |
| `gd_room:bridge` ばかり | canary gate か RLS policy（owner select）が効いていない | `career_gd_results_hydrate_apply.sql` の適用状況を確認 |
| AI 機能のエラー率上昇 | fail-open が効いていない可能性 | **即 rollback** |

---

# 6. Immediate rollback

**env を消して再起動するだけ。** code rollback も DB rollback も不要。

```bash
# .env.local から以下を削除（またはコメントアウト）
# CAREER_PERSONAL_MEMORY_READ_ENABLED
# CAREER_PERSONAL_MEMORY_READ_CANARY_USER_IDS
# CAREER_SERVER_CONTEXT_PURPOSES
# CAREER_SERVER_CONTEXT_CANARY_USER_IDS
# CAREER_DATA_SPINE_CANARY_DIAGNOSTICS_ENABLED
```

段階的に戻したい場合は Server Context だけ先に戻す:

```bash
# Server Context のみ停止（Personal Memory は維持）
# CAREER_SERVER_CONTEXT_PURPOSES を削除、または
# CAREER_SERVER_CONTEXT_CANARY_USER_IDS を削除（どちらでも全 deny になる）
```

## ★ 禁止されている rollback

```text
❌ D-R1 への復帰（検証なしで永続 Memory を使う）
```

`CAREER_PERSONAL_MEMORY_LEGACY_D_R1` は **削除済み**（`D-S2`）。env も code path も存在しない。
rollback は必ず「**context を減らす**」方向で行う。

---

# 7. After rollback

確認すること:

1. `/career/interview` が従来どおり動く（request-body bridge 経路）
2. `/career/company-research` の添削が Memory 無しで従来どおり動く
3. `GET /api/career/data-spine-canary` が `{"enabled": false}` を返す
4. DB 変更は無い（本 canary は **DDL を伴わない**）

---

# 8. Activation stages

| Stage | 状態 | 目的 |
|---|---|---|
| Stage 0 | 全 OFF（現在） | — |
| Stage 1 | Personal Memory / 1 user | read gate・Source-Sync・persisted/rebuilt/omitted の確認 |
| Stage 2 | \+ `interview_practice` Server Context / 同一 1 user | server context 利用・bridge fallback・parity・context size |
| Stage 2b | \+ `consultation` / `company_research_review`（`D-S5`）/ 同一 1 user | 重複注入が無いこと・purpose 横断の fallback 分類 |
| Stage 2c | Batch 2 の cross-feature 退役（`D-S6`）/ env 追加なし | source kind 別 coverage・partial_server の内訳・出力 parity |
| Stage 2d | Closure Batch: 残り 4 purpose + `gd_room`（`D-S9`/`D-S10`）/ env 追加なし | matching スコア不変・presentation 3 経路・self-analysis job identity・structural bridge の分離観測 |
| Stage 3 | 観測のみ（拡大しない） | H-4 rollout evidence の蓄積 |

**Stage 3 の次（他ユーザーへの拡大）は H-4 の Human decision。本 runbook では扱わない。**

---

# 9. 今回の canary で ON にしないもの

- Consent production（`CAREER_CONSENT_*`）
- Layer 4（`CAREER_AGGREGATED_INSIGHT_*`）
- Layer 5（`CAREER_COMPANY_KNOWLEDGE_*`）
- ★ purpose list の **勝手な拡大**（`.env.local` の purpose は operator が 1 つずつ足す）
- Personal Memory の広域 rollout（allowlist は 1 UUID のみ）

---

# 10. 既知の限界（canary を止めない）

`D-S3` の cross-device stale mirror overwrite（W2/W5）は未解決。
ただし read 側は保護されている:

```text
mirror が要求端末と不整合
  → Source-Sync mismatch
  → veto
  → mirror 由来 Personal Memory / server context は使われない
```

canary 中は `rates.syncMismatch` を必ず確認すること。
この値は将来の global canonical / write-integrity 改善の判断材料になる。

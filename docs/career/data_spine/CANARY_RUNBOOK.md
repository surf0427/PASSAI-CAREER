# PASSAI CAREER — Data Spine Canary Runbook

**対象:** Human 本人 1 ユーザーだけで Personal Memory と `interview_practice` Server Context を
安全に試験運用するための操作手順。

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
| Stage 3 | 観測のみ（拡大しない） | H-4 rollout evidence の蓄積 |

**Stage 3 の次（他ユーザーへの拡大）は H-4 の Human decision。本 runbook では扱わない。**

---

# 9. 今回の canary で ON にしないもの

- Consent production（`CAREER_CONSENT_*`）
- Layer 4（`CAREER_AGGREGATED_INSIGHT_*`）
- Layer 5（`CAREER_COMPANY_KNOWLEDGE_*`）
- `interview_practice` 以外の Server Context purpose
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

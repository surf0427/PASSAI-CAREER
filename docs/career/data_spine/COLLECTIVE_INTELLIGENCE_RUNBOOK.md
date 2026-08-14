# PASSAI CAREER — Collective Intelligence Runbook

**対象:** Layer 4（Aggregated Insight）/ Layer 5（Company Knowledge）の activation と rollback。

**現在の状態:**

```text
policy      : FROZEN（H-L1/L3/L4/L6 APPROVED、H-L2/L5 法務保留）
architecture: READY
migration   : PREPARED（supabase/migrations_pending/・**未適用**）
production  : OFF（全 flag 未設定・consumer 0）
```

> `ACTIVATION_READY ≠ LEGALLY_APPROVED ≠ PRODUCTION_ENABLED`

---

# 0. 有効化の前提（すべて満たすまで進まない）

```bash
# preflight を確認（コードから）
npx tsx --tsconfig tsconfig.realtime-test.json -e "
  const { runPreflight } = require('./lib/careerCollectiveIntelligence/preflight');
  console.log(JSON.stringify(runPreflight({}), null, 2));
"
```

`blocking` が空になるまで activation へ進まない。

| check | 満たし方 |
|---|---|
| `policy_frozen` | ✅ 済（registry が凍結済み） |
| `policy_version_supported` | ✅ 済 |
| `cohort_configured` | ✅ 済（H-L1 APPROVED） |
| `retention_configured` | ✅ 済（H-L2 の 5 class 定義済み） |
| `legal_approved` | ❌ **H-L7 待ち**。承認文書 ID を source として渡す |
| `moderator_configured` | ❌ moderator 解決 adapter の実装・設定（H-L6） |
| `infra_adapter_configured` | ❌ batch provider adapter（H-L8） |
| `migration_applied` | ❌ `migrations_pending/` の適用（H-L8） |
| `rls_expected` | ❌ 適用後の検証 |
| `feature_flags_off` | ✅ 現在 OFF（有効化前の期待状態） |

---

# 1. Activation sequence（順序厳守）

```text
 0. 法務承認（H-L7）を取得し、承認文書 ID を記録する
 1. policy version を凍結する（registry の CURRENT_POLICY_VERSION を固定）
 2. DB migration を適用する（010 → 020 → 030 → 040 の順）
 3. RLS を検証する（post-apply verification）
 4. batch provider を設定する（scheduler / lock / monitoring）
 5. moderator を設定する（解決 adapter + 承認者の指名）
 6. canary を設定する（allowlist へ 1 UUID）
 7. consent surface を有効化する
 8. contribution collection を有効化する（Layer 5 の書き込み）
 9. shadow / dry-run を実行して観測する
10. Layer 4 canary を有効化する
11. Layer 5 canary を有効化する
12. 観測する（最低 2 週間）
13. Human 承認後にのみ拡大する
```

## Step 0 — 法務承認

`COLLECTIVE_INTELLIGENCE_LEGAL_REVIEW.md` の 10 項目に回答を得る。
回答が推奨と異なる場合は **step 1 へ戻り policy を修正**してから進む。

```text
★ 承認の記録方法: preflight へ
   { legalApproved: true, legalApprovalSource: '<承認文書 ID>' }
   を渡す。`approved: true` だけでは承認と見なされない（`isLegalApproved`）。
```

## Step 1 — policy version の凍結

法務回答で値が変わったら `lib/careerCollectiveIntelligence/policy/registry.ts` を更新し、
**意味が変わる変更なら `CURRENT_POLICY_VERSION` を上げる**。

```bash
npm run qa:careerCollectiveIntelligenceProductionPrep   # PF-1 が registry と既存 module の一致を検証
```

## Step 2 — DB migration

```bash
# 適用前 preflight（supabase/migrations_pending/README.md の SQL を実行）
# 適用（Supabase SQL Editor で 1 ファイルずつ・順序厳守）
#   010_consent_policies_and_ledger.sql
#   020_contributor_subject_identity.sql
#   030_layer5_read_contract.sql
#   040_layer4_read_contract.sql
```

★ 各ファイルは transaction で囲まれているので、失敗したらそのファイル全体が巻き戻る。
★ `GRANT` は必ず `ENABLE ROW LEVEL SECURITY` の後（保護なしの瞬間を作らない）。

## Step 3 — RLS 検証

`migrations_pending/README.md` の「Post-apply verification」4 クエリを実行し、
**すべて 0 行**であることを確認する。1 行でも返ったら step 2 へ戻る。

## Step 4 — batch provider

推奨と代替は `§5 batch provider` を参照。設定後:

```bash
# dry-run（破壊しない）
#   runAggregateBatch({ key, ports, nowIso, dryRun: true })
# → status: 'skipped_dry_run' が返ること
```

## Step 5 — moderator

`ResolveModeratorPort` の実装を用意し、承認者の `auth.uid()` に capability を付与する。

```text
★ 未設定のままだと authorizeModeratorAction は no_moderator_provider で **全拒否**。
  「adapter が無いから素通し」にはならない。
```

## Step 6-8 — canary / consent / contribution

```bash
# .env.local（operator が 1 つずつ）
CAREER_AGGREGATED_INSIGHT_CANARY_USER_IDS=<UUID>
CAREER_COMPANY_KNOWLEDGE_CANARY_USER_IDS=<UUID>
CAREER_CONSENT_CAPTURE_ENABLED=true
CAREER_CONSENT_POLICY_LEGAL_APPROVED=true   # ★ step 0 完了後のみ
```

## Step 9 — shadow / dry-run

```bash
CAREER_AGGREGATED_INSIGHT_READ_ENABLED=true
CAREER_AGGREGATED_INSIGHT_CONSULTATION_ENABLED=true
# synthetic-only のまま（CAREER_AGGREGATED_INSIGHT_SYNTHETIC_ONLY は解除しない）
```

member request 経由で出るのは **gate probe のログのみ**（DB read なし）。

```text
[data-spine-gate-probe] {"runId":"...","performedRead":false,"privilegedAccess":false,...}
```

`stoppedAt` が期待どおりかを確認する。

## Step 10-11 — Layer 4 / Layer 5 canary

```bash
# Layer 4（synthetic-only を解除するのは real 検証時のみ）
CAREER_AGGREGATED_INSIGHT_SYNTHETIC_ONLY=false
# Layer 5
CAREER_COMPANY_KNOWLEDGE_READ_ENABLED=true
CAREER_COMPANY_KNOWLEDGE_RESEARCH_ENABLED=true
```

★ **real mode を開ける前に**、privileged shadow が member request path から
到達不能であることを再確認する（`npm run qa:careerCollectiveIntelligenceDecisionResolution` の HDR-1/HDR-2）。

## Step 12-13 — 観測 / 拡大

拡大は Human 承認のみ。runbook では扱わない。

---

# 2. Rollback sequence

**code rollback を最初に選ばない。** 順序は「止める範囲を広げていく」。

```text
1. serving OFF     … CAREER_AGGREGATED_INSIGHT_READ_ENABLED / _CONSULTATION_ENABLED を削除
                     CAREER_COMPANY_KNOWLEDGE_READ_ENABLED を削除
2. contributions OFF … CAREER_COMPANY_KNOWLEDGE_RESEARCH_ENABLED を削除
3. batch OFF       … scheduler を停止（cursor は残す＝再開できる）
4. canary 縮小     … allowlist を空にする
5. （必要なら）code rollback
```

## ★ rollback で **やってはいけないこと**

```text
❌ consent ledger の削除     … 「誰が何に同意していたか」を再構成できなくなる
❌ provenance の削除         … 由来を失った knowledge は復元も検証もできない
❌ contributor subject の削除 … 撤回の意思表示ごと消える
❌ table の DROP             … データ削除は別 decision（H-L5 / H-L7）
```

rollback は **読めなくする**方向で行い、**消す**方向では行わない。

## データ削除が必要になった場合

`executeCleanup()` は以下がすべて揃わないと破壊しない:

```text
dryRun === false（明示）
AND policy version がサポート対象
AND legalApproved === true
AND SafeDeletePort の実装が渡されている
```

現在 `SafeDeletePort` の production 実装は **存在しない**（QA `PF-11` が固定）。

---

# 3. 観測（何を見るか）

| 指標 | 期待 | 異常時 |
|---|---|---|
| gate probe の `stoppedAt` | 設定した gate で止まる | 想定外の値 → env 設定を確認 |
| Layer 4 `suppressed` 率 | 初期は高い（データ不足） | 100% が続く → cohort 閾値 or データ量 |
| Layer 5 `moderation_pending` 滞留 | 72h 以内に処理 | 滞留 → moderator 不足 |
| `not_a_moderator` 拒否 | 一般 member は常に拒否 | 許可されたら **即 rollback** |
| retention `undetermined` | 0 | >0 → policy version / 時刻データの問題 |

---

# 4. Warning signs（即 rollback する条件）

| 兆候 | 対応 |
|---|---|
| 一般 member が moderation action を実行できた | **即 rollback**。`PF-7` を再実行 |
| published view に contributor 識別子が出た | **即 rollback**。`PF-9` を再実行 |
| Layer 4 の出力に individual row が出た | **即 rollback**。`CI-13` を再実行 |
| 小 cohort で数値が返った | **即 rollback**。`CI-4` を再実行 |
| member request で service-role read が発生した | **即 rollback**。`HDR-1` を再実行 |
| Personal Optimization の出力が変わった | **即 rollback**。Layer 4/5 は prompt に触れない設計 |

---

# 5. Batch provider（推奨と代替）

現行 stack（Next.js on Vercel + Supabase）から自然な候補:

| | provider | 長所 | 短所 |
|---|---|---|---|
| **推奨** | **Supabase `pg_cron` + SECURITY DEFINER RPC** | DB 内で完結し、排他（advisory lock）と retry を同じ transaction で扱える。member path から完全に分離できる | SQL 実装が必要。監視は Supabase ログ依存 |
| 代替 A | Vercel Cron + 専用 route | 実装が TypeScript で統一できる | **route である以上 member path と同じ入口**になる。認証と分離設計を厳密にする必要がある |
| 代替 B | GitHub Actions schedule | 完全に外部。member path と物理的に分離 | secret 管理が増える。実行遅延が大きい |

★ どれを選んでも `batchRunner.ts` は変更不要（provider-neutral）。

## 必要な provisioning 要件

| 項目 | 要件 |
|---|---|
| scheduling | 日次 1 回で十分（metric は月次 bucket） |
| concurrency | **同時実行は 1**。runner は排他を提供しないため provider 側で保証する |
| distributed lock | `claimRun` port の実装で DB の UNIQUE 制約 or advisory lock を使う |
| retry | 失敗時は次回スケジュールで自然に再試行（cursor が進んでいない） |
| cursor | DB に保存（provider 再起動で失わない） |
| monitoring | run 状態（succeeded / failed / completed_empty）の可視化 |
| alerting | 連続 failed が N 回で通知 |

---

# 6. 現在有効化しないもの

- Layer 4 の real mode（synthetic-only のまま）
- Layer 5 の contribution 受付
- consent production
- broad rollout（canary allowlist は 1 UUID）
- destructive retention cleanup

---

# 7. 未実施の検証（隠さない）

```text
Browser / operational validation: NOT PERFORMED
```

Layer 4 / Layer 5 は **production consumer が 0** のため UI が存在せず、
browser E2E の対象そのものが無い。activation 後に初めて対象が生まれる。

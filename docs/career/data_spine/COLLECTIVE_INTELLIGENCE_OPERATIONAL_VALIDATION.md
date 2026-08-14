# PASSAI CAREER — Collective Intelligence Operational Validation

**実施日:** 2026-08-14
**目的:** production / legal approval を必要としない技術検証を可能な限り完了させる。
**production 変更:** なし（migration 未適用・flag 全 OFF・consumer 0）

---

# 1. 実行環境の制約（正直に記録する）

migration の **実 DB apply 検証（Option 1）** を試みたが、本環境には以下が存在しない:

```text
psql / pg_ctl / postgres  … なし
docker                    … なし
Supabase CLI / config.toml … なし
pg / postgres client library … package.json に無し
```

production DB へは絶対に接続しないため、**Option 2（静的実行検証）** を採用した。

## 静的検証で担保できたこと

| 項目 | 方法 |
|---|---|
| statement 分割 / 種別判定 | dollar-quoted body を保護した parser |
| transaction 境界 | BEGIN…COMMIT が 1 組 |
| **RLS 順序** | 各 table で `ENABLE RLS` が `GRANT` より前 |
| 依存順序 | 参照オブジェクトが同 package or 適用済み DDL に存在 |
| 冪等性 | `IF NOT EXISTS` / `DROP … IF EXISTS` / `OR REPLACE` |
| RPC の owner 束縛 | `auth.uid()` 使用・uuid 引数なし・anon REVOKE |
| published view の漏洩 | 禁止 column を SELECT していない / `security_invoker=on` |

## 静的検証で担保 **できない**こと（誇張しない）

```text
❌ Postgres parser による文法検証（実 parser を通していない）
❌ 実行時の権限・型エラー
❌ RLS policy の実効性（実際に別 user で読めないこと）
```

→ 実 DB が使える環境（staging）で改めて検証が必要。
`COLLECTIVE_INTELLIGENCE_RUNBOOK.md` の Step 3（RLS 検証）がその工程。

---

# 2. Migration validation 結果

```text
010_consent_policies_and_ledger.sql
→ 020_contributor_subject_identity.sql
→ 030_layer5_read_contract.sql
→ 040_layer4_read_contract.sql
```

| ID | 内容 | 結果 |
|---|---|---|
| M1 | fresh schema から順に apply 可能（transaction 境界・依存順序） | ✅ |
| M2 | table 作成後、**GRANT 前に RLS 有効** | ✅ |
| M3 | member access が owner scoped | ✅ owner-scoped policy 3 件 |
| M4 | cross-user read/write 禁止 | ✅ 想定外の broad policy なし |
| M5 | caller-selected UUID RPC なし | ✅ 全 RPC が `auth.uid()` 束縛・uuid 引数なし |
| M6 | I2 subject mapping 成立 | ✅ opaque_key UNIQUE / unlinked_at あり |
| M7 | published view に auth UUID なし | ✅ + `security_invoker=on` |
| M8 | unknown contributor は fail closed | ✅ `resolveContributorOpaqueKey` が deny |
| M9 | consent missing/revoked で contribution 不可 | ✅ 二段 gate |
| M10 | migration failure 時の partial exposure なし | ✅ GRANT が transaction 内 |

**owner-scoped policy:** `career_consent_ledger owner select` /
`career_ck_subjects owner select` / `career_ck_contributions owner select`

**broad policy（許容）:** `career_company_master read`（企業マスタは個人データでない）/
`career_consent_policies read`（policy manifest）/
`career_ck_contributions published read`・`career_ck_moderation published read`（published のみ）/
`career_aggregate_artifacts member read`（suppression 済み集計値）

---

# 3. Layer 4 operational dry-run（実行トレース）

```text
consent なし
  → evaluateConsentEligibility: ineligible                    ✅ L4-1

eligible source（event.feature_usage）+ consent
  → isAggregateEligibleSource: true
  → projectAggregateContribution: ok, month=2026-06           ✅ L4-2

60 user × 1 event（+ heavy user の重複 1 件）
  → 61 projections
  → boundContributions → 60 contributions                     ✅ heavy user が 1 に畳まれる

cohort 60 >= user_facing 閾値 50
  → evaluateCohort: not suppressed                            ✅ L4-5
  → buildValidArtifact: kind=valid, denominator=60

artifact 内容検査
  → user_id / userId / client_event_id / u-000 / occurredAt / rows すべて無し ✅ L4-6
  → prevalence + provenance あり
```

## suppression 経路

| 入力 | 結果 |
|---|---|
| n=3 / 15（internal） | suppressed ✅ L4-3 |
| n=30（user_facing） | suppressed ✅ |
| n=80（ai_context） | suppressed ✅ |
| graduation_year support=5 | rare ✅ L4-4 |
| graduation_year support=25 | not rare |
| all cohort support=1 | rare 判定対象外（母集団全体） |

suppressed artifact に `numerator` / `denominator` / `prevalence` は **型として存在しない** ✅

| その他 | 結果 |
|---|---|
| L4-7 未サポート policy version | serve 不可 ✅ |
| L4-8 401 日経過 artifact | expired（retention candidate）✅ |
| L4-9 dry-run ETL | execute 0 回・cursor 未更新 ✅ |
| L4-10 同一 batch retry | execute 1 回のみ（duplicate なし）✅ |

---

# 4. ETL operational validation

| 項目 | 結果 |
|---|---|
| idempotency | 同一 runKey の再実行は `skipped_already_succeeded`。execute は 1 回のみ |
| cursor progression | 成功後に `nextWindowStart` が window 末尾へ進む |
| restart | cursor から次 window を導出できる（未開始なら default から） |
| failure | `failed` state + `failureCategory` が残る。**cursor は進めない** |
| retry | attempt 2 で成功。cursor が進む |
| dry-run | 書き込みゼロ・port 未呼び出し |
| rebuild | `collectRebuildTargets`（port 未実装なら空配列＝通常実行へ） |
| invalidation | `invalidation.ts` の state machine（別 module） |

## concurrency = 1（現行 contract）

```text
runner 自体は分散ロックを持たない（advisory_lock / Mutex / redlock を import しない）
→ 排他は claimRun port の実装（DB の UNIQUE 制約 or advisory lock）の責務
→ provider 側で「同時実行 1」を保証する
```

この事実は module のコメントと QA（`OD-5`）の両方で固定してある。**隠していない。**

---

# 5. Layer 5 operational dry-run（実行トレース）

```text
auth.uid() 11111111… → subject 解決 → opaque-A               ✅ I2

sharing 二段 gate（master opt-in AND per-item 確認）→ allowed

PII pre-screen: 「一次面接はオンラインで 30 分程度だった。」
  → scan state = clean → moderation field へ反映

lifecycle:
  draft --submit--> consent_pending
        --grant_consent--> submitted
        --start_privacy_review--> privacy_review
        --pass_privacy_review--> moderation_pending           ✅ L5-6
  ★ moderation_pending から publish への遷移は **存在しない**

moderator 認可（synthetic adapter）
  → capabilities ['review','approve','publish'] → approve 許可 ✅ L5-8

  approve → approved
  publish → published

shared read（published のみ）
  → status=available
  → opaque-A / contributionId / auth UUID / fingerprint すべて無し ✅ L5-9
```

## 拒否経路

| ID | シナリオ | 結果 |
|---|---|---|
| L5-1 | sharing opt-in なし | reject ✅ |
| L5-2 | master opt-in のみ | reject ✅ |
| L5-3 | per-item 確認のみ | reject ✅ |
| L5-4 | piiScan = `not_scanned` | reject ✅（shared read にも出ない） |
| L5-5 | piiScan = `pii_detected` | reject ✅ |
| L5-7 | 一般 member の approve 試行 | reject ✅ |
| L5-10 | private research → 自動変換 | **変換 module が repo に存在しない** ✅ |
| L5-11 | publication 前に consent 撤回 | publish 不可 ✅ |
| L5-12 | published single-source の撤回 | unpublish 候補 ✅ |

---

# 6. I2 identity lifecycle validation

```text
auth UUID → subject 解決 → opaque key → contribution         ✅
```

## unlink 後の contract（実測）

| 項目 | 結果 |
|---|---|
| 本人が自分の寄与を辿れるか | ❌ 不可（opaque key を解決できない） |
| 他人が辿れるか | ❌ 不可 |
| 新規寄与を作れるか | ❌ 不可（future contributions blocked） |
| contribution 本体 | 変わらない（**provenance は保持される**） |
| public representation から再識別 | ❌ 不可 |

```text
unlink → 本人にも他人にも contribution を紐づけられない = 完全匿名化
```

★ これは「削除」ではなく「**紐付けの切断**」。contribution 本体と provenance は残るため、
複数人由来の knowledge の価値を壊さずに、個人の撤回意思を実現できる。

**withdrawal before unlink:** 未公開の寄与は `delete` 対象（H-L5 の状態別ルール）。

---

# 7. Consent lifecycle E2E

```text
1) 記録なし          → NOT CONSENTED       ✅
2) grant             → CONSENTED           ✅
3) contribute        → 二段 gate 通過       ✅
4) revoke            → NOT CONSENTED       ✅
5) 以後の contribution → blocked            ✅
```

## policy version change

```text
supported v1  → CONSENTED
unknown   v2  → NOT CONSENTED（fail closed）  ✅
```

Layer 4 側も同様（`optedOut` → ineligible）。

---

# 8. Retention boundary tests

| class | 境界内 | 境界外 |
|---|---|---|
| pending_moderation_contribution（30d） | 29d retained ✅ | 31d expired ✅ |
| aggregate_raw_input（90d） | 89d retained ✅ | 91d expired ✅ |
| approved_shared_knowledge（730d） | 729d retained ✅ | 731d expired ✅ |
| aggregate_artifact（400d） | 399d retained ✅ | 401d expired ✅ |
| operational_log（180d） | 179d retained ✅ | 181d expired ✅ |

10 件の fixture から **境界超過の 5 件だけ**が cleanup candidate になった ✅

| 実行 | 結果 |
|---|---|
| dry-run | 削除 0 件・port 未呼び出し ✅ |
| legal 未承認 + dryRun=false | `refusedReason: legal_not_approved`・削除ゼロ ✅ |
| port 未指定 | `refusedReason: no_port`・削除ゼロ ✅ |

★ production の `SafeDeletePort` 実装は repo に存在しない ＝ **destructive cleanup の起動経路が無い**。

---

# 9. ★ Legal Q3 technical trace（法務へ渡す evidence）

**Q3:** 生成済み aggregate から個人の寄与だけを差し引けない構造を許容できるか。

## 撤回時に **構造的に成立する**こと（実測済み）

```text
consent revoked
  → 以後の projection が consent_ineligible で reject     【future input blocked】
  → その source は以後の batch 入力に現れない              【future rebuild excludes source】
  → 影響 window の batch を invalidate → regeneration      【既存 artifact は window 単位で作り直す】
  → regeneration 完了まで fail-closed で serve しない
```

## 構造的に **不可能**なこと

```text
生成済み artifact から特定個人の寄与だけを差し引く
```

**技術的根拠（QA が検証済み）:**

artifact に含まれるのは
`metricKey / calculationVersion / feature / cohortType / cohortValue / timeBucket /
sourceWindow / generatedAt / expiresAt / consentScope / provenance / numerator / denominator / prevalence`
のみで、**個人を辿れる field が 1 つも無い**。

これは実装の不足ではなく設計の帰結である。個人単位の逆引きを保持すれば差し引きは可能になるが、
それは「匿名集計が個人を逆算できる」状態を意味し、Layer 4 の前提そのものを壊す。

## 選択肢（法務判断）

| 選択 | 帰結 |
|---|---|
| **A** この制約を許容する | 現設計のまま。撤回は future + window 単位再生成で対応 |
| **B** 差し引きが必須 | Layer 4 は現設計では実現不可。逆引き保持（匿名性低下）か Layer 4 断念 |

★ **Claude はこの判断をしない。** 技術的挙動のみを固定して法務へ渡す。

---

# 10. Production preflight（現在の出力）

```text
development  ready=true   blocking=[]
staging      ready=false  blocking=[infra_adapter_configured, migration_applied,
                                     moderator_configured, rls_expected]
production   ready=false  blocking=[infra_adapter_configured, legal_approved,
                                     migration_applied, moderator_configured, rls_expected]
mode 未指定  → production として評価（既定は最も厳しい側）
```

★ **environment による自動 approve はしない。** mode は「どの check を必須にするか」を変えるだけで、
どれかを自動的に満たしたことにはしない。production では legal 未承認なら必ず NOT READY。

## blocking が **運用項目だけ**であること

```text
architecture 起因の blocker: 0
```

残る 5 件はすべて provisioning / legal の運用項目（QA `OD-12` が固定）。
`policy_frozen` / `cohort_configured` / `retention_configured` / `policy_version_supported` は
すべて満たされている。

---

# 11. Moderator adapter 判定（Case A / Case B）

repo を再監査した結果:

```text
既存の trusted server-side admin identity source: 存在しない
  - role table なし
  - app_metadata / user_metadata による role 判定なし
  - admin route / admin auth なし
```

→ **Case B** を採用。provider interface + provisioning contract のみを残す。

```text
production code path: moderator provider missing → DENY
QA/test:              synthetic moderator adapter を使用（production には存在しない）
```

Human approver は **コードへ hardcode していない**。

---

# 12. 検証していないこと（隠さない）

| 項目 | 理由 |
|---|---|
| 実 DB での migration apply | 実行環境に DB が無い（§1）。staging で要実施 |
| RLS policy の実効性 | 同上。別 user session での read 検証が必要 |
| browser / UI E2E | **production consumer が 0** のため対象が存在しない |
| 実 AI API を伴う経路 | 禁止（Layer 4/5 は AI を呼ばない） |
| 実 moderator による承認 | 承認者が未指名（H-L6 provisioning） |

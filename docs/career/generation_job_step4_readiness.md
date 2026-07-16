# 自己分析まとめ生成 job — Step 4 統合レディネス / Failure Matrix / Gate 手順

STEP-CAREER-GENJOB-01 / 02 の pilot（`career_generation_jobs` + 202/after background + status poll）を、
**実 DB / Vercel Preview / 外部 Claude API を実行する前**の最終コード監査としてまとめる。

本書は「決定論的統合 QA が green で、Step 1–3 の server/client contract に重大不整合が無い」ことを前提に、
Gate A（実 Postgres）/ Gate B（Vercel Preview）の手順・期待結果・停止条件を固定する。

- 実装参照: [generation_job_deployment_gates.md](generation_job_deployment_gates.md)
- 統合 QA: `npm run qa:careerGenerationJob`（sql-contract / core / step2 / step3 / **step4**）

> pilot flag `CAREER_SELF_ANALYSIS_JOB_PILOT_ENABLED` は本 Step では **ON にしない**（default OFF）。

---

## 1. Step 1–4 アーキテクチャ / フロー要約

```
[client run page] --POST /api/career/self-analysis--> [route.POST]
     (member: controller / anonymous: legacyGenerate)        |
                                                              | pilot OFF or anonymous or 非canary
                                                              +--> legacyGenerate()（同期 Claude → {result} / {error,code,detail}）
                                                              |
                                                              | pilot ON member
                                                              +--> handleSelfAnalysisJobPost
                                                                     - resolveAuth（auth_error/anonymous/member）
                                                                     - buildIdentity（server-authoritative idempotency key）
                                                                     - claimGenerationJob（atomic RPC・6 outcome）
                                                                     - after(runAttempt) を登録し即 202
                                                                     runAttempt（bounded invocation 内）:
                                                                       provider.generate → parse → schema検証
                                                                       → completeGenerationJob / failGenerationJob（fenced）

[client controller] --GET /api/career/self-analysis/job?jobId=--> [job route.GET]
     poll / resume / stale-resubmit                              owner-scoped SELECT（RLS + user_id）
                                                                 → mapOwnedJobToStatusResponse（純粋変換）
     completed → finalizeSummary.saveCompletedSelfAnalysis（localStorage canonical + member mirror）
                → navigate('/career/self-analysis/result')
```

- **Step 1**: DB 基盤（table / natural key / RLS / GRANT / atomic claim function）。`supabase/career_generation_jobs_apply.sql`。
- **Step 2**: route を 202 化・`after()` background・status endpoint。`summaryJobService` / `summaryJobAttempt` / `summaryJobStatus` / `summaryProvider`。
- **Step 3**: client controller（polling / reload recovery / ambiguous POST recovery / multi-tab / cleanup）。`lib/careerSelfAnalysis/clientJob/*` + `useSelfAnalysisGeneration` + `finalizeSummary`。
- **Step 4**: 統合レディネス監査 + `scripts/career-generation-job-step4-qa.ts`（本書）。新機能追加なし。

### 設計不変条件（コードで担保）

| 不変条件 | 実装箇所 |
| --- | --- |
| idempotency key は **server 側でのみ算出**（client は送らない） | `idempotency.ts` / `route.POST buildIdentity` / QA D8 |
| natural key = `UNIQUE(user_id, idempotency_key)` | SQL §1 |
| attempt fencing = `status=running AND attempt_token 一致 AND user_id 一致` | `repository.complete/failGenerationJob` / SQL |
| GET は claim/reclaim/write しない（純粋 SELECT + 純粋 mapper） | `job/route.ts` / `summaryJobStatus.ts` / QA D6 |
| retryable 判定は DB 値でなく server allowlist mapping | `constants.isRetryableErrorCode` / QA D5 |
| pending に raw 本文 / result / error / secret を保存しない | `clientJob/types.ts` / `pendingStore` / QA D7 |
| pilot targeting は **fail-closed**（flag OFF / 空・malformed・wildcard allowlist → 誰も job 経路に入れない・掲載 UUID exact 一致のみ） | `pilotTargeting.ts` / `flag.server.ts` / canary QA §1–7 |
| client は server lease 定数を複製しない | `clientJob/constants.ts` / QA D3 |
| 時間予算 provider+prep+reserve ≤ maxDuration・lease > maxDuration | `constants.timeBudgetIsConsistent` / QA D1–D2 |

---

## 2. Route Duration / Background Budget（コード値一覧）

| 項目 | 定数 | 値 |
| --- | --- | --- |
| route maxDuration | `ROUTE_MAX_DURATION_SECONDS` / route リテラル | 300 s（一致を QA D1 で検証） |
| provider deadline | `PROVIDER_DEADLINE_MS` | 225,000 ms |
| preparation budget | `PREPARATION_BUDGET_MS` | 15,000 ms |
| finalization reserve | `FINALIZATION_RESERVE_MS` | 60,000 ms |
| lease / stale | `LEASE_SECONDS` | 360 s |
| max attempts | `MAX_ATTEMPTS` | 3 |
| polling min / max | `MIN_POLL_MS` / `MAX_POLL_MS` | 1,000 / 10,000 ms |
| active polling 上限 | `MAX_ACTIVE_POLLS` / `MAX_ACTIVE_POLL_MS` | 200 回 / 360,000 ms |
| transport 再送上限 | `MAX_TRANSPORT_RESUBMIT` | 5 回 |
| transport backoff | `TRANSPORT_BASE/MULT/MAX` | 1,000 ×2 上限 10,000 ms |

**検証済み**

1. `225,000 + 15,000 + 60,000 = 300,000 ≤ 300 × 1000` ✔（**余白ゼロ・等号成立**。reserve を削るとき最注意）。
2. `LEASE_SECONDS(360) > maxDuration(300)` ✔（正常実行中の境界 reclaim 競合を避ける）。
3. lease は無限 running を生まない（stale reclaim / RETRY_LIMIT_REACHED terminal 化）。
4. client polling 上限（200 回 / 360 s）は server lease と矛盾しない（超過時は pending を消さず「再確認」へ）。
5. client は server lease 定数を複製しない（stale 判定は server `recoveryAction` に従う）。
6. `retryAfterMs` は server hint。client は `clampPollDelay` で `[1000,10000]` に clamp（負値/NaN/Infinity/非数値 → MIN）。
7. **Vercel 設定不足時の failure**: maxDuration が 300 s 未満だと provider deadline(225 s) 到達前に Function timeout → job は running のまま → lease(360 s) 失効後に reclaim で回復（completed へ自動昇格しない）。Fluid Compute 無効だと `after()` が response 後に継続せず、同様に running 残留 → reclaim 回復。→ Gate B で実測必須。

---

## 3. Integrated Failure Matrix

server state / client state / 自動 retry / 手動 retry / 二重生成可否 / pending / recovery / terminal を明記する。
「auto」= ambiguous transport 失敗のみに限定した自動再送。terminal は自動 retry しない。

### Submission failures

| # | failure point | server | client | auto | manual | dup生成 | pending | recovery | terminal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | POST 前 client validation 失敗（`buildRequestBody`=null） | 未到達 | failed(INVALID_INPUT) | ✖ | ✖ | なし | 書かない | 入力補完 | ○ |
| 2 | POST が server へ到達しない（network） | 未到達 | reconnecting→auto | ✔ | 再確認 | なし | unknown/jobId=null | 自動再送→再確認 | ✖ |
| 3 | 到達したが response 受信不能（transport_error） | claim 済みかもしれない | reconnecting→auto | ✔ | 再確認 | **なし**（同一 idempotency key で再 POST=同一 job） | unknown/jobId=null | 同一 body 再送 | ✖ |
| 4 | claim 前に storage unavailable | 503 retryable | reconnecting→auto | ✔ | 再確認 | なし | 維持 | 自動再送 | ✖ |
| 5 | claim 成功後・202 前に切断 | running（claim 済み） | reconnecting→auto | ✔ | 再確認 | **なし**（再 POST は ALREADY_RUNNING/reclaim） | 維持 | 再送→poll | ✖ |
| 6 | completed 既存 job | 200 completed | completed→finalize→nav | ✖ | ✖ | なし（cached 返却） | 削除 | 即完了 | ○ |
| 7 | running 既存 job | 202 running | running→poll | ✖ | 再確認 | なし | running | poll | ✖ |
| 8 | retryable failed 既存 job（reclaim 可） | CLAIMED_RETRY→202 | running→poll | ✖ | 再確認 | なし（新 attempt） | running | poll | ✖ |
| 9 | MAX_ATTEMPTS 到達 | 409 RETRY_LIMIT_REACHED | failed / retry不可 | ✖ | ✖ | なし | 維持 | 手動再確認のみ | ○ |

### Background failures

| # | failure point | server | client（次 poll で観測） | auto | manual | dup | pending | recovery | terminal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | provider 開始前失敗 | fenced fail(NETWORK/…) | failed retryable | ✖ | ✔ | なし | 維持 | 手動 retry | ✖ |
| 11 | provider timeout | fenced fail(PROVIDER_TIMEOUT) | failed retryable | ✖ | ✔ | なし | 維持 | 手動 retry | ✖ |
| 12 | provider network error | fenced fail(NETWORK) | failed retryable | ✖ | ✔ | なし | 維持 | 手動 retry | ✖ |
| 13 | provider invalid response（parse不能） | 1回0温度再試行→fail(PARSE_FAILED) | failed / retry不可 | ✖ | ✖ | なし | 維持 | 入力見直し | ○ |
| 14 | output schema 検証失敗 | fail(SCHEMA_VALIDATION_FAILED) | failed / retry不可 | ✖ | ✖ | なし | 維持 | 入力見直し | ○ |
| 15 | DB finalize 失敗 | fenced fail 試行（握り→running残） | 次 poll で running/再確認 | ✖ | 再確認 | なし | 維持 | lease reclaim | ✖ |
| 16 | lease 期限切れ | running（lease 失効） | GET→resubmit→再POST reclaim | ✔(resubmit) | 再確認 | なし（fencing） | 維持 | reclaim | ✖ |
| 17 | old attempt が遅れて完了 | fenced complete/fail applied=false | 影響なし（server 破棄） | — | — | **なし**（fencing 拒否） | — | — | — |
| 18 | Function timeout でプロセス終了 | running のまま | poll→resubmit（lease失効後） | ✔ | 再確認 | なし | 維持 | lease reclaim | ✖ |
| 19 | after callback 未完走 | running のまま | 同上 | ✔ | 再確認 | なし | 維持 | lease reclaim | ✖ |
| 20 | completed 保存後に client 未通知 | completed | 次 poll / reload / 他タブで回収 | ✖ | 再確認 | なし | 維持→回収時削除 | GET completed | ○ |

### Polling failures

| # | failure point | server | client | auto | manual | pending | recovery |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 21 | GET 一時 network 失敗 | — | reconnecting + backoff poll | ✔ | 再確認 | 維持 | backoff |
| 22 | GET 401（session 喪失） | 401 LOGIN_REQUIRED | reconnecting(AUTH) / poll停止 | ✖ | 再確認 | 維持 | 再ログイン後 recheck |
| 23 | GET owner mismatch | 404（存在推測防止） | reconnecting / poll停止 | ✖ | 再確認 | 維持 | recheck |
| 24 | GET 404 / unknown job | 404 not_found | reconnecting / poll停止 | ✖ | 再確認 | 維持 | recheck |
| 25 | running が長時間継続 | 200 running poll | active cap 到達→reconnecting | ✖ | 再確認 | 維持 | recheck |
| 26 | stale lease で resubmit 指示 | 200 running resubmit | 同一 body 再 POST | ✔ | 再確認 | 維持 | reclaim |
| 27 | completed response | 200 completed | finalize→nav | ✖ | — | 削除 | 完了 |
| 28 | retryable failed response | 200 failed retryable | failed / 手動 retry可 | ✖ | ✔ | 維持 | retry |
| 29 | terminal failed response | 200 failed non-retryable | failed / retry不可 | ✖ | ✖ | 維持 | 入力見直し |
| 30 | malformed status response | 200 想定外 | reconnecting（断定しない） | ✖ | 再確認 | 維持 | recheck |

### Client lifecycle failures

| # | failure point | 挙動 |
| --- | --- | --- |
| 31 | reload 後 jobId あり | GET poll 再開 |
| 32 | reload 後 jobId なし・source 復元可 | 同一 fingerprint 一致で再 POST |
| 33 | reload 後 jobId なし・conversation 復元不能 | reconnecting + recheck（raw を pending 複製しない） |
| 34 | logout | poll 停止 + 全 owner pending 削除 + idle |
| 35 | user switch | 旧 owner job 不採用 / poll・POST しない / idle |
| 36 | unmount | timer/fetch 無効化（dispose） |
| 37 | 新しい generation 開始 | seq 更新で旧 in-flight 無効化 |
| 38 | old poll response 到着 | stale-response guard で破棄（finalize/nav しない） |
| 39 | two-tab 同時 poll | 各タブ単一 poll loop。storage event で jobId 採用/完了伝播 |
| 40 | 別タブで completed | storage 削除 event → 実行中 poll 停止 → 1 回 GET で completed 回収 |
| 41 | pending storage 破損 | version/owner 不一致は不採用（安全に idle/停止） |
| 42 | prompt revision mismatch | pending の revision で識別。自動再送しない（recheck 誘導） |
| 43 | output schema revision mismatch | 同上 |

### Terminal condition の境界

- **自動 retry**: ambiguous transport 失敗（#2–5, 21, 26 の resubmit）**のみ**。上限 `MAX_TRANSPORT_RESUBMIT=5`。
- **手動 retry**: generation retryable failure（#10–12, 28）。ユーザーの明示操作で同一 body 再送（reclaim は server 判断）。
- **terminal（retry しない）**: INVALID_INPUT / PARSE_FAILED / SCHEMA_VALIDATION_FAILED / OUTPUT_TRUNCATED / POLICY_VIOLATION / RETRY_LIMIT_REACHED / completed。

### 未解決 / 既知の非ブロッキング観測（Gate 前に人間確認）

- **O-1（pilot OFF member の legacy エラー UX）**: pilot OFF / 非 canary の member は client controller から legacy 同期経路を叩く。legacy **成功** `{result}` は completed として正しく消費されるが、legacy **失敗** `{error,code,detail}`（status/result なし）は client parser で一律 `PARSE_FAILED`（retry ボタン非表示）に潰れる。データ喪失はなく reload 再送で回復するが、AI timeout 等の一時失敗が「retry 不可」に見える degrade がある。Step 3 由来（Step 4 で新規混入ではない）・**pilot OFF 既定挙動・job path 非該当**のため CONDITIONAL GO を妨げないが、pilot 拡大前の follow-up 最小修正候補（`handleResponseBody` の legacy error 分岐追加）として記録する。
- **O-2（時間予算 余白ゼロ）**: `PROVIDER_DEADLINE_MS + PREPARATION_BUDGET_MS + FINALIZATION_RESERVE_MS` が maxDuration と**等号**。将来 reserve/prep を増やすなら provider deadline を必ず同量下げること（QA D2 が回帰検出）。

---

## 4. 決定論的統合 QA（外部 API / 実 DB なし）

`npm run qa:careerGenerationJobStep4`（`scripts/career-generation-job-step4-qa.ts`）。
**実 server レスポンス生成器**（`handleSelfAnalysisJobPost` / `mapOwnedJobToStatusResponse`）の出力を
**実 client controller** に流し込み、tier 跨ぎの union 消費を検証する（79 checks・ALL PASS）。

- **[A] POST union → client**（A1–A12）: CLAIMED_NEW/ALREADY_RUNNING/COMPLETED/FAILED_NON_RETRYABLE/RETRY_LIMIT_REACHED/INVALID_INPUT/storage 503/auth 503/legacy/未知field/result欠落/壊れbody。
- **[B] GET union（実 mapper）→ client**（B1–B9）: not_found/running(poll)/running(resubmit)/completed/failed(retryable/non)/401/malformed/recoveryAction 未知値。
- **[C] E2E fake flow**（C1–C9）: 正常完了/応答喪失再送(同一 fingerprint)/reload resume/stale reclaim/手動 retry/logout/user switch/stale-response guard/保存失敗。
- **[D] Durability・budget 不変条件**（D1–D9）: maxDuration↔定数一致 / 時間予算 / lease 非複製 / clamp / 未知 error_code 非 retryable / GET 非 write / pending 非保存(secret/9キー) / key 非送信 / completed 1回。

回帰確認: `npm run qa:careerGenerationJob`（sql-contract 69 / core 33 / step2 50 / step3 55 / step4 79 / **canary 46**）ALL PASS。

- **[Canary] fail-closed pilot targeting**（`scripts/career-generation-job-canary-qa.ts`・46 checks）:
  flag OFF / 空・whitespace・カンマのみ・malformed・wildcard(`*`/`all`)・valid+malformed 混在 allowlist →
  **誰も job 経路に入れない**。valid non-empty allowlist は掲載 UUID の exact 一致（case 非破壊・substring 不可・
  前後 trim）のみ対象。guest / 空・非 UUID userId は常に対象外。service routing に実 evaluator を DI し、
  guest / 非掲載 member / 空 allowlist member → legacy、掲載 member → 202+schedule を検証。静的に
  `flag.server.ts` の unsafe「空 allowlist → return true」経路が存在しないことも確認する。

---

## 5. Gate A — 実 Postgres 検証手順（未実行・operator 手動）

**前提**: 隔離 test DB（Supabase CLI local もしくは使い捨て project）。本番 DB へ接続しない。secret/実 PII をログに残さない。
**適用対象**: `supabase/career_generation_jobs_apply.sql`。

各項目 = prerequisite / operation / expected / failure condition / rollback / evidence。

| # | 確認 | operation | expected | failure | evidence |
| --- | --- | --- | --- | --- | --- |
| A-01 | migration 適用 | 空 DB に SQL 全文実行 | エラーなし完了 | 例外/構文エラー | 実行ログ（値なし） |
| A-02 | 冪等 | 同 SQL 再実行 | エラーなし（IF NOT EXISTS 等） | 重複作成エラー | ログ |
| A-03 | table/列存在 | `\d career_generation_jobs` | 列・型・default 一致 | 欠落 | schema dump |
| A-04 | index/unique | `\di` + natural key 確認 | `UNIQUE(user_id,idempotency_key)` + 2 index | 欠落 | dump |
| A-05 | function 存在 | `\df career_generation_job_claim` | SECURITY DEFINER / search_path=public,pg_temp | 欠落/search_path 不正 | dump |
| A-06 | grants | `\dp` | authenticated=SELECT のみ / service_role=ALL / anon=none | 余剰付与 | dump |
| A-07 | RLS owner read | authenticated JWT(A) で自 job SELECT | 1 行 | 0 行 | クエリ結果（id のみ） |
| A-08 | RLS 他 owner read | JWT(A) で B の job SELECT | 0 行 | 行返却 | 結果 |
| A-09 | browser write 禁止 | authenticated で INSERT/UPDATE/DELETE | 権限エラー | 成功 | エラーコード |
| A-10 | anon 禁止 | anon で SELECT/write | 全て拒否 | 成功 | エラー |
| A-11 | claim EXECUTE 禁止 | authenticated で RPC 実行 | 権限エラー | 成功 | エラー |
| A-12 | service claim 成功 | service_role で RPC | CLAIMED_NEW / attempt_token 返却 | 失敗 | outcome |
| A-13 | 並行 claim dedup | 同一 natural key で 2 並行 claim | CLAIMED_NEW 1・ALREADY_RUNNING 1 | 2×NEW / unique 例外露出 | 2 outcome |
| A-14 | 旧 attempt fencing(complete) | 旧 attempt_token で complete UPDATE | 0 行更新 | 1 行更新 | rowcount |
| A-15 | 旧 attempt fencing(fail) | 旧 attempt_token で fail UPDATE | 0 行更新 | 1 行 | rowcount |
| A-16 | 新 attempt complete | 現 attempt_token で complete | 1 行・status=completed | 0 行 | rowcount |
| A-17 | stale reclaim | lease 失効 running に claim | CLAIMED_RETRY・attempt_token 変化・count+1 | 変化なし | before/after token |
| A-18 | completed reuse | completed job に claim | ALREADY_COMPLETED（生成しない） | 再生成 | outcome |
| A-19 | retryable failed reclaim | retryable failed に claim | CLAIMED_RETRY | FAILED 固定 | outcome |
| A-20 | non-retryable 固定 | nonretryable failed に claim | FAILED_NON_RETRYABLE | reclaim | outcome |
| A-21 | MAX_ATTEMPTS terminal | attempt_count=3 stale running に claim | RETRY_LIMIT_REACHED + running→failed 確定 | running 残留 | before/after status |
| A-22 | raw 非保存 | 完了行を dump | result は構造化 JSON のみ・prompt/input/error 本文なし | 平文混入 | 列 dump |

**rollback/cleanup**: test DB を drop、もしくは `TRUNCATE career_generation_jobs`。本番非接続なので実データ影響なし。
**Gate A pass 条件**: A-01〜A-22 すべて expected 一致。1 つでも failure に該当したら NO-GO。

---

## 6. Gate B — Vercel Preview 検証手順（未実行・operator 手動）

> **詳細な operator 手順は [generation_job_gate_b_runbook.md](generation_job_gate_b_runbook.md)（Preview 専用・Production 非変更）。** 本節はゲート表の正本。

**前提**: Preview deploy。env は Dashboard 上で**設定名の存在確認のみ**（値表示しない）。canary owner を 1 名設定。
必須 env 名: `CAREER_SELF_ANALYSIS_JOB_PILOT_ENABLED` / `CAREER_SELF_ANALYSIS_JOB_CANARY_USER_IDS` / service-role・Supabase 系。

**fail-closed 契約（Preview で必ず確認）**: `CAREER_SELF_ANALYSIS_JOB_CANARY_USER_IDS` は
**空・未設定・malformed・wildcard(`*`/`all`) のいずれでも「誰も job 経路に入れない」**（= 全 member legacy）。
job 経路に入るのは flag ON かつ allowlist に **exact 一致する UUID** の member のみ。
「flag ON + 空 allowlist = 全 member pilot」は **誤り**（fail-closed へ是正済み・canary QA が回帰検出）。

| # | test | account/flag | 操作 | expected HTTP | expected DB | expected client | expected logs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B-01 | pilot OFF legacy | flag 未設定 | member で生成 | 200 {result} | job 行なし | 従来同期完了 | job ログなし |
| B-02 | canary 限定 | flag ON / allowlist=canary のみ | 非 canary member 生成 | 200 {result}（legacy） | 行なし | 従来完了 | job ログなし |
| B-03 | canary job path | flag ON / canary member | 生成 | 202 running | running 行 | submitting→running | 数値のみログ |
| B-04 | 短時間 202 | canary | POST 応答時間計測 | 202 が provider 完了を待たない | — | — | — |
| B-05 | after 継続 | canary | 202 後放置 | — | 数十秒後 completed | poll で completed | complete applied=true |
| B-06 | Function duration | canary | Dashboard の Max Duration 確認 | 300 s 運用・Fluid Compute 有効 | — | — | — |
| B-07 | client poll 取得 | canary | 生成後 poll | 200 completed | completed | completed→result 遷移 | — |
| B-08 | reload 復旧 | canary | 生成中 reload | GET 200 | running/completed | resume→完了 | — |
| B-09 | POST 応答喪失相当 | canary | 生成中に再送 | ALREADY_RUNNING/reclaim | 1 job（重複なし） | 二重生成なし | — |
| B-10 | stale lease recovery | canary | lease 失効を誘発 | resubmit→reclaim | 新 attempt_token | 完了 | — |
| B-11 | provider timeout | canary（擬似遅延） | — | fenced fail(PROVIDER_TIMEOUT) | failed retryable | 手動 retry可 | errorCode のみ |
| B-12 | Function timeout | canary | provider 強制長時間 | running 残留 | lease 失効後 reclaim | 再確認→完了 | — |
| B-13 | retryable failure | canary | 一時失敗誘発 | 200 failed retryable | failed | retry→完了 | — |
| B-14 | MAX_ATTEMPTS | canary | 3 回失敗 | 409 RETRY_LIMIT_REACHED | failed terminal | retry ボタン非表示 | — |
| B-15 | log redaction | canary | 全 test の logs 精査 | raw input/prompt/result/provider error/secret が**出ない** | — | — | 数値・固定コードのみ |
| B-16 | storage unavailable 非 fallback | canary / DB 未 provision | 生成 | 503 STORAGE_UNAVAILABLE | 行なし | reconnecting | silent legacy しない |
| B-17 | guest 回帰なし | anonymous | 生成 | 200 {result} | 行なし | 従来完了 | job 経路不使用 |

**Gate B pass 条件**: B-01〜B-17 すべて expected 一致。特に B-05/B-06（after 継続 + duration）、B-15（redaction）、B-16（非 silent fallback）は必須。
**停止条件**: B-15 で raw/secret 露出、B-16 で silent legacy、B-17 で guest 回帰が見えたら即 NO-GO。

---

## 7. Pilot enablement checklist（全 GREEN で ON 可）

- [ ] Step 1–4 QA green（`npm run qa:careerGenerationJob`）
- [ ] clean tree での project-wide typecheck green（`npx tsc --noEmit -p tsconfig.json`）
- [ ] clean tree での production build green（`npx next build`）
- [ ] Gate A（A-01〜A-22）pass
- [ ] Gate B（B-01〜B-17）pass
- [ ] owner-scoped canary account 設定（`CAREER_SELF_ANALYSIS_JOB_CANARY_USER_IDS`）
- [ ] logging redaction 確認（Gate B-15）
- [ ] rollback 手順確認（§8）
- [ ] pilot flag default OFF 確認（未設定＝OFF）
- [ ] 非ブロッキング観測 O-1 の可否判断（pilot 拡大前に legacy error 分岐の最小修正を入れるか）

> 現時点（実 DB 未検証・Vercel Preview 未検証・clean build 未確認）では pilot flag ON や production-ready 判定をしてはならない。

---

## 8. Rollback checklist

pilot 起因の問題検知時、以下の順で影響を止める（データ喪失なし・localStorage canonical）。

1. **flag OFF**: `CAREER_SELF_ANALYSIS_JOB_PILOT_ENABLED` を削除/false へ → 全 member が legacy 同期経路へ即復帰（job table 不使用）。redeploy 不要な env 反映で足りるか Dashboard で確認。
2. **canary 縮小**: 全停止でなく縮退なら `CAREER_SELF_ANALYSIS_JOB_CANARY_USER_IDS` から該当 user を除く。
3. **in-flight job**: running 行は lease(360 s) 失効後に自然 terminal（reclaim or RETRY_LIMIT_REACHED）。completed は localStorage に保存済みで影響なし。
4. **table 保持**: `career_generation_jobs` は drop しない（監査・再開のため）。必要なら `TRUNCATE` は行わず放置（RLS で owner 限定 read のみ）。
5. **client**: pending は owner 単位。logout で自然消去。強制クリアは不要（version/owner gate で安全）。
6. **確認**: rollback 後、anonymous・member 双方で従来同期生成が通ることを 1 ケースずつ確認。

---

## 9. Pilot 判定

Step 1–3 contract に重大不整合なし・統合 QA green（79 checks）・Gate A/B 手順完成 →

**CONDITIONAL GO TO GATE A**

残ブロッカー（人間判断・実行が必要）: 実 Postgres（Gate A）未検証 / Vercel Preview（Gate B）未検証 / clean tree での project-wide build 未確認 / 観測 O-1 の扱い。
これらが解消するまで pilot flag は OFF のまま。

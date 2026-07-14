# Data Spine — P17-E Operator Packet（shared synthetic activation）

**手順のみ。Claude Code は migration / env 設定 / Supabase 接続 / 実アプリ操作を自動実行しない。**
本パケットの実機作業（migration 適用・synthetic row 投入・env 設定・canary 設定・実アプリ実行・
evidence 保存・rollback）はすべて **operator の手動操作**である。

対象: Layer 4 Aggregated Insight を shared Supabase へ配置し、**synthetic データのみ**で
consultation の shadow read を行う（相談AIの本出力は変えない）。実ユーザーデータ・prompt 投入は本 series で行わない。

**共通の secret 非出力注意**: ログ・スクショ・evidence に project ref / URL / anon key / service-role key /
実 user UUID / email を貼らない。記録は「変数名」「成否」「件数 bucket」「evidence の safe field」のみ。

前提となるコード状態（P17-E / P17-E2 完了時点）:
- `supabase/career_aggregated_insight_apply.sql`（**未適用**・shared 明記・default-deny・`data_classification` 追加）。
- server-only: service-role read port / composition root / shadow dispatcher。
- flag default OFF・synthetic-only default true・canary allowlist default empty・real mode BLOCKED。
- consultation route は shadow dispatcher を `void`（fire-and-forget）呼び出し（prompt/response 不変）。

## 読み取り経路（P17-E2・重要）

- runtime の shadow read は **server-only の service-role client** を経由する（既存 `getServiceRoleSupabaseClient` を再利用）。
- `career_aggregate_*` table は **RLS enabled / policy 0（default deny）を維持**する。**service-role 向け RLS policy は作らない**（service_role は RLS を bypass するため不要）。
- したがって **anon / authenticated による table 直接 SELECT は拒否される（＝正常）**。synthetic shadow は **アプリ server 経由でのみ**読む。
- env は既存の server-only secret（`SUPABASE_SERVICE_ROLE_KEY`）を使う。**新規に secret を表示・コピー・作成しない**。NEXT_PUBLIC へ service-role を置かない。
- service-role factory が unavailable（key 未設定等）なら shadow は `unavailable`（fail-closed）になり、consultation は不変。

## Canary UUID は「shared Supabase Auth の UID」

- canary に設定する UUID は **shared Supabase Auth（root AuthProvider / useCurrentUserId 由来）の auth.uid()**。
- **CAREER ログイン（OTP・CareerAuthProvider）の UID ではない。** 混同すると canary が一致せず shadow は動かない。
- anonymous な shared auth user でも auth.uid() を持つため、その UID を allowlist に入れればよい（RUNTIME UNVERIFIED: 実 session が anon か member か）。

### shared UID の安全な取得（secret 不使用・実 UID は Claude Code から取得/表示しない）
1. **shared Supabase Auth Dashboard** で対象 user/session の UID を確認（推奨）。
2. 既存の安全な開発者診断ログ/画面がある場合のみ利用（新規 public API は作らない）。
3. 対象ブラウザの本人 shared session から、自分の shared user id を **operator 本人のみ**がローカル確認。
   （UID を外部公開する新規 endpoint は追加しない。）

---

## Phase 0 — 採用 decision 確認
- 実行者: PM / インフラ
- 前提: P17-D の採用（Q1=shared / Q3=L4 / Q4=synthetic / Q7=migration 可）
- 手順: 配置=shared、対象=L4、データ=synthetic のみ、を確認
- 期待結果: 非法務 readiness（target_project / identity_strategy / table_placement）を承認する方針が確定
- 停止条件: 配置未確定
- rollback: 何もしない（未着手）
- 証拠: 採用 decision メモ（値なし）
- secret: なし

## Phase 1 — 対象が shared project であることを確認
- 実行者: インフラ
- 前提: shared Supabase の管理権限
- 手順: 適用先が career_user_events と同じ shared project であることを（値を貼らずに）確認
- 期待結果: 適用先が shared に確定
- 停止条件: CAREER 専用 project を指している
- rollback: 適用しない
- 証拠: 「shared に適用予定」の確認（ref 値なし）

## Phase 2 — SQL review
- 実行者: レビュア 2 名
- 前提: `career_aggregated_insight_apply.sql`
- 手順: `npm run qa:careerDataSpineSharedSyntheticActivation` の [A] SQL が green を確認。header（NOT APPLIED / TARGET PROJECT: shared / DEFAULT DENY）・RLS enabled・policy/GRANT なし・禁止 column なし・`data_classification` を目視
- 期待結果: default-deny・shared 前提を確認
- 停止条件: policy/GRANT/禁止 column を発見
- rollback: 適用しない
- 証拠: QA ログ

## Phase 3 — backup / rollback 準備
- 実行者: インフラ
- 手順: 適用前 snapshot / PITR を確認。rollback 手段（table drop / synthetic row DELETE）を用意
- 期待結果: 復旧手段確保
- 停止条件: backup 不可
- rollback: N/A
- 証拠: backup 世代（bucket 可）
- secret: 接続情報を貼らない

## Phase 4 — migration 手動適用
- 実行者: インフラ（承認済みのみ）
- 前提: Phase 0-3 完了
- 手順: Supabase SQL Editor で `career_aggregated_insight_apply.sql` を **手動適用**（トランザクション）。schema.sql へ統合しない。**Claude Code は実行しない**
- 期待結果: table 作成・RLS 有効
- 停止条件: 依存エラー / 既存 table 衝突
- rollback: トランザクション rollback または snapshot 復元
- 証拠: 適用ログ（table 名のみ）

## Phase 5 — table / constraint / RLS 確認
- 実行者: インフラ
- 手順: 5 table の存在・`UNIQUE(idempotency_key)`・RLS enabled かつ **policy 0 件**・`data_classification` CHECK を確認。
  **anon / authenticated で SELECT すると拒否される（permission denied）ことが正常**であることを確認する
  （service-role read は runtime のアプリ server 経由のみ）。
- 期待結果: default-deny + idempotency + synthetic 分類が有効。anon SELECT は拒否。
- 停止条件: policy が存在する（特に service_role 向けや `USING (true)`）/ anon SELECT が通ってしまう / constraint 欠落
- rollback: policy 削除 or drop
- 証拠: 制約・RLS 一覧（anon SELECT 拒否の確認）

## Phase 6 — flag OFF / allowlist empty 確認
- 実行者: 運用
- 手順: `CAREER_AGGREGATED_INSIGHT_READ_ENABLED` / `..._CONSULTATION_ENABLED` が未設定（OFF）、`..._CANARY_USER_IDS` が空、`..._SYNTHETIC_ONLY` が未設定（=true）であることを確認
- 期待結果: 未通電（shadow は動かない）
- 停止条件: flag が ON / allowlist に値
- rollback: 変数を空へ
- 証拠: flag 状態（値なし）

## Phase 7 — synthetic seed review
- 実行者: 開発 + レビュア
- 手順: `npm run career:l4SyntheticSeed` で **INSERT 文を出力**し review（synthetic marker・非 PII・deterministic）。Claude Code は DB へ書かない
- 期待結果: reviewable な synthetic INSERT（valid/suppressed/stale/invalidated/incomplete）
- 停止条件: 実データ・PII・identity を発見
- rollback: 適用しない
- 証拠: seed SQL の review 記録

## Phase 8 — synthetic row 手動投入
- 実行者: インフラ（service-role / SQL Editor）
- 前提: Phase 7 の SQL
- 手順: 出力された INSERT を Supabase SQL Editor で手動適用（`data_classification='synthetic'` のみ）
- 期待結果: synthetic row が存在
- 停止条件: 実データ混入
- rollback: `DELETE FROM career_aggregate_artifacts WHERE data_classification='synthetic';` 等
- 証拠: 投入件数 bucket

## Phase 9 — repository round-trip
- 実行者: 開発
- 手順: `npm run career:l4SyntheticValidate`（fake port・実 DB 非接続）で valid/suppressed/stale/invalidated/incomplete の read mapping を確認。
  **実 DB の round-trip は runtime の service-role read 経由**（Phase 12 の shadow で実施）。**anon/authenticated 直 read policy は追加しない**
  （anon read が permission_denied=unavailable になるのは正常）。
- 期待結果: mapping が期待どおり。service-role 経由でのみ synthetic row が読める。
- 停止条件: mapping 不一致 / raw row 露出 / anon read を通すために policy を足したくなった（→ 足さない）
- rollback: N/A
- 証拠: validate ログ

## Phase 10 — synthetic readiness 確認
- 実行者: 運用
- 手順: `CAREER_DATA_SPINE_READY_TARGET_PROJECT` / `_IDENTITY_STRATEGY` / `_TABLE_PLACEMENT` を true に設定（**非法務3項目のみ**。法務項目は synthetic では免除）。real readiness（全12項目）は満たさない
- 期待結果: synthetic readiness = ready、real readiness = NOT ready
- 停止条件: 法務項目を誤って true にする / real mode を有効化しようとする
- rollback: 変数を未設定へ
- 証拠: readiness 判定（値なし）

## Phase 11 — single-user canary 設定
- 実行者: 運用
- 手順: `CAREER_AGGREGATED_INSIGHT_READ_ENABLED=true` / `..._CONSULTATION_ENABLED=true` を設定。`..._CANARY_USER_IDS` に
  **1 名の UUID のみ**（wildcard 禁止）。この UUID は **shared Supabase Auth の UID**（上記「Canary UUID は…」参照）で、
  **CAREER ログインの UID ではない**。`..._SYNTHETIC_ONLY` は未設定（=true）。service-role key（`SUPABASE_SERVICE_ROLE_KEY`）は
  既存設定を使い、**新規表示・コピーしない**。
- 期待結果: 対象 1 名（shared UID）のみ shadow 実行
- 停止条件: allowlist が空/複数/wildcard、**CAREER UID を設定**、synthetic_only=false、service-role key を新規発行/表示しようとした
- rollback: allowlist を空 / flag OFF
- 証拠: eligible 判定（UUID は記録しない・件数のみ）

## Phase 12 — shadow read（実アプリ 1 回）
- 実行者: 運用（canary user）
- 手順: 実アプリで consultation を 1 回実行。相談AIの応答が **通常どおり**であることを確認（shadow は応答に出ない）
- 期待結果: consultation 応答が byte-identical（shadow はログのみ）
- 停止条件: 応答が変化 / エラー増加 / 応答に集計文が出る
- rollback: flag OFF
- 証拠: 応答が通常どおりであること（本文は貼らない）

## Phase 13 — evidence export
- 実行者: 運用
- 手順: サーバログの `[data-spine-shadow]` 行（safe evidence JSON）を収集し JSON へ保存。raw / secret / uid が無いことを確認。
  **`access_path: 'server_service_role'` / `rls_mode: 'default_deny_bypassed_server_only'` /
  `identity_source: 'shared_auth_session'` / `synthetic_query_enforced: true`** が記録されていることを確認。
- 期待結果: safe evidence の JSON（access path が service-role・identity が shared）
- 停止条件: 禁止 field を発見 / access_path が service_role でない / identity_source が shared_auth_session でない
- rollback: N/A
- 証拠: evidence JSON（safe field のみ）

## Phase 14 — validator
- 実行者: 開発
- 手順: `npx tsx scripts/career-data-spine-l4-shadow-evidence-validator.ts evidence.json` で PASS / STOP / INCOMPLETE を判定
- 期待結果: synthetic round-trip が通れば PASS、未通電/未投入なら INCOMPLETE、契約違反なら STOP
- 停止条件: STOP
- rollback: STOP なら flag OFF + 調査
- 証拠: validator 結果

## Phase 15 — rollback
- 実行者: 運用
- 手順: canary allowlist を空 → consumer flag OFF → master flag OFF → readiness 変数を戻す。必要なら synthetic row DELETE / table drop（Phase 3 手順）
- 期待結果: 完全に未通電へ復帰（**flag OFF のみで shadow 停止し、privileged client 生成が 0 になる**）
- 停止条件: flag OFF にしても shadow が動く（＝gate 前に client 生成している疑い→即調査）
- rollback: 本 Phase が rollback
- 証拠: 全 flag OFF・readiness 未設定・shadow ログが出ないこと

## Phase 16 — 完了判定
- 実行者: PM
- 手順: Phase 12 で応答 byte-identical、Phase 14 が PASS（または synthetic 未投入なら INCOMPLETE）、Phase 15 rollback 成立を確認
- 期待結果: 「相談AIの本出力を変えずに L4 shadow read を安全に実行できる」状態を確認
- 停止条件: 応答変化 / STOP / rollback 不成立
- 証拠: 完了記録

---

## 通電順序（fail-closed 多重 gate）

```
master flag ON ─AND─ synthetic_only(=true) ─AND─ synthetic readiness READY(非法務3項目) ─AND─
  consumer flag ON ─AND─ shared-auth canary allowlist(1名) ─AND─ (real mode でない)
    └ ここまで全通過して初めて → server-only service-role client 生成 → synthetic-only query
      → governance → safe projection → renderer → evidence。
    └ どれか欠ければ privileged client を生成せず shadow は動かない（DB query 0）。consultation は byte-identical。
canary identity = shared Supabase Auth UID（CAREER OTP UID ではない）。
table は RLS default-deny のまま（service-role が bypass・policy は作らない）。
real-data mode は本 series で BLOCKED（composition が有効化しない）。
```

**現状: 全 gate が閉じている（未通電）。** shadow コードは追加済だが、operator が上記 Phase を進めるまで何も起きない。

# Data Spine — P17-C Operator Packet（migration / canary 手順書）

**このパケットは手順のみ。実行は運用者が行う。本 series では migration も canary も実施していない。**

前提となる状態（P17-C 完了時点）:
- SQL 草案は `supabase/career_aggregated_insight_apply.sql` / `supabase/career_company_knowledge_apply.sql`（**未適用・default deny**）。
- Supabase repository は client injection 実装（実 client 未注入）。
- server loader は fail-closed（flag OFF / readiness NOT READY / canary empty）。
- production route / prompt / Orchestrator へ未接続。

**共通の secret 非出力注意**: 本手順のログ・スクショ・証拠に、project ref / URL / anon key / service-role key / 実 user UUID / 実 email を**貼らない**。値ではなく「変数名」「成否」「件数 bucket」のみ記録する。

---

## Phase 0 — Decision Gate 確認
- **実行者**: PM + 法務 + インフラ
- **前提**: `data_spine_p17b_decision_register.md` の全 DEC 項目
- **手順**: 各 DEC の status を確認し、`CAREER_DATA_SPINE_READY_*`（server env, boolean）を承認済み項目のみ true にする（値の中身はコードに書かない）
- **期待結果**: `evaluateReadiness(getServerReadinessConfig())` が該当 Layer で ready
- **停止条件**: BLOCKED_BY_LEGAL / SUPABASE_DECISION_REQUIRED が未解決
- **rollback**: readiness flag を未設定へ戻す（=NOT READY）
- **証拠**: どの decision が承認されたかの一覧（値は不要）

## Phase 1 — Target Supabase Project 確認（DEC-01/02/03）
- **実行者**: インフラ
- **前提**: project / identity / table placement の決定
- **手順**: 適用先 project を確定し、client を注入する wiring 先を決める（コードへ project ref を hard-code しない）
- **期待結果**: 適用先 project が 1 つに確定
- **停止条件**: split-brain（L4 feedstock=shared / L2 memory=CAREER）未解決
- **rollback**: 適用しない
- **証拠**: 決定記録（ref 値は書かない）

## Phase 2 — Backup / Rollback 準備
- **実行者**: インフラ
- **前提**: 対象 project の backup 権限
- **手順**: 適用前 snapshot / PITR を確認。rollback 用の drop 手順を用意（drop は本パケットに含めない）
- **期待結果**: 復旧手段が確保されている
- **停止条件**: backup 不可
- **rollback**: N/A
- **証拠**: backup 時刻・世代（値は bucket で可）

## Phase 3 — SQL Review-Only 確認
- **実行者**: レビュア 2 名
- **前提**: 2 つの `*_apply.sql`
- **手順**: `qa:careerDataSpineProductionScaffold` の SQL 静的検査が green であることを確認。header（NOT APPLIED 等）・RLS enabled・policy 無し・GRANT 無し・禁止 column 無しを目視再確認
- **期待結果**: default-deny を確認
- **停止条件**: permissive policy / GRANT / 禁止 column を発見
- **rollback**: 適用しない
- **証拠**: QA ログ（PASS 数）

## Phase 4 — Migration 適用
- **実行者**: インフラ（承認済みのみ）
- **前提**: Phase 0-3 完了
- **手順**: 対象 project に対して SQL を **手動適用**（1 ファイルずつ、トランザクション）。schema.sql へは統合しない
- **期待結果**: table 作成成功・RLS 有効
- **停止条件**: 依存エラー / 既存 table 衝突
- **rollback**: トランザクション rollback、または Phase 2 の snapshot 復元
- **証拠**: 適用ログ（table 名のみ、値なし）

## Phase 5 — Table / RLS / Policy 確認
- **実行者**: インフラ
- **前提**: Phase 4 完了
- **手順**: 各 table で RLS enabled かつ policy 0 件（authenticated 直 read 不可）を確認
- **期待結果**: default deny が有効
- **停止条件**: 予期しない policy / GRANT
- **rollback**: policy を削除、または drop
- **証拠**: RLS 状態一覧

## Phase 6 — Synthetic / Test Data 投入
- **実行者**: インフラ（service-role・専用 test project 推奨）
- **前提**: Phase 5 完了
- **手順**: synthetic row のみを投入（実ユーザー投稿・private research を投入しない）。禁止 field を含めない
- **期待結果**: safe row のみ存在
- **停止条件**: 実データ混入
- **rollback**: test row 削除
- **証拠**: 投入件数 bucket

## Phase 7 — Repository Round-Trip
- **実行者**: 開発
- **前提**: 実 client を repository へ注入（config は server-only）
- **手順**: read repository で synthetic row を governed read（available / suppressed / stale / blocked の写像を確認）
- **期待結果**: 状態写像が QA と一致
- **停止条件**: 予期しない payload / raw row 露出
- **rollback**: 接続を切る
- **証拠**: 状態写像結果（payload の識別子が無いこと）

## Phase 8 — Loader Flag OFF 確認
- **実行者**: 開発
- **前提**: flag env 未設定
- **手順**: server loader が disabled（flag_off）を返すことを確認
- **期待結果**: 通電していない
- **停止条件**: flag OFF で available が返る
- **rollback**: N/A
- **証拠**: loader status

## Phase 9 — Single-User Canary 設定
- **実行者**: 運用
- **前提**: readiness ready + master/consumer flag ON（対象 Layer のみ）
- **手順**: `CAREER_*_CANARY_USER_IDS` に **1 名のみ**の UUID を設定（wildcard 禁止）。client 自己申告は使わない（server session の userId で判定）
- **期待結果**: 対象 1 名のみ eligible
- **停止条件**: allowlist が空 / malformed / wildcard
- **rollback**: allowlist を空へ
- **証拠**: eligible 判定（UUID は記録しない・件数のみ）

## Phase 10 — Layer 4 Consultation Shadow Read
- **実行者**: 開発 + 運用
- **前提**: Phase 9・L4 readiness
- **手順**: consultation で L4 loader を **shadow**（プロンプトへ投入せず比較のみ）。offline renderer 契約（valid のみ・disclaimer・byte budget）を確認
- **期待結果**: 既存 consultation prompt が byte-identical（shadow は投入しない）
- **停止条件**: 既存出力が変化
- **rollback**: canary allowlist を空へ
- **証拠**: shadow 比較結果（差分なし）

## Phase 11 — Layer 5 Company-Research Shadow Read
- **実行者**: 開発 + 運用
- **前提**: Phase 9・L5 readiness
- **手順**: company-research で L5 loader を shadow。official/user 区別・conflict 明示・単一投稿の trend 非表示を確認
- **期待結果**: 既存 prompt byte-identical
- **停止条件**: contributor identity 露出 / 単一投稿 trend 化 / 既存出力変化
- **rollback**: allowlist を空へ
- **証拠**: shadow 比較・projection に識別子が無いこと

## Phase 12 — Rollback
- **実行者**: 運用
- **前提**: 異常検知 or 検証完了
- **手順**: canary allowlist を空 → consumer flag OFF → master flag OFF → readiness を戻す。必要なら table drop（Phase 2 手順）
- **期待結果**: 完全に非通電へ復帰
- **停止条件**: N/A
- **rollback**: 本 Phase が rollback
- **証拠**: 全 flag OFF・readiness NOT READY

## Phase 13 — Evidence 保存
- **実行者**: 運用
- **前提**: 各 Phase の証拠
- **手順**: 各 Phase の成否・件数 bucket・QA ログを保存（secret / UUID / 値は除外）
- **期待結果**: 監査可能な記録
- **停止条件**: secret 混入
- **rollback**: 記録から secret を除去
- **証拠**: 保存済みエビデンス一覧

---

## 通電順序の要約（fail-closed の多重 gate）

```
readiness READY(対象 Layer) ── AND ── master read flag ON ── AND ── consumer flag ON ── AND ── canary allowlist(1名) ── AND ── governed read = valid
   └ どれか 1 つでも欠ければ loader は disabled / blocked（既存 AI を失敗させない・空 block）
```

**現状: 上記の gate は全て閉じている（未通電）。** 本パケットの Phase を順に、承認済みの範囲でのみ進めること。

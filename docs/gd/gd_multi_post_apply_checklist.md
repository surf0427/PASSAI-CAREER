# GD Phase2 マルチGD — Supabase post-apply checklist

対象 DDL: [`supabase/career_gd_multi_apply.sql`](../../supabase/career_gd_multi_apply.sql)
STEP: GD-10（DB 基盤準備）

> このドキュメントは「`career_gd_multi_apply.sql` を Supabase へ適用する運用者」向けの確認手順です。
> **STEP-GD-10 の時点では適用しません**（DDL / checklist の追加のみ）。実際の適用は
> Phase2 の実装（room API）着手時に、本チェックリストに沿って行います。

---

## 0. 適用方針（前提の再確認）

- Phase2 マルチは **member ログイン必須**。guest 参加不可（`auth.uid()` を持つ user のみ）。
- 合言葉は 6 桁数字コード。**平文は DB に保存しない**（`join_code_hash = digest(normalized_code || room_salt)`）。
- `code_expires_at`（作成から 30 分想定）後、および `status != 'waiting'` の room には **join 不可**。
- RLS は **API ゲートウェイ方式**。クライアントから `career_gd_*` テーブルを直接叩かない。
  DB 操作は **service-role を使う API route（`app/api/career/gd/room/**`）のみ**。認証・参加権限・
  host 権限はアプリ層で検証する。
- Realtime / ランダムマッチング / 音声・WebRTC は **Phase3**。Phase2 はポーリング。

---

## 1. SQL 適用前確認

- [ ] `supabase/career_gd_multi_apply.sql` の内容をレビューした（`DROP` / `TRUNCATE` / 既存テーブル ALTER が無いこと）。
- [ ] 前提オブジェクトが存在する：
  - [ ] `pgcrypto` 拡張（`gen_random_uuid()` / `digest()`）
  - [ ] `set_updated_at()` 関数（`schema.sql §3`）
  - [ ] `auth.users`
- [ ] 既存の `career_*`（受験版含む）テーブルへ影響しない新規テーブルのみであることを確認した。
- [ ] 本ファイルは idempotent（再実行安全）。ステージング環境で 2 回連続実行してエラーが出ないことを確認する。

## 2. 環境変数確認

- [ ] `NEXT_PUBLIC_SUPABASE_URL` が設定されている。
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY` が設定されている。
- [ ] `SUPABASE_SERVICE_ROLE_KEY` が **サーバ環境にのみ** 設定されている（クライアントに露出しない）。
  - room 系 API route は service-role でしか DB 操作できないため必須。
  - 未設定だと Phase2 の room API は 500（supabase-unavailable 相当）になる。

## 3. テーブル存在確認（適用後）

適用後、次の 4 テーブルが `public` に存在すること：

- [ ] `career_gd_rooms`
- [ ] `career_gd_room_members`
- [ ] `career_gd_room_messages`
- [ ] `career_gd_room_results`

```sql
select table_name from information_schema.tables
where table_schema='public' and table_name like 'career_gd_room%'
order by table_name;
```

- [ ] 制約が存在する：status/format/role/kind CHECK、planned_participant_count / time_limit_sec の範囲 CHECK。
- [ ] UNIQUE：`(room_id, user_id)`（members / results）、`(room_id, seq)`、`(room_id, client_msg_id)`。
- [ ] 部分 UNIQUE：`career_gd_rooms_waiting_code_uniq`（`WHERE status='waiting'`）。
- [ ] index：room_id 系 / user_id 系 / `code_expires_at`。
- [ ] `updated_at` trigger：rooms / members / results（messages は対象外）。

```sql
select tgname from pg_trigger
where tgname like 'career_gd_room%_set_updated_at';
```

## 4. RLS 有効確認

- [ ] 4 テーブルとも RLS が有効。

```sql
select relname, relrowsecurity from pg_class
where relname like 'career_gd_room%';   -- relrowsecurity = true を確認
```

- [ ] 4 テーブルに **anon / authenticated 向けの許可ポリシーが無い**（deny-by-default）。

```sql
select tablename, policyname, roles, cmd from pg_policies
where tablename like 'career_gd_room%';   -- MVP では 0 行（将来案の owner select を有効化した場合のみ 1 行）
```

## 5. 直接クライアントアクセスが拒否されること

- [ ] anon / authenticated クライアント（ブラウザ）から `career_gd_*` を SELECT すると **0 行 or 拒否** になる
      （許可ポリシーが無いため RLS で遮断される）。
- [ ] service-role クライアント（API route）からは正常に SELECT / INSERT / UPDATE できる（RLS バイパス）。

## 6. service-role API route からのみ操作すること

- [ ] room 系の DB 操作は `app/api/career/gd/room/**`（service-role）に限定されている。
- [ ] クライアントコードに `career_gd_*` テーブルへの直接 `.from('career_gd_...')` が **存在しない**。
- [ ] 各 API route は先頭で認証（member）→ 参加権限（room member）→ 必要なら host 権限を検証している。

## 7. 受験版テーブルに影響がないこと

- [ ] 適用前後で受験版テーブル（`interview_ai_*` / `essay*` / `statement*` / `profiles` / `usage_records` 等）
      のスキーマ・行数に変化が無い。
- [ ] 既存 career_* mirror テーブル（`career_profiles` 等）にも変化が無い。

## 8. rollback 方針

- 本 DDL は追加のみ（idempotent）。問題があれば **新規 4 テーブルを個別に DROP** すればロールバック可能。
  ```sql
  -- 逆順（FK 依存順）で DROP。ステージング / 緊急時のみ。本番データがある場合は要バックアップ。
  drop table if exists career_gd_room_results;
  drop table if exists career_gd_room_messages;
  drop table if exists career_gd_room_members;
  drop table if exists career_gd_rooms;
  ```
- 既存テーブルには触れていないため、DROP しても Phase1 ソロGD・既存 career 機能・受験版に影響しない。
- kill-switch：Phase2 の room API を未デプロイ / feature flag off にすれば、テーブルが存在しても未使用のまま。

## 9. PII / 議論ログ保存の注意

- `career_gd_room_messages.content` と `career_gd_room_results` には**ユーザーの発言・評価**が保存される。
- 保存に対する **同意文言**を room 作成/参加画面に明示する（Phase2 UI 実装時）。
- **保持期間**を決める（例：finished / cancelled から N 日で room ごと物理削除するクリーンジョブ）。
  `code_expires_at` は join 期限であり、データ保持期限とは別に管理する。
- 表示可視性：ranking（順位・企業評価ランク・根拠）は参加者全員に共有、詳細 FB は本人のみ、を
  API 層で担保する（host が他人の詳細 FB を見る権限は付与しない）。

## 10. Phase2 実装前の確認事項（次 STEP へ引き継ぎ）

- [ ] 6 桁コードの total attack 対策：join API の **レート制限**（連続失敗のクールダウン）を設計する。
- [ ] `seq` 採番の原子性（service-role で `max(seq)+1`、または room ごとのカウンタ）を設計する。
- [ ] AI 補完の確定タイミング＝host の start。`buildAiParticipants` / `assignRoles` を server で流用する。
- [ ] feedback は 1 room 1 回で全員分生成し、`career_gd_room_results` に人間ぶんだけ UPSERT する。
- [ ] 各参加者クライアントが自分の結果を `careerGdResults`（localStorage）へ書き戻し、既存 `/career/gd/view`
      で見返せることを確認する（Phase1 view は変更しない方針）。

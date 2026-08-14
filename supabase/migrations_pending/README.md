# `supabase/migrations_pending/` — production candidate migrations（**未適用**）

## この directory の意味

```text
supabase/*_apply.sql        … 適用済み / 適用対象の production migration
supabase/prototype/*.sql    … 検証用 prototype（適用しない）
supabase/migrations_pending/ … ★ production candidate。Human 承認後に適用する
```

`migrations_pending/` にあるものは **production へ適用する意図で書かれているが、まだ適用していない**。
`*_apply.sql` へ移す（またはこの directory から実行する）判断は **Human のみ**が行う。

## 適用禁止の担保

- ファイル名に `_apply` を含めない（既存の apply 運用に混入しない）
- CI / deploy から自動実行されない（本 repo に Supabase CLI / config.toml / auto-migration は無い）
- QA `career-collective-intelligence-production-prep-qa`（`PF-13`）が
  **この directory の内容が適用済み扱いされていないこと**と
  **RLS 有効化順序が安全であること**を静的に固定する

## 適用の前提条件（すべて満たすまで適用しない）

| # | 条件 | 対応する decision |
|---|---|---|
| 1 | 法務レビュー完了 | H-L7（**未完了**） |
| 2 | policy version の凍結 | H-L1〜H-L6（承認済み） |
| 3 | target project の確定 | H-L8 |
| 4 | moderator 運用者の確定 | H-L6 / H-L8 |
| 5 | batch provider の確定 | H-L8 |

## 適用順序（forward migration order）

```text
1. 010_consent_policies_and_ledger.sql       … consent の土台（他が参照する）
2. 020_contributor_subject_identity.sql      … I2 対応表（contribution の owner 判定に必要）
3. 030_layer5_read_contract.sql              … Layer 5 の RLS policy / published view
4. 040_layer4_read_contract.sql              … Layer 4 の RLS policy / index
```

各ファイルは `BEGIN; ... COMMIT;` で囲み、**1 ファイル = 1 transaction**。
途中で失敗したらその migration 全体が巻き戻る。

## RLS の順序原則（★ 最重要）

```text
禁止: CREATE TABLE → GRANT → （後で）ENABLE ROW LEVEL SECURITY
```

この順序だと **GRANT 後・RLS 有効化前**の一瞬、table が保護なしで公開される。

```text
必須: CREATE TABLE
   → ALTER TABLE ... ENABLE ROW LEVEL SECURITY
   → CREATE POLICY ...
   → GRANT ...            ← ★ GRANT は必ず最後
```

すべての migration がこの順序であることを `PF-13` が静的に検査する。

## Rollback strategy

DDL の rollback は **前進のみ**を原則とする（DROP は最後の手段）。

```text
1. まず feature flag を OFF にする（コード側で即座に無効化できる）
2. 必要なら policy だけを DROP する（table は残す）
   → 読めなくなるだけで、データは失われない
3. table の DROP は「データを捨ててよい」と Human が判断したときのみ
```

★ `career_consent_*` と provenance 系 table は **rollback で消さない**。
同意証跡・由来情報を失うと、後から「誰が何に同意していたか」を再構成できない。

## Preflight（適用前）

```sql
-- 1. 既存 table と衝突しないこと
SELECT tablename FROM pg_tables
 WHERE schemaname='public' AND tablename LIKE 'career_ck_%';

-- 2. auth.users が存在すること（FK 先）
SELECT to_regclass('auth.users');

-- 3. 適用対象 table に既存 policy が無いこと（意図しない上書きを防ぐ）
SELECT tablename, policyname FROM pg_policies
 WHERE schemaname='public' AND tablename LIKE 'career_%';
```

## Post-apply verification（適用後）

```sql
-- 1. ★ 全対象 table で RLS が有効
SELECT relname, relrowsecurity FROM pg_class
 WHERE relname LIKE 'career_%' AND relkind='r' AND NOT relrowsecurity;
-- → 0 行であること

-- 2. anon に GRANT が無い
SELECT table_name, privilege_type FROM information_schema.role_table_grants
 WHERE grantee='anon' AND table_name LIKE 'career_%';
-- → 0 行であること

-- 3. published view が contributor 識別子を含まない
SELECT column_name FROM information_schema.columns
 WHERE table_name='career_company_knowledge_published'
   AND column_name IN ('contributor_opaque_key','contributor_user_id','auth_user_id','content_fingerprint');
-- → 0 行であること

-- 4. SECURITY DEFINER 関数が anon へ EXECUTE を持たない
SELECT p.proname FROM pg_proc p
 JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prosecdef
   AND has_function_privilege('anon', p.oid, 'EXECUTE');
-- → 0 行であること
```

## 適用後も production は OFF のまま

migration を適用しても、Layer 4 / Layer 5 は **feature flag が OFF なので動かない**。
migration 適用と機能有効化は別ステップ（`COLLECTIVE_INTELLIGENCE_RUNBOOK.md` 参照）。

-- ============================================================
-- PASSAI 就活版 — GD 結果履歴の別デバイス hydrate 用 SELECT/RLS 整理（STEP-GD-20-L）
-- ------------------------------------------------------------
-- 目的:
--   マルチGD 結果履歴（career_gd_room_results）を、別デバイス・再ログイン・localStorage 消失後でも
--   「**ログイン本人が自分の結果だけ**」安全に復元（hydrate）できるようにする。
--
-- 方針（最小権限・deny-by-default 維持・他人の結果は読ませない）:
--   - career_gd_room_results **のみ** に authenticated の **SELECT のみ** を付与する
--     （rooms / members / messages には付与しない。INSERT/UPDATE/DELETE も付与しない）。
--   - RLS の **owner-select** policy `USING (auth.uid() = user_id)` で、authenticated は
--     **自分の user_id の行だけ** 読める。他人の self_feedback（本人のみ表示の私的評価）は読めない。
--     ※ 「参加した room の全員ぶん」を読ませる member-scoped 案は self_feedback が他人に見えてしまい、
--        要件「他人のGD結果が読める状態にしない」に反するため採らない（owner-scoped が正）。
--   - anon には一切付与しない（GRANT も policy も無し → 42501/0 行で拒否）。
--   - service_role は従来どおり（RLS bypass・CRUD 保持）。アプリの hydrate route も service_role で
--     `user_id = session.user.id` を **サーバ側で強制** して自分の行のみ返す（DDL 未適用でも安全に動作）。
--
-- idempotent: GRANT は no-op 再実行安全。policy は DROP IF EXISTS → CREATE で安全に再適用可能。
--   career_gd_multi_apply.sql に同名 policy（存在チェック付き）があるが、本ファイルは単独でも再適用できる。
--
-- 適用方法: Supabase SQL Editor 等で本ファイルを実行（運用者適用）。JS client では DDL 不可。
--   **未適用時の挙動**: authenticated の直接 SELECT は 42501/0 行で拒否されるが、アプリの hydrate は
--   server route（service_role + サーバ側 user_id 強制）で動作するため、履歴復元は未適用でも機能する。
--   本 SQL の適用は「browser 直 SELECT（方針A）を有効化する defense-in-depth」の位置づけ。
--
-- 確認:
--   SELECT policyname, cmd, roles FROM pg_policies
--    WHERE schemaname='public' AND tablename='career_gd_room_results';
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.career_gd_room_results') IS NULL THEN
    RAISE NOTICE 'career_gd_room_results 未作成のためスキップ（career_gd_multi_apply.sql を先に適用してください）。';
    RETURN;
  END IF;

  -- RLS を有効化（既に有効なら no-op）。
  EXECUTE 'ALTER TABLE public.career_gd_room_results ENABLE ROW LEVEL SECURITY';

  -- authenticated に本テーブルの SELECT のみ付与（最小権限）。
  EXECUTE 'GRANT USAGE ON SCHEMA public TO authenticated';
  EXECUTE 'GRANT SELECT ON public.career_gd_room_results TO authenticated';

  -- owner-select policy を安全に再作成（DROP IF EXISTS → CREATE）。
  EXECUTE 'DROP POLICY IF EXISTS "career_gd_room_results owner select" ON public.career_gd_room_results';
  EXECUTE 'CREATE POLICY "career_gd_room_results owner select"
             ON public.career_gd_room_results
             FOR SELECT TO authenticated
             USING (auth.uid() = user_id)';

  RAISE NOTICE 'career_gd_room_results: authenticated SELECT + owner-select RLS を適用しました。';
END $$;

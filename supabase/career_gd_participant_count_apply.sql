-- ============================================================
-- PASSAI 就活版 — GD 参加人数を 4 / 6 / 8 の 3 択に固定する CHECK 制約（STEP-GD-20-I）
-- ------------------------------------------------------------
-- 目的:
--   career_gd_rooms.planned_participant_count を全モード共通で 4 / 6 / 8 のみ許可する。
--   （正本は lib/careerGd/participantCount.ts。UI/API と DB を一致させる defense-in-depth。）
--
-- 特徴:
--   - idempotent（何度流しても安全）。既存 DDL/データを破壊しない（追加/制約差し替えのみ）。
--   - **既存データに 4/6/8 以外がある場合は自動で丸めず、明示的にエラーで停止**して手動修正を促す。
--   - career_gd_multi_apply.sql 未適用（テーブル未作成）の環境では NOTICE を出して安全にスキップ。
--
-- 適用対象:
--   - 本 STEP のテスト project（`career_gd_*` は空想定）。
--   - 本番/preview に旧仕様（2/3/5/7 等）の room が残る可能性がある環境。
--     → その場合は下記 preflight でエラー停止するので、運用者が該当 room を
--        finished/cancelled 化するか正しい人数へ手動修正してから再実行すること
--        （このスクリプトは勝手に値を書き換えない）。
--
-- 適用方法: Supabase SQL Editor 等で本ファイルを実行（service_role 相当）。
-- 確認:
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'public.career_gd_rooms'::regclass
--      AND conname = 'career_gd_rooms_planned_count_chk';
-- ============================================================

DO $$
DECLARE
  v_bad_count int;
BEGIN
  -- 0) テーブル未作成なら安全にスキップ（career_gd_multi_apply.sql を先に適用すること）。
  IF to_regclass('public.career_gd_rooms') IS NULL THEN
    RAISE NOTICE 'career_gd_rooms 未作成のためスキップ（career_gd_multi_apply.sql を先に適用してください）。';
    RETURN;
  END IF;

  -- 1) preflight: 4/6/8 以外の既存値があれば **丸めずエラー停止**（手動修正を促す）。
  SELECT count(*) INTO v_bad_count
    FROM public.career_gd_rooms
   WHERE planned_participant_count NOT IN (4, 6, 8);

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION
      'career_gd_rooms に planned_participant_count が 4/6/8 以外の行が % 件あります。自動変換はしません。該当行を手動で 4/6/8 に修正するか finished/cancelled 化してから再実行してください。',
      v_bad_count;
  END IF;

  -- 2) 旧 CHECK（BETWEEN 2 AND 8 等）を落として 4/6/8 の CHECK に差し替える（同名・冪等）。
  ALTER TABLE public.career_gd_rooms
    DROP CONSTRAINT IF EXISTS career_gd_rooms_planned_count_chk;
  ALTER TABLE public.career_gd_rooms
    ADD CONSTRAINT career_gd_rooms_planned_count_chk
    CHECK (planned_participant_count IN (4, 6, 8));

  RAISE NOTICE 'career_gd_rooms_planned_count_chk を IN (4, 6, 8) に更新しました。';
END $$;

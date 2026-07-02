-- ============================================================
-- PASSAI 就活版 — GD 公開ロビー 適用スクリプト（STEP-GD-20-A / DB層のみ）
-- career_gd_public_lobby_apply.sql
--
-- 目的：
--   既存のマルチGD room 基盤（career_gd_multi_apply.sql）を土台に、
--   「公開GDロビー方式」（誰でも見える公開 room を作り、合言葉なしで参加する）を
--   支える DB 追加要素だけを足す。
--     - career_gd_rooms への種別カラム（room_type / join_policy）追加
--     - 公開ロビー一覧用の部分インデックス
--     - 同一ホストの公開待機 room 乱立を防ぐ部分ユニークインデックス
--     - 満員レース（定員超過）を防ぐ参加 RPC career_gd_lobby_join
--
-- 方針／制約：
--   - このスクリプトは「Supabase に手動で貼って実行する」前提の冪等スクリプト。
--     再実行しても壊れない（IF NOT EXISTS / CREATE OR REPLACE / DO ガード）。
--   - 既存の career_gd_multi_apply.sql を一切壊さない（この後追いで足すだけ）。
--     * 既存テーブル・既存カラムの型変更／削除はしない。
--     * 既存 RPC career_gd_post_message には触れない。
--   - localStorage 版（Phase1）・受験版には無関係（Supabase 側の追加のみ）。
--   - RLS は既存どおり deny-by-default のまま。DB 操作は service-role（API ルート）経由に限定。
--   - 公開 room も既存 room と同じ career_gd_rooms を使う。合言葉は持たないが
--     join_code_hash は NOT NULL のため 'pub_' + UUID（非 hex）をアプリ側で入れる想定。
--     'pub_' 始まりは HMAC(64桁hex) と構造上一致しないため、既存の合言葉 join には乗らない。
--
-- 前提：
--   - career_gd_multi_apply.sql が先に適用済みであること（career_gd_rooms 等が存在する）。
--   - pgcrypto（gen_random_uuid 用）が有効であること。念のため下で有効化する。
--
-- 適用方法（例）：
--   1) Supabase SQL Editor にこのファイルの内容を貼り付けて実行、または
--   2) psql "$SUPABASE_DB_URL" -f supabase/career_gd_public_lobby_apply.sql
-- ============================================================

-- ------------------------------------------------------------
-- 0) 拡張（gen_random_uuid 用）。既に有効なら何もしない。
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) career_gd_rooms へのカラム追加（idempotent）
--    - room_type : room の種別。既存行はすべて 'invite'（＝従来の合言葉 room）になる。
--    - join_policy: 参加方式。既存行はすべて 'code'（＝合言葉参加）になる。
--    DEFAULT 付きで追加するため、既存の合言葉 room 作成は今後もこのデフォルトで動く。
--    CHECK には将来の 'random_match' / 'matched_only' も許可値に含めておき、
--    後で完全ランダムマッチを足すときの再 ALTER を不要にする。
-- ------------------------------------------------------------
ALTER TABLE public.career_gd_rooms
  ADD COLUMN IF NOT EXISTS room_type   text NOT NULL DEFAULT 'invite';
ALTER TABLE public.career_gd_rooms
  ADD COLUMN IF NOT EXISTS join_policy text NOT NULL DEFAULT 'code';

-- CHECK 制約は「無ければ足す」形で冪等に付与する（ADD CONSTRAINT は IF NOT EXISTS 不可のため DO で包む）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'career_gd_rooms_room_type_chk'
  ) THEN
    ALTER TABLE public.career_gd_rooms
      ADD CONSTRAINT career_gd_rooms_room_type_chk
      CHECK (room_type IN ('invite', 'public_lobby', 'random_match'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'career_gd_rooms_join_policy_chk'
  ) THEN
    ALTER TABLE public.career_gd_rooms
      ADD CONSTRAINT career_gd_rooms_join_policy_chk
      CHECK (join_policy IN ('code', 'public', 'matched_only'));
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2) 公開ロビー一覧用の部分インデックス（idempotent）
--    status='waiting' かつ room_type='public_lobby' の room を
--    新しい順に高速取得するための部分インデックス。
--    公開 room のみを対象にするため、既存 invite room の書き込み負荷には影響しない。
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS career_gd_rooms_public_lobby_idx
  ON public.career_gd_rooms (status, room_type, created_at DESC)
  WHERE room_type = 'public_lobby';

-- ------------------------------------------------------------
-- 3) 同一ホストの公開待機 room 乱立を防ぐ部分ユニークインデックス（推奨）
--    同じ host_user_id が status='waiting' かつ room_type='public_lobby' の room を
--    複数持てないようにする。
--    WHERE 条件で public_lobby の waiting のみを対象にするため、
--    既存 invite room（room_type='invite'）には一切影響しない。
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS career_gd_rooms_one_open_public_per_host
  ON public.career_gd_rooms (host_user_id)
  WHERE status = 'waiting' AND room_type = 'public_lobby';

-- ------------------------------------------------------------
-- 4) 公開ロビー参加 RPC career_gd_lobby_join（idempotent create or replace）
--    公開 room への「合言葉なし参加」を安全に行う。
--
--    満員レース対策：
--      アプリ層の「人数を数える → insert」は、別ユーザー同士が最後の 1 枠に
--      同時参加すると planned_participant_count を超過しうる（TOCTOU）。
--      ここでは advisory lock で room 単位に直列化し、行ロック付きで人数を数えてから
--      insert することで、定員超過を確実に防ぐ。
--
--    セキュリティ：
--      - SECURITY DEFINER（関数所有者権限で実行）。
--      - service_role のみ EXECUTE 可能（anon / authenticated には付与しない）。
--      - search_path を固定し、SECURITY DEFINER 関数の探索経路汚染を防ぐ。
--
--    引数：
--      p_room_id      参加対象の room
--      p_user_id      参加する member の user_id
--      p_display_name 表示名（NULL / 空白は 'メンバー' を使う）
--
--    戻り値：
--      該当ユーザーの career_gd_room_members 行（新規 insert / 既参加のいずれでも）。
--
--    例外（アプリ側で分類してレスポンス化する想定）：
--      'ROOM_NOT_JOINABLE' … room が公開待機中でない／存在しない
--      'ROOM_FULL'         … 人間定員に達している
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_gd_lobby_join(
  p_room_id      uuid,
  p_user_id      uuid,
  p_display_name text
)
RETURNS public.career_gd_room_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_planned int;
  v_human   int;
  v_row     public.career_gd_room_members;
BEGIN
  -- room 単位で参加処理を直列化（advisory lock）。トランザクション終了で自動解放。
  PERFORM pg_advisory_xact_lock(hashtext(p_room_id::text));

  -- 対象 room が「公開・待機中・公開参加可」であることを行ロック付きで確認する。
  SELECT planned_participant_count
    INTO v_planned
    FROM public.career_gd_rooms
   WHERE id = p_room_id
     AND status = 'waiting'
     AND room_type = 'public_lobby'
     AND join_policy = 'public'
   FOR UPDATE;

  IF v_planned IS NULL THEN
    RAISE EXCEPTION 'ROOM_NOT_JOINABLE';
  END IF;

  -- 二重参加防止：同じ (room_id, user_id) が既にあれば insert せず既存行を返す（冪等）。
  SELECT *
    INTO v_row
    FROM public.career_gd_room_members
   WHERE room_id = p_room_id
     AND user_id = p_user_id;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  -- 満員判定：人間（is_ai=false）かつ在室中（left_at IS NULL）の人数で数える。
  -- AI 補完は start 時に別途行うため、ここでは人間の枠だけを見る。
  SELECT count(*)
    INTO v_human
    FROM public.career_gd_room_members
   WHERE room_id = p_room_id
     AND is_ai = false
     AND left_at IS NULL;

  IF v_human >= v_planned THEN
    RAISE EXCEPTION 'ROOM_FULL';
  END IF;

  -- 参加者を insert（human / 非 host / member 役）。participant_id は既存 join と同じ形式。
  INSERT INTO public.career_gd_room_members (
    room_id, user_id, is_ai, is_host, participant_id, display_name, role
  ) VALUES (
    p_room_id,
    p_user_id,
    false,
    false,
    'gduser-' || gen_random_uuid()::text,
    COALESCE(NULLIF(btrim(p_display_name), ''), 'メンバー'),
    'member'
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- ------------------------------------------------------------
-- 5) 実行権限：service_role のみ（anon / authenticated には付与しない）。
--    まず public から全権剥奪し、service_role にだけ EXECUTE を与える。
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.career_gd_lobby_join(uuid, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_lobby_join(uuid, uuid, text) TO service_role;

-- ============================================================
-- 適用後の簡易確認（任意）：
--   -- カラム追加の確認
--   SELECT column_name, data_type, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'career_gd_rooms'
--      AND column_name IN ('room_type', 'join_policy');
--
--   -- 既存行がすべてデフォルト（invite / code）になっているか
--   SELECT room_type, join_policy, count(*)
--     FROM public.career_gd_rooms
--    GROUP BY room_type, join_policy;
--
--   -- インデックス／RPC の存在確認
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'career_gd_rooms'
--      AND indexname IN ('career_gd_rooms_public_lobby_idx',
--                        'career_gd_rooms_one_open_public_per_host');
--   SELECT proname FROM pg_proc WHERE proname = 'career_gd_lobby_join';
-- ============================================================

-- 以上。既存 career_gd_multi_apply.sql を壊さず、公開ロビー用の追加要素だけを足した。

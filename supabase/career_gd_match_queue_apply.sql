-- ============================================================
-- PASSAI 就活版 — GD 完全ランダムマッチ 適用スクリプト（STEP-GD-21 / DB 層）
-- career_gd_match_queue_apply.sql
--
-- 目的：
--   既存のマルチGD room 基盤（career_gd_multi_apply.sql）＋公開ロビー
--   （career_gd_public_lobby_apply.sql）を土台に、「完全ランダムマッチ」を支える
--   DB 追加要素だけを足す。
--     - 待機キュー用テーブル career_gd_match_queue（4/6/8 別・人数は planned_count 列で分ける）
--     - 同一 user が同時に複数の waiting 行を持てない部分ユニークインデックス
--     - マッチング RPC（enter / poll / cancel）。満員レース・二重 room 作成・二重参加を
--       advisory lock + FOR UPDATE SKIP LOCKED で原子的に防ぐ。
--
-- 方針／制約：
--   - このスクリプトは「Supabase に手動で貼って実行する」前提の冪等スクリプト
--     （再実行しても壊れない：IF NOT EXISTS / CREATE OR REPLACE / DO ガード）。
--   - 既存 career_gd_multi_apply.sql / career_gd_public_lobby_apply.sql を一切壊さない
--     （この後追いで足すだけ。既存テーブル・カラム・RPC は不変）。
--   - localStorage 版（Phase1）・受験版には無関係（Supabase 側の追加のみ）。
--   - RLS は既存どおり deny-by-default（許可ポリシー無し）。DB 操作は service-role（API ルート）に限定。
--   - ランダムマッチ room も既存 career_gd_rooms を使う。合言葉は持たないが join_code_hash は
--     NOT NULL のため 'rnd_' + UUID（非 hex）をアプリ側で入れる。'rnd_' 始まりは HMAC(64桁hex) と
--     構造上一致しないため、既存の合言葉 join には決して乗らない。room_type='random_match' /
--     join_policy='matched_only' により公開ロビー一覧（public_lobby 限定）にも出ない。
--
-- 前提：
--   - career_gd_multi_apply.sql（career_gd_rooms 等）と career_gd_public_lobby_apply.sql
--     （room_type / join_policy 列・CHECK）が先に適用済みであること。
--   - pgcrypto（gen_random_uuid 用）が有効であること。念のため下で有効化する。
--
-- 適用方法（例）：
--   1) Supabase SQL Editor にこのファイルの内容を貼り付けて実行、または
--   2) psql "$SUPABASE_DB_URL" -f supabase/career_gd_match_queue_apply.sql
-- ============================================================

-- ------------------------------------------------------------
-- 0) 拡張（gen_random_uuid 用）。既に有効なら何もしない。
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) career_gd_match_queue — 待機キュー本体。
--    人数別キュー（4/6/8）は planned_count 列で表現する（テーブルは 1 本）。
--      status: waiting → matched（room 成立）/ cancelled（本人取消）/ expired（期限切れ）
--    room_id は matched 後に成立 room を指す。cancelled/expired は NULL のまま。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.career_gd_match_queue (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  planned_count integer     NOT NULL,
  status        text        NOT NULL DEFAULT 'waiting',
  room_id       uuid        REFERENCES public.career_gd_rooms(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  matched_at    timestamptz,
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  CONSTRAINT career_gd_match_queue_planned_count_chk
    CHECK (planned_count IN (4, 6, 8)),
  CONSTRAINT career_gd_match_queue_status_chk
    CHECK (status IN ('waiting', 'matched', 'cancelled', 'expired'))
);

-- 同一 user は waiting 行を同時に 1 つしか持てない（二重参加・二重キュー投入を防ぐ）。
CREATE UNIQUE INDEX IF NOT EXISTS career_gd_match_queue_one_waiting_per_user
  ON public.career_gd_match_queue (user_id)
  WHERE status = 'waiting';

-- マッチング取り出し用（人数別・先着順）。waiting のみを対象にした部分インデックス。
CREATE INDEX IF NOT EXISTS career_gd_match_queue_waiting_pick_idx
  ON public.career_gd_match_queue (planned_count, created_at)
  WHERE status = 'waiting';

-- 本人の最新行取得用。
CREATE INDEX IF NOT EXISTS career_gd_match_queue_user_idx
  ON public.career_gd_match_queue (user_id, created_at DESC);

-- updated_at 自動更新トリガ（既存 set_updated_at() を再利用。無ければ作成側 SQL に依存）。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at')
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger WHERE tgname = 'career_gd_match_queue_set_updated_at'
     ) THEN
    CREATE TRIGGER career_gd_match_queue_set_updated_at
      BEFORE UPDATE ON public.career_gd_match_queue
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2) RLS：既存 career_gd_* と同じ deny-by-default（許可ポリシーを付けない）。
--    クライアントから career_gd_match_queue を直接叩かせない（API ゲートウェイ方式）。
--    将来 authenticated に「自分の queue のみ SELECT」を許す場合は、下のコメントの
--    GRANT + owner-select policy を運用者が適用する（本 STEP では適用しない）。
-- ------------------------------------------------------------
ALTER TABLE public.career_gd_match_queue ENABLE ROW LEVEL SECURITY;

-- ↓将来 authenticated 直読みを有効化するとき用（本 STEP では適用しない）：
--   GRANT SELECT ON public.career_gd_match_queue TO authenticated;
--   CREATE POLICY career_gd_match_queue_owner_select
--     ON public.career_gd_match_queue FOR SELECT TO authenticated
--     USING (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 3) 内部関数 career_gd_match_try(p_planned_count, p_min_wait_sec, p_min_humans)
--    指定人数の waiting キューから成立可能なら room を作る。呼び出し側で advisory lock 済み前提。
--
--    成立条件（どちらか）：
--      (A) 人間の待機者が planned_count に達した（満員成立）。
--      (B) 人間 >= p_min_humans（既定 2）かつ 最古の待機者が p_min_wait_sec 以上待った
--          （AI 補完前提の早期成立。ソロ化を防ぐため 1 人だけでは成立させない）。
--
--    成立時：
--      - career_gd_rooms を room_type='random_match' / join_policy='matched_only' /
--        status='waiting' で作成（planned は p_planned_count）。
--      - host = 最古の待機者（created_at 最小）。
--      - 選ばれた user を career_gd_room_members に追加（human / 非AI）。
--      - 選ばれた queue 行を matched + room_id + matched_at に更新。
--      - 不足分の AI 補完は既存 host start 処理に委譲（ここでは AI を入れない）。
--
--    FOR UPDATE SKIP LOCKED により、同時 enter でも同じ待機者を二重に掴まない
--    （＝二重 room 作成・定員超過が起きない）。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_gd_match_try(
  p_planned_count integer,
  p_min_wait_sec  integer,
  p_min_humans    integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids        uuid[];
  v_users      uuid[];
  v_oldest     timestamptz;
  v_human      int;
  v_ready      boolean;
  v_room_id    uuid;
  v_now        timestamptz := now();
  i            int;
BEGIN
  -- 期限切れの待機行を expired にする（最低限の stale cleanup）。
  UPDATE public.career_gd_match_queue
     SET status = 'expired', updated_at = v_now
   WHERE planned_count = p_planned_count
     AND status = 'waiting'
     AND expires_at <= v_now;

  -- 先着順に最大 planned_count 件の待機者を掴む（他 tx が掴んだ行はスキップ）。
  SELECT array_agg(q.id ORDER BY q.created_at),
         array_agg(q.user_id ORDER BY q.created_at),
         min(q.created_at)
    INTO v_ids, v_users, v_oldest
    FROM (
      SELECT id, user_id, created_at
        FROM public.career_gd_match_queue
       WHERE planned_count = p_planned_count
         AND status = 'waiting'
         AND expires_at > v_now
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT p_planned_count
    ) q;

  v_human := COALESCE(array_length(v_ids, 1), 0);
  IF v_human = 0 THEN
    RETURN NULL;
  END IF;

  -- 成立判定：満員 or（最小人間数＋待機時間）。
  v_ready :=
    (v_human >= p_planned_count)
    OR (v_human >= GREATEST(p_min_humans, 2)
        AND v_oldest <= v_now - make_interval(secs => GREATEST(p_min_wait_sec, 0)));

  IF NOT v_ready THEN
    RETURN NULL;
  END IF;

  -- room 作成（host = 最古の待機者）。合言葉は持たない（'rnd_'+UUID は既存 join に乗らない）。
  v_room_id := gen_random_uuid();
  INSERT INTO public.career_gd_rooms (
    id, host_user_id, status, format, theme, time_limit_sec,
    planned_participant_count, join_code_hash, code_expires_at, room_type, join_policy
  ) VALUES (
    v_room_id, v_users[1], 'waiting', 'free', '{}'::jsonb, 900,
    p_planned_count, 'rnd_' || v_room_id::text, v_now, 'random_match', 'matched_only'
  );

  -- 選ばれた user を room members に追加（human / 非AI / 最古が host）。
  FOR i IN 1 .. v_human LOOP
    INSERT INTO public.career_gd_room_members (
      room_id, user_id, is_ai, is_host, participant_id, display_name, role
    ) VALUES (
      v_room_id,
      v_users[i],
      false,
      (i = 1),
      'gduser-' || gen_random_uuid()::text,
      'メンバー',
      'member'
    );
  END LOOP;

  -- 掴んだ queue 行を matched に更新（room_id で成立 room を指す）。
  UPDATE public.career_gd_match_queue
     SET status = 'matched', room_id = v_room_id, matched_at = v_now, updated_at = v_now
   WHERE id = ANY(v_ids);

  RETURN v_room_id;
END;
$$;

-- ------------------------------------------------------------
-- 4) career_gd_match_enter(p_user_id, p_planned_count, p_min_wait_sec, p_min_humans)
--    キュー投入＋マッチング試行。冪等（既に matched/waiting なら再利用）。
--    戻り値 jsonb：
--      { status:'matched',  room_id: uuid }
--      { status:'waiting',  queue_id: uuid, planned_count: int, waiting_count: int }
--    例外：'INVALID_COUNT'（planned_count が 4/6/8 以外）。
--
--    p_user_id は API 側で必ず認証済み session.user.id を渡す（body から受け取らない）。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_gd_match_enter(
  p_user_id       uuid,
  p_planned_count integer,
  p_min_wait_sec  integer DEFAULT NULL,
  p_min_humans    integer DEFAULT 2
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wait     int;
  v_room_id  uuid;
  v_queue_id uuid;
  v_row      public.career_gd_match_queue;
  v_count    int;
BEGIN
  IF p_planned_count NOT IN (4, 6, 8) THEN
    RAISE EXCEPTION 'INVALID_COUNT';
  END IF;

  -- 待機時間しきい値：override 未指定なら人数別（4→30s / 6→45s / 8→60s）。
  v_wait := COALESCE(
    p_min_wait_sec,
    CASE p_planned_count WHEN 4 THEN 30 WHEN 6 THEN 45 WHEN 8 THEN 60 ELSE 30 END
  );

  -- 人数バケット単位で直列化（4/6/8 は独立ロック）。tx 終了で自動解放。
  PERFORM pg_advisory_xact_lock(hashtext('career_gd_match:' || p_planned_count::text));

  -- 既に成立済み（この user の matched 行）があれば冪等にそれを返す。
  SELECT * INTO v_row
    FROM public.career_gd_match_queue
   WHERE user_id = p_user_id AND status = 'matched' AND room_id IS NOT NULL
   ORDER BY matched_at DESC NULLS LAST, created_at DESC
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'matched', 'room_id', v_row.room_id);
  END IF;

  -- 別人数の waiting 行が残っていれば cancel（人数切替＝1 waiting/user を保つ）。
  UPDATE public.career_gd_match_queue
     SET status = 'cancelled', updated_at = now()
   WHERE user_id = p_user_id
     AND status = 'waiting'
     AND planned_count <> p_planned_count;

  -- 同人数の waiting 行があれば再利用、無ければ insert（冪等）。
  SELECT id INTO v_queue_id
    FROM public.career_gd_match_queue
   WHERE user_id = p_user_id AND status = 'waiting' AND planned_count = p_planned_count
   LIMIT 1;
  IF v_queue_id IS NULL THEN
    INSERT INTO public.career_gd_match_queue (user_id, planned_count, status)
    VALUES (p_user_id, p_planned_count, 'waiting')
    RETURNING id INTO v_queue_id;
  END IF;

  -- マッチング試行。成立すれば本人の行も matched になる。
  v_room_id := public.career_gd_match_try(p_planned_count, v_wait, GREATEST(p_min_humans, 2));

  -- 本人の行を読み直す。
  SELECT * INTO v_row
    FROM public.career_gd_match_queue
   WHERE id = v_queue_id;

  IF v_row.status = 'matched' AND v_row.room_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'matched', 'room_id', v_row.room_id);
  END IF;

  -- まだ waiting：同人数の waiting 待機者数を返す。
  SELECT count(*) INTO v_count
    FROM public.career_gd_match_queue
   WHERE planned_count = p_planned_count AND status = 'waiting' AND expires_at > now();

  RETURN jsonb_build_object(
    'status', 'waiting',
    'queue_id', v_queue_id,
    'planned_count', p_planned_count,
    'waiting_count', v_count
  );
END;
$$;

-- ------------------------------------------------------------
-- 5) career_gd_match_poll(p_user_id, p_min_wait_sec, p_min_humans)
--    本人の最新キュー行の状態を返す。waiting のときは（新規 enter が無くても）
--    マッチング試行を回して成立を進める＝polling で成立に収束する。
--    戻り値 jsonb：
--      { status:'matched',   room_id }
--      { status:'waiting',   queue_id, planned_count, waiting_count }
--      { status:'cancelled' } / { status:'expired' } / { status:'none' }
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_gd_match_poll(
  p_user_id      uuid,
  p_min_wait_sec integer DEFAULT NULL,
  p_min_humans   integer DEFAULT 2
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row     public.career_gd_match_queue;
  v_wait    int;
  v_count   int;
BEGIN
  -- 本人の最新行。
  SELECT * INTO v_row
    FROM public.career_gd_match_queue
   WHERE user_id = p_user_id
   ORDER BY created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'none');
  END IF;

  IF v_row.status = 'matched' AND v_row.room_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'matched', 'room_id', v_row.room_id);
  END IF;
  IF v_row.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'cancelled');
  END IF;
  IF v_row.status = 'expired' THEN
    RETURN jsonb_build_object('status', 'expired');
  END IF;

  -- waiting：期限切れなら expired にして返す。
  IF v_row.expires_at <= now() THEN
    UPDATE public.career_gd_match_queue
       SET status = 'expired', updated_at = now()
     WHERE id = v_row.id AND status = 'waiting';
    RETURN jsonb_build_object('status', 'expired');
  END IF;

  v_wait := COALESCE(
    p_min_wait_sec,
    CASE v_row.planned_count WHEN 4 THEN 30 WHEN 6 THEN 45 WHEN 8 THEN 60 ELSE 30 END
  );

  -- バケット単位で直列化してマッチング試行。
  PERFORM pg_advisory_xact_lock(hashtext('career_gd_match:' || v_row.planned_count::text));
  PERFORM public.career_gd_match_try(v_row.planned_count, v_wait, GREATEST(p_min_humans, 2));

  -- 試行後に本人行を読み直す。
  SELECT * INTO v_row FROM public.career_gd_match_queue WHERE id = v_row.id;
  IF v_row.status = 'matched' AND v_row.room_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'matched', 'room_id', v_row.room_id);
  END IF;

  SELECT count(*) INTO v_count
    FROM public.career_gd_match_queue
   WHERE planned_count = v_row.planned_count AND status = 'waiting' AND expires_at > now();

  RETURN jsonb_build_object(
    'status', 'waiting',
    'queue_id', v_row.id,
    'planned_count', v_row.planned_count,
    'waiting_count', v_count
  );
END;
$$;

-- ------------------------------------------------------------
-- 6) career_gd_match_cancel(p_user_id)
--    本人の waiting 行を cancelled にする（matched 後は対象外＝room へ移動済み）。
--    戻り値 jsonb：{ cancelled: int }（取り消した行数）。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_gd_match_cancel(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.career_gd_match_queue
     SET status = 'cancelled', updated_at = now()
   WHERE user_id = p_user_id AND status = 'waiting';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('cancelled', v_n);
END;
$$;

-- ------------------------------------------------------------
-- 7) 実行権限：service_role のみ（anon / authenticated には付与しない）。
--    career_gd_match_try は enter/poll から呼ばれる内部関数だが、明示的に service_role のみに絞る。
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.career_gd_match_try(integer, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_match_try(integer, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.career_gd_match_enter(uuid, integer, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_match_enter(uuid, integer, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.career_gd_match_poll(uuid, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_match_poll(uuid, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.career_gd_match_cancel(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_match_cancel(uuid) TO service_role;

-- ============================================================
-- 適用後の簡易確認（任意）：
--   SELECT to_regclass('public.career_gd_match_queue');            -- テーブル存在
--   SELECT proname FROM pg_proc
--    WHERE proname IN ('career_gd_match_try','career_gd_match_enter',
--                      'career_gd_match_poll','career_gd_match_cancel');
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'career_gd_match_queue';
-- ============================================================

-- 以上。既存 SQL を壊さず、完全ランダムマッチ用の queue + RPC だけを足した。

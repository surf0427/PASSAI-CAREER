-- ============================================================
-- PASSAI 就活版 — GD 完全ランダムマッチ 適用スクリプト（STEP-GD-21 / DB 層・reconciled）
-- career_gd_match_queue_apply.sql
--
-- 目的：
--   既存のマルチGD room 基盤（career_gd_multi_apply.sql）＋公開ロビー
--   （career_gd_public_lobby_apply.sql）を土台に、「完全ランダムマッチ」を支える
--   DB 追加要素を足す。
--     - 待機キュー用テーブル career_gd_match_queue（4/6/8 別・人数は planned_count 列で分ける）
--     - 同一 user が同時に複数の waiting 行を持てない部分ユニークインデックス
--     - マッチング RPC（enter / poll / cancel / try / expire_stale）。満員レース・二重 room 作成・
--       二重参加を advisory lock + FOR UPDATE SKIP LOCKED で原子的に防ぐ。
--
-- ※ reconciled 版（STEP-GD-21 実DB QA 時）：
--   先行適用されていた参照実装に「room 作成時に career_gd_rooms.planned_count（存在しない列）へ
--   INSERT していて room 生成が必ず失敗する」致命バグがあったため、**正しい列
--   planned_participant_count を使う実装に修正**し、旧シグネチャを DROP して置き換える形にした。
--   RPC の公開契約（呼び出し名・戻り値の camelCase キー・enter/poll/cancel/try/expire_stale の
--   構成）は先行実装に合わせてある（アプリ側もこの契約に合わせて呼ぶ）。
--
-- 方針／制約：
--   - 冪等（再実行安全）: DROP FUNCTION IF EXISTS で旧シグネチャを掃除してから CREATE。
--     テーブル/インデックスは IF NOT EXISTS。GRANT は no-op 再実行安全。
--   - 既存 career_gd_multi_apply.sql / career_gd_public_lobby_apply.sql を壊さない（追加のみ）。
--   - localStorage 版（Phase1）・受験版には無関係。
--   - RLS は deny-by-default（許可ポリシー無し）。DB 操作は service-role（API ルート）に限定。
--     テーブル権限は既存 career_gd_* と同様、service_role にのみ CRUD を付与する
--     （Supabase 既定では public テーブルへ service_role の default 権限が付かないため明示付与）。
--   - ランダムマッチ room も既存 career_gd_rooms を使う。合言葉は持たないが join_code_hash は
--     NOT NULL のため 'rnd_' + UUID（非 hex）を入れる。'rnd_' 始まりは HMAC(64桁hex) と構造上
--     一致しないため合言葉 join には乗らない。room_type='random_match' / join_policy='matched_only'
--     により公開ロビー一覧（public_lobby 限定）にも出ない。
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
-- 1) career_gd_match_queue — 待機キュー本体。人数別キューは planned_count 列で表現する。
--      status: waiting → matched（room 成立）/ cancelled（本人取消）/ expired（期限切れ）
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
CREATE INDEX IF NOT EXISTS career_gd_match_queue_user_status_idx
  ON public.career_gd_match_queue (user_id, created_at DESC);

-- 成立 room からの参照引き用。
CREATE INDEX IF NOT EXISTS career_gd_match_queue_room_id_idx
  ON public.career_gd_match_queue (room_id);

-- updated_at 自動更新トリガ（既存 set_updated_at() を再利用。無ければスキップ）。
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
-- 2) RLS：deny-by-default（許可ポリシー無し）。テーブル権限は service_role のみ。
--    クライアントから career_gd_match_queue を直接叩かせない（API ゲートウェイ方式）。
-- ------------------------------------------------------------
ALTER TABLE public.career_gd_match_queue ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.career_gd_match_queue TO service_role;

-- ↓将来 authenticated 直読みを有効化するとき用（本 STEP では適用しない）：
--   GRANT SELECT ON public.career_gd_match_queue TO authenticated;
--   CREATE POLICY career_gd_match_queue_owner_select
--     ON public.career_gd_match_queue FOR SELECT TO authenticated
--     USING (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 旧シグネチャの掃除（reconciled 置換のため）。IF EXISTS で冪等。
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.career_gd_match_try(integer);
DROP FUNCTION IF EXISTS public.career_gd_match_try(integer, integer);
DROP FUNCTION IF EXISTS public.career_gd_match_try(integer, integer, integer);
DROP FUNCTION IF EXISTS public.career_gd_match_enter(uuid, integer);
DROP FUNCTION IF EXISTS public.career_gd_match_enter(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.career_gd_match_enter(uuid, integer, integer, integer);
DROP FUNCTION IF EXISTS public.career_gd_match_poll(uuid);
DROP FUNCTION IF EXISTS public.career_gd_match_poll(uuid, integer);
DROP FUNCTION IF EXISTS public.career_gd_match_poll(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.career_gd_match_cancel(uuid);
DROP FUNCTION IF EXISTS public.career_gd_match_expire_stale();

-- ------------------------------------------------------------
-- 3) career_gd_match_expire_stale() — 期限切れ waiting を expired にする（最低限の stale cleanup）。
--    戻り値：expired にした行数（integer）。cron 等から定期実行してもよい（本 STEP では enter/poll 内でも実施）。
-- ------------------------------------------------------------
CREATE FUNCTION public.career_gd_match_expire_stale()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.career_gd_match_queue
     SET status = 'expired', updated_at = now()
   WHERE status = 'waiting'
     AND expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ------------------------------------------------------------
-- 4) career_gd_match_try(p_planned_count, p_wait_override_sec) — 指定人数の待機キューから
--    成立可能なら room を作る。呼び出し側で advisory lock 済み前提でも単体でも動く（自分でも lock を取る）。
--
--    成立条件（どちらか）：
--      (A) 人間の待機者が planned_count に達した（満員成立）。
--      (B) 人間 >= 2（ソロ化防止）かつ 最古の待機者が threshold 秒以上待った（AI 補完前提の早期成立）。
--          threshold = COALESCE(p_wait_override_sec, 4→30 / 6→45 / 8→60)。
--
--    成立時：room を room_type='random_match' / join_policy='matched_only' /
--      planned_participant_count=p_planned_count / status='waiting' / host=最古の待機者 で作成し、
--      選ばれた user を members に追加、queue 行を matched に更新（不足分 AI は既存 host start に委譲）。
--
--    戻り値 jsonb（camelCase）：{ status:'waiting', plannedCount, waitingCount, thresholdSeconds, oldestWaitSeconds }
--      成立して room を作った場合も、当該人数の残待機に対する上記診断を返す（呼び出し側は本人行を読み直す）。
-- ------------------------------------------------------------
CREATE FUNCTION public.career_gd_match_try(
  p_planned_count     integer,
  p_wait_override_sec integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_threshold int;
  v_ids       uuid[];
  v_users     uuid[];
  v_oldest    timestamptz;
  v_human     int;
  v_ready     boolean;
  v_room_id   uuid;
  v_now       timestamptz := now();
  v_wait_left int;
  v_oldest_sec int;
  i           int;
BEGIN
  v_threshold := COALESCE(
    p_wait_override_sec,
    CASE p_planned_count WHEN 4 THEN 30 WHEN 6 THEN 45 WHEN 8 THEN 60 ELSE 30 END
  );

  -- 人数バケット単位で直列化（4/6/8 は独立ロック）。tx 終了で自動解放。
  PERFORM pg_advisory_xact_lock(hashtext('career_gd_match:' || p_planned_count::text));

  -- 期限切れの待機行を expired にする。
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
  v_oldest_sec := CASE WHEN v_oldest IS NULL THEN 0 ELSE floor(extract(epoch FROM (v_now - v_oldest)))::int END;

  IF v_human = 0 THEN
    RETURN jsonb_build_object('status', 'waiting', 'plannedCount', p_planned_count,
                              'waitingCount', 0, 'thresholdSeconds', v_threshold, 'oldestWaitSeconds', 0);
  END IF;

  v_ready :=
    (v_human >= p_planned_count)
    OR (v_human >= 2 AND v_oldest <= v_now - make_interval(secs => GREATEST(v_threshold, 0)));

  IF v_ready THEN
    -- room 作成（host = 最古の待機者）。**正しい列 planned_participant_count を使う**。
    v_room_id := gen_random_uuid();
    INSERT INTO public.career_gd_rooms (
      id, host_user_id, status, format, theme, time_limit_sec,
      planned_participant_count, join_code_hash, code_expires_at, room_type, join_policy
    ) VALUES (
      v_room_id, v_users[1], 'waiting', 'free', '{}'::jsonb, 900,
      p_planned_count, 'rnd_' || v_room_id::text, v_now, 'random_match', 'matched_only'
    );

    FOR i IN 1 .. v_human LOOP
      INSERT INTO public.career_gd_room_members (
        room_id, user_id, is_ai, is_host, participant_id, display_name, role
      ) VALUES (
        v_room_id, v_users[i], false, (i = 1),
        'gduser-' || gen_random_uuid()::text, 'メンバー', 'member'
      );
    END LOOP;

    UPDATE public.career_gd_match_queue
       SET status = 'matched', room_id = v_room_id, matched_at = v_now, updated_at = v_now
     WHERE id = ANY(v_ids);
  END IF;

  -- 当該人数の残 waiting 数（診断用）。
  SELECT count(*) INTO v_wait_left
    FROM public.career_gd_match_queue
   WHERE planned_count = p_planned_count AND status = 'waiting' AND expires_at > now();

  RETURN jsonb_build_object(
    'status', 'waiting',
    'plannedCount', p_planned_count,
    'waitingCount', v_wait_left,
    'thresholdSeconds', v_threshold,
    'oldestWaitSeconds', v_oldest_sec
  );
END;
$$;

-- ------------------------------------------------------------
-- 5) career_gd_match_enter(p_user_id, p_planned_count, p_wait_override_sec)
--    キュー投入＋マッチング試行。冪等（既に matched/waiting なら再利用）。
--    戻り値 jsonb（camelCase）：
--      { status:'matched',  roomId }
--      { status:'waiting',  queueId, plannedCount, waitingCount }
--    例外：'INVALID_COUNT'（planned_count が 4/6/8 以外）。
--    p_user_id は API 側で必ず session.user.id を渡す（body から受け取らない）。
-- ------------------------------------------------------------
CREATE FUNCTION public.career_gd_match_enter(
  p_user_id           uuid,
  p_planned_count     integer,
  p_wait_override_sec integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_room_id  uuid;
  v_queue_id uuid;
  v_row      public.career_gd_match_queue;
  v_count    int;
BEGIN
  IF p_planned_count NOT IN (4, 6, 8) THEN
    RAISE EXCEPTION 'INVALID_COUNT';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('career_gd_match:' || p_planned_count::text));

  -- 既に成立済み（この user の matched 行）があれば冪等にそれを返す。
  SELECT * INTO v_row
    FROM public.career_gd_match_queue
   WHERE user_id = p_user_id AND status = 'matched' AND room_id IS NOT NULL
   ORDER BY matched_at DESC NULLS LAST, created_at DESC
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'matched', 'roomId', v_row.room_id);
  END IF;

  -- 別人数の waiting 行が残っていれば cancel（1 waiting/user を保つ）。
  UPDATE public.career_gd_match_queue
     SET status = 'cancelled', updated_at = now()
   WHERE user_id = p_user_id AND status = 'waiting' AND planned_count <> p_planned_count;

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

  -- マッチング試行（同一 tx の advisory lock 下で実行）。
  PERFORM public.career_gd_match_try(p_planned_count, p_wait_override_sec);

  -- 本人の行を読み直す。
  SELECT * INTO v_row FROM public.career_gd_match_queue WHERE id = v_queue_id;
  IF v_row.status = 'matched' AND v_row.room_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'matched', 'roomId', v_row.room_id);
  END IF;

  SELECT count(*) INTO v_count
    FROM public.career_gd_match_queue
   WHERE planned_count = p_planned_count AND status = 'waiting' AND expires_at > now();

  RETURN jsonb_build_object(
    'status', 'waiting',
    'queueId', v_queue_id,
    'plannedCount', p_planned_count,
    'waitingCount', v_count
  );
END;
$$;

-- ------------------------------------------------------------
-- 6) career_gd_match_poll(p_user_id, p_wait_override_sec)
--    本人の最新キュー行の状態を返す。waiting のときはマッチング試行を回して成立に収束させる。
--    戻り値 jsonb（camelCase）：
--      { status:'matched',   roomId }
--      { status:'waiting',   queueId, plannedCount, waitingCount }
--      { status:'cancelled', queueId, plannedCount } / { status:'expired', queueId, plannedCount } / { status:'none' }
-- ------------------------------------------------------------
CREATE FUNCTION public.career_gd_match_poll(
  p_user_id           uuid,
  p_wait_override_sec integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row   public.career_gd_match_queue;
  v_count int;
BEGIN
  SELECT * INTO v_row
    FROM public.career_gd_match_queue
   WHERE user_id = p_user_id
   ORDER BY created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'none');
  END IF;

  IF v_row.status = 'matched' AND v_row.room_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'matched', 'roomId', v_row.room_id);
  END IF;
  IF v_row.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'cancelled', 'queueId', v_row.id, 'plannedCount', v_row.planned_count);
  END IF;
  IF v_row.status = 'expired' THEN
    RETURN jsonb_build_object('status', 'expired', 'queueId', v_row.id, 'plannedCount', v_row.planned_count);
  END IF;

  -- waiting：期限切れなら expired にして返す。
  IF v_row.expires_at <= now() THEN
    UPDATE public.career_gd_match_queue
       SET status = 'expired', updated_at = now()
     WHERE id = v_row.id AND status = 'waiting';
    RETURN jsonb_build_object('status', 'expired', 'queueId', v_row.id, 'plannedCount', v_row.planned_count);
  END IF;

  -- マッチング試行してから本人行を読み直す。
  PERFORM public.career_gd_match_try(v_row.planned_count, p_wait_override_sec);
  SELECT * INTO v_row FROM public.career_gd_match_queue WHERE id = v_row.id;
  IF v_row.status = 'matched' AND v_row.room_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'matched', 'roomId', v_row.room_id);
  END IF;

  SELECT count(*) INTO v_count
    FROM public.career_gd_match_queue
   WHERE planned_count = v_row.planned_count AND status = 'waiting' AND expires_at > now();

  RETURN jsonb_build_object(
    'status', 'waiting',
    'queueId', v_row.id,
    'plannedCount', v_row.planned_count,
    'waitingCount', v_count
  );
END;
$$;

-- ------------------------------------------------------------
-- 7) career_gd_match_cancel(p_user_id)
--    本人の waiting 行を cancelled にする（matched 後は対象外＝room へ移動済み）。
--    戻り値 jsonb：{ ok:true, cancelled:int }。
-- ------------------------------------------------------------
CREATE FUNCTION public.career_gd_match_cancel(
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
  RETURN jsonb_build_object('ok', true, 'cancelled', v_n);
END;
$$;

-- ------------------------------------------------------------
-- 8) 実行権限：service_role のみ（anon / authenticated には付与しない）。
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.career_gd_match_expire_stale() FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_match_expire_stale() TO service_role;

REVOKE ALL ON FUNCTION public.career_gd_match_try(integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_match_try(integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.career_gd_match_enter(uuid, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_match_enter(uuid, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.career_gd_match_poll(uuid, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_match_poll(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.career_gd_match_cancel(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_match_cancel(uuid) TO service_role;

-- ============================================================
-- 適用後の簡易確認（任意）：
--   SELECT to_regclass('public.career_gd_match_queue');
--   SELECT proname, pg_get_function_identity_arguments(oid)
--     FROM pg_proc WHERE proname LIKE 'career_gd_match_%';
-- ============================================================

-- 以上。reconciled：先行実装の列名バグ（planned_count）を planned_participant_count に修正し、
-- 公開契約（enter/poll/cancel/try/expire_stale・camelCase 戻り値）は維持した。

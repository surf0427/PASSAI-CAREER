-- ============================================================
-- career_gd_* Realtime / Presence / Server-Timer 基盤 DDL apply（STEP-GD-31）
--
-- 目的（既存 architecture を壊さずに不足だけ埋める）:
--   ① postgres_changes を **実配信** させる（publication + membership-scoped RLS）
--   ② participant の切断検知（last_seen_at / connection_state + sweep RPC）
--   ③ timer の server-side 強制（expiry を DB 側で atomic に判定して finished 化）
--
-- 【温存する既存契約（変更しない）】
--   - 「API ゲートウェイ方式」: mutation は service_role の API route のみ。
--     本 DDL は anon/authenticated へ **INSERT/UPDATE/DELETE を一切付与しない**。
--   - career_gd_room_results の owner-select（本人のみ）。他人の詳細 FB は読めない。
--   - 既存テーブル・制約・RPC・cleanup は不変（列追加と policy 追加のみ）。
--
-- 【Realtime を通すために security を弱めない】
--   authenticated へ与えるのは **SELECT のみ**、かつ
--     「自分が left_at IS NULL の member として在籍している room」に限る。
--   room UUID を知っているだけでは読めない（membership が必須）。
--   career_gd_rooms は **列単位 GRANT** で join_code_hash を除外する
--   （合言葉 hash を member にも渡さない）。
--   career_gd_room_results は publication に **入れない**（本人 FB を配信経路に載せない）。
--
-- 安全性:
--   - 再実行安全（idempotent）。CREATE ... IF NOT EXISTS / 存在チェック付き DO ブロック /
--     CREATE OR REPLACE FUNCTION。
--   - DROP TABLE / TRUNCATE / 既存データ削除・既存列の型変更は一切行わない。
--   - CAREER 専用 Supabase（Project B）に対してのみ適用する。受験版 Project A には適用しない。
--   - 前提: career_gd_multi_apply.sql / career_gd_public_lobby_apply.sql 適用済み。
-- ============================================================


-- ============================================================
-- ① presence 用の列追加（career_gd_room_members）
--
--   last_seen_at    : 参加者クライアントの heartbeat 最終到達時刻（server now）。
--   connection_state: 導出値を **永続化** したもの。理由は 2 つ:
--       (a) postgres_changes は「行が変わった」ときだけ発火する。導出のみだと
--           「B が落ちた」を他参加者へ realtime で伝えられない。
--       (b) sweep を 1 箇所（RPC）に閉じ込め、判定ロジックの散乱を防ぐ。
--
--   ★ disconnect ≠ leave。connection_state は left_at を書き換えない（別概念）。
--     モバイルの一時切断で参加者を退室させないための分離（grace period は sweep 側）。
-- ============================================================
ALTER TABLE public.career_gd_room_members
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE public.career_gd_room_members
  ADD COLUMN IF NOT EXISTS connection_state text NOT NULL DEFAULT 'online';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'career_gd_room_members_conn_state_chk'
  ) THEN
    ALTER TABLE public.career_gd_room_members
      ADD CONSTRAINT career_gd_room_members_conn_state_chk
      CHECK (connection_state IN ('online', 'disconnected', 'stale'));
  END IF;
END $$;

-- sweep が「期限切れの online/disconnected 行」だけを引くための index。
CREATE INDEX IF NOT EXISTS career_gd_room_members_presence_idx
  ON public.career_gd_room_members (room_id, connection_state, last_seen_at)
  WHERE left_at IS NULL;

-- AI 行は presence の対象外（常時在席）。既存行の初期化は行わない（NULL last_seen_at は
-- 「まだ heartbeat が来ていない」= sweep 側で joined_at を基準にする）。


-- ============================================================
-- ② membership 判定ヘルパー（RLS の再帰を断ち切る）
--
--   career_gd_room_members に対する SELECT policy の中で同じ表を参照すると
--   infinite recursion になる。SECURITY DEFINER 関数で RLS を迂回して判定する。
--   search_path を固定し、SECURITY DEFINER 関数の探索経路汚染を防ぐ。
--
--   判定: 「呼び出しユーザーが、その room に left_at IS NULL で在籍している」
--   → 退室後は room を読めなくなる（在籍中のみ購読可）。
-- ============================================================
CREATE OR REPLACE FUNCTION public.career_gd_is_room_member(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.career_gd_room_members m
     WHERE m.room_id = p_room_id
       AND m.user_id = auth.uid()
       AND m.left_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION public.career_gd_is_room_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.career_gd_is_room_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.career_gd_is_room_member(uuid) TO service_role;


-- ============================================================
-- ③ authenticated への **SELECT のみ** の最小 GRANT
--
--   career_gd_rooms は列単位。join_code_hash を **含めない**
--   （member であっても合言葉 hash は渡さない）。
--   列を増やしたときは、この GRANT にも追加しない限り realtime payload に載らない
--   （＝既定で漏れない側に倒れる）。
-- ============================================================
GRANT USAGE ON SCHEMA public TO authenticated;

GRANT SELECT (
  id, host_user_id, status, format, theme, time_limit_sec,
  planned_participant_count, code_expires_at, started_at, finished_at,
  created_at, updated_at, room_type, join_policy
) ON public.career_gd_rooms TO authenticated;

GRANT SELECT ON public.career_gd_room_members  TO authenticated;
GRANT SELECT ON public.career_gd_room_messages TO authenticated;
-- career_gd_room_results は既存の owner-select GRANT のまま（本 DDL では触らない）。


-- ============================================================
-- ④ membership-scoped SELECT policy（deny-by-default はそのまま維持）
--
--   INSERT / UPDATE / DELETE の policy は **一切作らない**。
--   よって authenticated は読み取り専用で、書き込みは従来どおり service_role API のみ。
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='career_gd_rooms'
      AND policyname='career_gd_rooms member select'
  ) THEN
    EXECUTE 'CREATE POLICY "career_gd_rooms member select"
             ON public.career_gd_rooms
             FOR SELECT TO authenticated
             USING (public.career_gd_is_room_member(id))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='career_gd_room_members'
      AND policyname='career_gd_room_members member select'
  ) THEN
    EXECUTE 'CREATE POLICY "career_gd_room_members member select"
             ON public.career_gd_room_members
             FOR SELECT TO authenticated
             USING (public.career_gd_is_room_member(room_id))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='career_gd_room_messages'
      AND policyname='career_gd_room_messages member select'
  ) THEN
    EXECUTE 'CREATE POLICY "career_gd_room_messages member select"
             ON public.career_gd_room_messages
             FOR SELECT TO authenticated
             USING (public.career_gd_is_room_member(room_id))';
  END IF;
END $$;


-- ============================================================
-- ⑤ Realtime publication
--
--   supabase_realtime へ 3 表だけ追加する。career_gd_room_results /
--   career_gd_match_queue は **追加しない**（本人 FB・待機列を配信経路に載せない）。
--
--   REPLICA IDENTITY:
--     - rooms / members は UPDATE が主で、購読側が `room_id=eq.` / `id=eq.` で filter する。
--       FULL にして OLD 行にも filter 対象列が載るようにする（DELETE / UPDATE の取りこぼし回避）。
--     - messages は append-only（INSERT のみ購読）。NEW 行に全列が載るため DEFAULT で足りる。
--       高頻度表なので WAL 肥大を避けて DEFAULT のままにする。
-- ============================================================
ALTER TABLE public.career_gd_rooms        REPLICA IDENTITY FULL;
ALTER TABLE public.career_gd_room_members REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    -- Supabase 標準環境では既存。無い環境（自前 Postgres 等）でも冪等に作る。
    EXECUTE 'CREATE PUBLICATION supabase_realtime';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='career_gd_rooms'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.career_gd_rooms';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='career_gd_room_members'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.career_gd_room_members';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='career_gd_room_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.career_gd_room_messages';
  END IF;
END $$;


-- ============================================================
-- ⑥ heartbeat RPC — 参加者の生存申告（service_role 経由でのみ呼ぶ）
--
--   冪等・低コスト。throttle は呼び出し側（API route）が行う。
--   ★ 復帰時は connection_state を 'online' へ戻す（reconnect の realtime 通知にもなる）。
--   ★ left_at が立っている行は触らない（退室者を蘇生させない）。
--   ★ 終端 room（finished / cancelled）でも row 更新自体は許す（表示整合のため）。
-- ============================================================
CREATE OR REPLACE FUNCTION public.career_gd_heartbeat(
  p_room_id uuid,
  p_user_id uuid
)
RETURNS career_gd_room_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row career_gd_room_members;
BEGIN
  UPDATE public.career_gd_room_members
     SET last_seen_at = now(),
         connection_state = 'online'
   WHERE room_id = p_room_id
     AND user_id = p_user_id
     AND left_at IS NULL
  RETURNING * INTO v_row;

  RETURN v_row;  -- 見つからなければ NULL 行（呼び出し側で 403/404 扱い）
END;
$$;

REVOKE ALL ON FUNCTION public.career_gd_heartbeat(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.career_gd_heartbeat(uuid, uuid) TO service_role;


-- ============================================================
-- ⑦ presence sweep RPC — grace period 付きの切断検知
--
--   online → disconnected : 最終 heartbeat から p_disconnect_sec 超過
--   disconnected → stale  : 最終 heartbeat から p_stale_sec 超過
--
--   ★ stale でも left_at は立てない（disconnect ≠ leave）。
--     「戻ってこられる」状態を保ち、再接続で online へ復帰する。
--     部屋自体の回収は既存 cron（waiting/active TTL）の責務のまま。
--   ★ AI 行（is_ai）は対象外。last_seen_at が NULL の行は joined_at を基準にする
--     （古いクライアントや heartbeat 未到達でも判定できる）。
--   ★ 終端 room（finished / cancelled）は sweep しない（終わった部屋の行を触らない）。
-- ============================================================
CREATE OR REPLACE FUNCTION public.career_gd_sweep_presence(
  p_room_id        uuid,
  p_disconnect_sec integer,
  p_stale_sec      integer
)
RETURNS TABLE (disconnected_count integer, stale_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_disc int := 0;
  v_stale int := 0;
BEGIN
  -- 終端 room は対象外。
  IF NOT EXISTS (
    SELECT 1 FROM public.career_gd_rooms
     WHERE id = p_room_id AND status IN ('waiting', 'active')
  ) THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  WITH upd AS (
    UPDATE public.career_gd_room_members m
       SET connection_state = 'stale'
     WHERE m.room_id = p_room_id
       AND m.is_ai = false
       AND m.left_at IS NULL
       AND m.connection_state <> 'stale'
       AND COALESCE(m.last_seen_at, m.joined_at) < now() - make_interval(secs => GREATEST(p_stale_sec, 0))
    RETURNING 1
  )
  SELECT count(*)::int INTO v_stale FROM upd;

  WITH upd AS (
    UPDATE public.career_gd_room_members m
       SET connection_state = 'disconnected'
     WHERE m.room_id = p_room_id
       AND m.is_ai = false
       AND m.left_at IS NULL
       AND m.connection_state = 'online'
       AND COALESCE(m.last_seen_at, m.joined_at) < now() - make_interval(secs => GREATEST(p_disconnect_sec, 0))
    RETURNING 1
  )
  SELECT count(*)::int INTO v_disc FROM upd;

  RETURN QUERY SELECT v_disc, v_stale;
END;
$$;

REVOKE ALL ON FUNCTION public.career_gd_sweep_presence(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.career_gd_sweep_presence(uuid, integer, integer) TO service_role;


-- ============================================================
-- ⑧ 全 room 横断の presence sweep（cron 用）
--
--   個別 room sweep は request 経路で行うが、誰も見ていない部屋も
--   最終的に整合させるため cron から全体を回す。
-- ============================================================
CREATE OR REPLACE FUNCTION public.career_gd_sweep_presence_all(
  p_disconnect_sec integer,
  p_stale_sec      integer
)
RETURNS TABLE (disconnected_count integer, stale_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_disc int := 0;
  v_stale int := 0;
BEGIN
  WITH upd AS (
    UPDATE public.career_gd_room_members m
       SET connection_state = 'stale'
      FROM public.career_gd_rooms r
     WHERE r.id = m.room_id
       AND r.status IN ('waiting', 'active')
       AND m.is_ai = false
       AND m.left_at IS NULL
       AND m.connection_state <> 'stale'
       AND COALESCE(m.last_seen_at, m.joined_at) < now() - make_interval(secs => GREATEST(p_stale_sec, 0))
    RETURNING 1
  )
  SELECT count(*)::int INTO v_stale FROM upd;

  WITH upd AS (
    UPDATE public.career_gd_room_members m
       SET connection_state = 'disconnected'
      FROM public.career_gd_rooms r
     WHERE r.id = m.room_id
       AND r.status IN ('waiting', 'active')
       AND m.is_ai = false
       AND m.left_at IS NULL
       AND m.connection_state = 'online'
       AND COALESCE(m.last_seen_at, m.joined_at) < now() - make_interval(secs => GREATEST(p_disconnect_sec, 0))
    RETURNING 1
  )
  SELECT count(*)::int INTO v_disc FROM upd;

  RETURN QUERY SELECT v_disc, v_stale;
END;
$$;

REVOKE ALL ON FUNCTION public.career_gd_sweep_presence_all(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.career_gd_sweep_presence_all(integer, integer) TO service_role;


-- ============================================================
-- ⑨ server-side timer enforcement — 期限切れ room の atomic finish
--
--   「host のクライアントが生きているか」に依存せず、**誰のリクエストでも**
--   期限切れを検知したら 1 回だけ finished 化できるようにする。
--
--   race 対策: 既存 finish route と同じ「status='active' 条件付き UPDATE」を
--   DB 側 1 文で行う。複数クライアントが同時に検知しても更新できるのは 1 つだけ。
--
--   時刻の正本は **DB の now()**（クライアント時計に一切依存しない）。
--   started_at が NULL の active room は対象外（理論上ありえないが安全側）。
-- ============================================================
CREATE OR REPLACE FUNCTION public.career_gd_finish_if_expired(p_room_id uuid)
RETURNS career_gd_rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row career_gd_rooms;
BEGIN
  UPDATE public.career_gd_rooms r
     SET status = 'finished',
         finished_at = now()
   WHERE r.id = p_room_id
     AND r.status = 'active'
     AND r.started_at IS NOT NULL
     AND r.started_at + make_interval(secs => r.time_limit_sec) <= now()
  RETURNING * INTO v_row;

  RETURN v_row;  -- NULL 行 = 期限内 or 既に他が finish 済み
END;
$$;

REVOKE ALL ON FUNCTION public.career_gd_finish_if_expired(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.career_gd_finish_if_expired(uuid) TO service_role;


-- ============================================================
-- ⑩ 全 room 横断の期限切れ finish（cron 用・host 不在でも必ず終わる保険）
-- ============================================================
CREATE OR REPLACE FUNCTION public.career_gd_finish_expired_all()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH upd AS (
    UPDATE public.career_gd_rooms r
       SET status = 'finished',
           finished_at = now()
     WHERE r.status = 'active'
       AND r.started_at IS NOT NULL
       AND r.started_at + make_interval(secs => r.time_limit_sec) <= now()
    RETURNING 1
  )
  SELECT count(*)::int INTO v_count FROM upd;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.career_gd_finish_expired_all() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.career_gd_finish_expired_all() TO service_role;


-- ============================================================
-- 適用後の確認クエリ（運用者用・read-only）
--
--   -- publication に 3 表が入ったか
--   SELECT tablename FROM pg_publication_tables
--    WHERE pubname='supabase_realtime' AND schemaname='public'
--      AND tablename LIKE 'career_gd_%' ORDER BY tablename;
--
--   -- policy が付いたか
--   SELECT tablename, policyname, cmd, roles FROM pg_policies
--    WHERE schemaname='public' AND tablename LIKE 'career_gd_%' ORDER BY tablename;
--
--   -- 列が増えたか
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='career_gd_room_members'
--      AND column_name IN ('last_seen_at','connection_state');
--
--   -- 非メンバーが読めないこと（別 user の JWT で実行して 0 行になること）
--   SELECT count(*) FROM career_gd_rooms;
-- ============================================================

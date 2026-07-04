-- ============================================================
-- PASSAI 就活版 — GD room timeout / abandon cleanup 適用スクリプト（STEP-GD-22 / DB 層）
-- career_gd_cleanup_apply.sql
--
-- 目的：
--   ランダムマッチ・公開ロビー・合言葉(invite) room で、本番運用時に放置された
--   room / queue / member / message が残り続けないようにする定期 cleanup RPC を足す。
--   **user-facing な履歴（career_gd_room_results）と、それを持つ room・finished room は消さない。**
--
-- 追加物（既存を壊さない・追加のみ）：
--   - career_gd_cleanup_abandoned_rooms(waiting_ttl_min, active_ttl_min, dry_run)
--       * 未開始のまま放置された waiting room（結果なし）を削除（＋紐づく match_queue 行）
--       * 開始後に放置された active room（結果なし）を cancelled に soft-close
--       * 既に cancelled で古い room（結果なし）を削除（soft-close の二段階目）
--   - career_gd_cleanup_stale_queue(ttl_days, dry_run)
--       * 終端状態（matched/cancelled/expired）の古い match_queue 行を削除
--   ※ waiting queue の期限切れ→expired は既存 career_gd_match_expire_stale() を使う（本ファイルは触らない）。
--
-- 方針／制約：
--   - 冪等（DROP FUNCTION IF EXISTS → CREATE）。SECURITY DEFINER・service_role のみ EXECUTE。
--   - **本番データを過剰削除しない**：
--       * status='finished' の room は一切触らない（完了済みセッション）。
--       * career_gd_room_results を持つ room は一切触らない（別デバイス hydrate の durable mirror）。
--       * 現在マッチング中の waiting queue 行（status='waiting'）は削除しない。
--   - dry_run=true は件数のみ返し、一切 mutate しない。
--   - random_match / public_lobby / invite は room_type で区別せず、上記の状態・TTL・結果有無だけで判定する
--     （どのモードでも「未開始で古い＝abandoned」「開始後放置＝stale」の扱いは同じ）。
--
-- 前提：career_gd_multi_apply.sql / career_gd_public_lobby_apply.sql /
--       career_gd_match_queue_apply.sql が適用済み。
-- 適用：Supabase SQL Editor に貼り付けて実行（psql -f も可）。
-- ============================================================

-- 旧シグネチャの掃除（冪等）。
DROP FUNCTION IF EXISTS public.career_gd_cleanup_abandoned_rooms(integer, integer, boolean);
DROP FUNCTION IF EXISTS public.career_gd_cleanup_stale_queue(integer, boolean);

-- ------------------------------------------------------------
-- 1) career_gd_cleanup_abandoned_rooms(p_waiting_ttl_min, p_active_ttl_min, p_dry_run)
--    戻り値 jsonb（camelCase）：
--      dry_run:  { dryRun:true,  abandonedWaiting, staleActive, cancelledRooms }
--      実行:     { dryRun:false, abandonedWaitingDeleted, staleActiveCancelled, cancelledRoomsDeleted, queueRowsDeleted }
-- ------------------------------------------------------------
CREATE FUNCTION public.career_gd_cleanup_abandoned_rooms(
  p_waiting_ttl_min integer DEFAULT 60,
  p_active_ttl_min  integer DEFAULT 180,
  p_dry_run         boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now         timestamptz := now();
  v_waiting_cut timestamptz := v_now - make_interval(mins => GREATEST(p_waiting_ttl_min, 0));
  v_active_cut  timestamptz := v_now - make_interval(mins => GREATEST(p_active_ttl_min, 0));
  v_abandoned   uuid[];
  v_cancelled   uuid[];
  v_stale       int := 0;
  v_del_waiting int := 0;
  v_del_cancel  int := 0;
  v_del_queue   int := 0;
  v_q           int := 0;
BEGIN
  -- 未開始で古い waiting room（結果を持たない）。
  SELECT array_agg(r.id) INTO v_abandoned
    FROM public.career_gd_rooms r
   WHERE r.status = 'waiting'
     AND r.created_at < v_waiting_cut
     AND NOT EXISTS (SELECT 1 FROM public.career_gd_room_results x WHERE x.room_id = r.id);

  -- 既に cancelled で古い room（結果を持たない）＝soft-close の二段階目・削除対象。
  SELECT array_agg(r.id) INTO v_cancelled
    FROM public.career_gd_rooms r
   WHERE r.status = 'cancelled'
     AND r.updated_at < v_waiting_cut
     AND NOT EXISTS (SELECT 1 FROM public.career_gd_room_results x WHERE x.room_id = r.id);

  IF p_dry_run THEN
    SELECT count(*) INTO v_stale
      FROM public.career_gd_rooms r
     WHERE r.status = 'active'
       AND r.started_at IS NOT NULL
       AND r.started_at < v_active_cut
       AND NOT EXISTS (SELECT 1 FROM public.career_gd_room_results x WHERE x.room_id = r.id);
    RETURN jsonb_build_object(
      'dryRun', true,
      'abandonedWaiting', COALESCE(array_length(v_abandoned, 1), 0),
      'staleActive', v_stale,
      'cancelledRooms', COALESCE(array_length(v_cancelled, 1), 0)
    );
  END IF;

  -- 開始後に放置された active room（結果なし）を soft-close（内容は消さず active から外す）。
  UPDATE public.career_gd_rooms r
     SET status = 'cancelled', finished_at = COALESCE(r.finished_at, v_now), updated_at = v_now
   WHERE r.status = 'active'
     AND r.started_at IS NOT NULL
     AND r.started_at < v_active_cut
     AND NOT EXISTS (SELECT 1 FROM public.career_gd_room_results x WHERE x.room_id = r.id);
  GET DIAGNOSTICS v_stale = ROW_COUNT;

  -- 未開始 waiting room を削除（紐づく match_queue 行 → room・cascade で members/messages も消える）。
  IF v_abandoned IS NOT NULL THEN
    DELETE FROM public.career_gd_match_queue WHERE room_id = ANY(v_abandoned);
    GET DIAGNOSTICS v_q = ROW_COUNT; v_del_queue := v_del_queue + v_q;
    DELETE FROM public.career_gd_rooms WHERE id = ANY(v_abandoned);
    GET DIAGNOSTICS v_del_waiting = ROW_COUNT;
  END IF;

  -- 古い cancelled room を削除（＋紐づく queue 行）。
  IF v_cancelled IS NOT NULL THEN
    DELETE FROM public.career_gd_match_queue WHERE room_id = ANY(v_cancelled);
    GET DIAGNOSTICS v_q = ROW_COUNT; v_del_queue := v_del_queue + v_q;
    DELETE FROM public.career_gd_rooms WHERE id = ANY(v_cancelled);
    GET DIAGNOSTICS v_del_cancel = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'dryRun', false,
    'abandonedWaitingDeleted', v_del_waiting,
    'staleActiveCancelled', v_stale,
    'cancelledRoomsDeleted', v_del_cancel,
    'queueRowsDeleted', v_del_queue
  );
END;
$$;

-- ------------------------------------------------------------
-- 2) career_gd_cleanup_stale_queue(p_ttl_days, p_dry_run)
--    終端状態（matched/cancelled/expired）の古い match_queue 行を削除（matchmaking bookkeeping）。
--    現在マッチング中の waiting 行は絶対に消さない。
--    戻り値 jsonb：dry_run { dryRun:true, terminalQueueRows } / 実行 { dryRun:false, terminalQueueRowsDeleted }
-- ------------------------------------------------------------
CREATE FUNCTION public.career_gd_cleanup_stale_queue(
  p_ttl_days integer DEFAULT 7,
  p_dry_run  boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cut timestamptz := now() - make_interval(days => GREATEST(p_ttl_days, 0));
  v_n   int;
BEGIN
  IF p_dry_run THEN
    SELECT count(*) INTO v_n
      FROM public.career_gd_match_queue
     WHERE status IN ('matched', 'cancelled', 'expired') AND updated_at < v_cut;
    RETURN jsonb_build_object('dryRun', true, 'terminalQueueRows', v_n);
  END IF;

  DELETE FROM public.career_gd_match_queue
   WHERE status IN ('matched', 'cancelled', 'expired') AND updated_at < v_cut;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('dryRun', false, 'terminalQueueRowsDeleted', v_n);
END;
$$;

-- ------------------------------------------------------------
-- 3) 実行権限：service_role のみ。
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.career_gd_cleanup_abandoned_rooms(integer, integer, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_cleanup_abandoned_rooms(integer, integer, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.career_gd_cleanup_stale_queue(integer, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.career_gd_cleanup_stale_queue(integer, boolean) TO service_role;

-- ============================================================
-- 適用後の確認（任意）：
--   SELECT proname, pg_get_function_identity_arguments(oid)
--     FROM pg_proc WHERE proname LIKE 'career_gd_cleanup_%';
--   -- dry-run（mutate しない）:
--   SELECT public.career_gd_cleanup_abandoned_rooms(60, 180, true);
--   SELECT public.career_gd_cleanup_stale_queue(7, true);
-- ============================================================

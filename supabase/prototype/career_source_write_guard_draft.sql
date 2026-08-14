-- ============================================================================
-- ⛔ DRAFT ONLY — DO NOT APPLY TO PRODUCTION（2026-08-14 hardening / `D-S3`）⛔
--
-- 目的: Layer 1 単一レコード系 mirror（career_profiles / career_activities / career_values）に
--   **server-authoritative な compare-and-set** を入れ、
--     「古い source snapshot が、より新しい server-visible mirror snapshot を上書きしない」
--   という write 整合性 invariant を成立させる draft。
--
-- ★ 本ファイルは production へ適用しない。理由:
--   1. conflict が起きたときの **解決ポリシー（merge / remote 優先 / local 優先）は product 判断**であり、
--      現行の「localStorage が端末ごとに canonical」という前提のままでは一意に決められない。
--      これは global multi-device consistency の設計（Option C 系）に踏み込む。
--   2. 6 つの writer と backfill / restore 経路の書き換えを伴う migration であり、
--      Data Spine hardening の最小修正の範囲を超える。
--   → よって現時点では **read 側の D-S1 veto** で安全性を担保し、write 整合性は
--     「未保証（既知の限界）」として `DATA_SPINE_DECISIONS.md` に明記する。
--
-- ★ 設計原則（既存 Data Spine 方針と一致）:
--   - service role を使わない。RLS を維持し、owner は常に auth.uid()。
--   - client の wall-clock を順序の権威にしない（server 採番の単調 seq を使う）。
--   - SECURITY DEFINER は「直接 UPDATE を許さず compare-and-set を強制する」ためだけに使い、
--     subject を引数で受け取らず auth.uid() へ束縛する（consent の D-A1 と同じ方針）。
--   - idempotent（IF NOT EXISTS / CREATE OR REPLACE）。
-- ============================================================================

-- ── 1) 単調 sequence 列を追加（追加のみ・既存行は 0 から開始）─────────────────
--   NOT NULL DEFAULT 0 なので既存行・既存 upsert を壊さない（未使用なら 0 のまま）。
ALTER TABLE career_profiles   ADD COLUMN IF NOT EXISTS source_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE career_activities ADD COLUMN IF NOT EXISTS source_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE career_values     ADD COLUMN IF NOT EXISTS source_seq bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN career_profiles.source_seq IS
  'D-S3 draft: server 採番の単調 write sequence。compare-and-set の基準。client 時刻は使わない。';

-- ── 2) compare-and-set RPC（subject は auth.uid() へ束縛）───────────────────
--   p_base_seq = client が読み取った時点の source_seq。
--   現在値と一致しなければ **書かずに conflict を返す**（＝別端末の書込を潰さない）。
CREATE OR REPLACE FUNCTION career_source_write_single(
  p_kind     text,     -- 'profile' | 'activity' | 'values'
  p_payload  jsonb,    -- 単一レコード系の全文書
  p_base_seq bigint    -- client が基にした seq（初回は 0）
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cur bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status','rejected','reason','unauthenticated');
  END IF;
  IF p_kind NOT IN ('profile','activity','values') THEN
    RETURN jsonb_build_object('status','rejected','reason','unknown_kind');
  END IF;

  -- subject 単位で直列化（career_gd_post_message / consent prototype と同方式）。
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_kind, 0));

  IF p_kind = 'profile' THEN
    SELECT source_seq INTO v_cur FROM career_profiles WHERE user_id = v_uid;
  ELSIF p_kind = 'activity' THEN
    SELECT source_seq INTO v_cur FROM career_activities WHERE user_id = v_uid;
  ELSE
    SELECT source_seq INTO v_cur FROM career_values WHERE user_id = v_uid;
  END IF;
  v_cur := COALESCE(v_cur, 0);

  -- ★ compare-and-set: 基にした seq が現在値と違う ＝ 別端末が先に書いた → 上書きしない。
  IF p_base_seq <> v_cur THEN
    RETURN jsonb_build_object('status','conflict','current_seq',v_cur);
  END IF;

  IF p_kind = 'profile' THEN
    INSERT INTO career_profiles (user_id, data, source_seq)
      VALUES (v_uid, p_payload, v_cur + 1)
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, source_seq = EXCLUDED.source_seq;
  ELSIF p_kind = 'activity' THEN
    INSERT INTO career_activities (user_id, data, source_seq)
      VALUES (v_uid, p_payload, v_cur + 1)
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, source_seq = EXCLUDED.source_seq;
  ELSE
    -- career_values は flat column 構成のため payload から展開する（draft では data 相当を想定）。
    RETURN jsonb_build_object('status','rejected','reason','values_shape_pending');
  END IF;

  RETURN jsonb_build_object('status','written','current_seq',v_cur + 1);
END;
$$;

-- 直接実行を PUBLIC から剥奪し、authenticated にだけ EXECUTE を与える。
--   ★ service_role は付与しない（D-L7 / D-A1 と一致）。subject は関数内で auth.uid() に固定される。
REVOKE ALL ON FUNCTION career_source_write_single(text, jsonb, bigint) FROM PUBLIC;
-- GRANT EXECUTE ON FUNCTION career_source_write_single(text, jsonb, bigint) TO authenticated;  -- 適用時に有効化

-- ============================================================================
-- Migration ordering（適用する場合）
--   1. 本 DDL の §1（列追加）のみ先に適用 — 既存 writer は source_seq を無視するので無影響。
--   2. client を「read seq → write with base_seq」へ書き換え、conflict 時の UI 挙動を実装。
--      ★ conflict 解決ポリシーの決定が前提（Human decision）。
--   3. §2 の RPC を適用し GRANT を有効化。
--   4. 単一レコード系 3 table の直接 UPDATE/INSERT を RLS policy から外し、RPC 経由のみにする。
--      （この段階まで来て初めて invariant が成立する。3 で止めると旧経路が残る。）
--
-- Rollback
--   - §2 まで: `DROP FUNCTION IF EXISTS career_source_write_single(text, jsonb, bigint);`
--     client を旧 upsert へ戻すだけ。データ影響なし。
--   - §1 の列: 残しても無害（DEFAULT 0・既存 upsert は触らない）。削除するなら
--     `ALTER TABLE ... DROP COLUMN IF EXISTS source_seq;`
--   - 4 まで進んだ後の rollback は RLS policy の復元が必要（適用前に policy 定義を控えること）。
--
-- ⛔ 再掲: 本ファイルは draft。production 適用は Human の architecture decision 後。
-- ============================================================================

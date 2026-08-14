-- ============================================================================
-- ⛔ PRODUCTION CANDIDATE — NOT APPLIED ⛔
--
-- PASSAI CAREER — Layer 5 contributor identity（strategy I2 / `D-R2`）。
--
-- auth.uid() ↔ opaque contributor key の対応表を作り、contribution 本体に
-- 識別子を入れないまま owner-scoped RLS を可能にする。
--
-- ★ 順序原則（RLS 安全性）:
--     CREATE TABLE → ENABLE RLS → CREATE POLICY → GRANT
--   GRANT を最後にすることで「保護なしで公開される瞬間」を作らない。
--
-- 適用条件: supabase/migrations_pending/README.md の 5 条件をすべて満たすこと。
-- ============================================================================

BEGIN;

-- ── 1. subject 対応表 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_ck_contributor_subjects (
  auth_user_id  uuid        NOT NULL,
  opaque_key    text        NOT NULL,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  -- unlink すると opaque key を解決できなくなる ＝ contribution は再識別不能になる。
  unlinked_at   timestamptz,
  policy_version integer    NOT NULL DEFAULT 1,
  CONSTRAINT career_ck_contributor_subjects_pk PRIMARY KEY (auth_user_id),
  CONSTRAINT career_ck_contributor_subjects_opaque_uniq UNIQUE (opaque_key),
  CONSTRAINT career_ck_contributor_subjects_opaque_chk CHECK (length(opaque_key) > 0),
  -- ★ auth.users への FK は **ON DELETE を意図的に指定しない**（RESTRICT 既定）。
  --   アカウント削除時に対応表を消すか unlink に留めるかは H-L5 の法務判断。
  --   自動 CASCADE を今ここで確定しない。
  CONSTRAINT career_ck_contributor_subjects_user_fk
    FOREIGN KEY (auth_user_id) REFERENCES auth.users (id)
);

COMMENT ON TABLE career_ck_contributor_subjects IS
  'Layer5 identity strategy I2: auth.uid() <-> opaque contributor key. Contribution rows never store auth user id. Unlinking makes contributions non-re-identifiable.';

CREATE INDEX IF NOT EXISTS career_ck_contributor_subjects_active_idx
  ON career_ck_contributor_subjects (auth_user_id) WHERE unlinked_at IS NULL;

-- ── 2. RLS 有効化（★ GRANT より前）────────────────────────────────
ALTER TABLE career_ck_contributor_subjects ENABLE ROW LEVEL SECURITY;

-- ── 3. policy（本人のみ自分の行を SELECT）──────────────────────────
DROP POLICY IF EXISTS "career_ck_subjects owner select" ON career_ck_contributor_subjects;
CREATE POLICY "career_ck_subjects owner select"
  ON career_ck_contributor_subjects
  FOR SELECT TO authenticated
  USING (auth.uid() = auth_user_id);

-- ⚠ INSERT / UPDATE / DELETE policy は **作らない**。
--   対応表の作成・unlink は下記 RPC 経由（auth.uid() 束縛）のみ。

-- ── 4. GRANT（★ 最後）─────────────────────────────────────────────
GRANT SELECT ON career_ck_contributor_subjects TO authenticated;
-- anon には一切付与しない。

-- ── 5. RPC（auth.uid() から subject を導出。caller-selected uuid を受け付けない）──
CREATE OR REPLACE FUNCTION career_ck_ensure_subject()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_key text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'LOGIN_REQUIRED';
  END IF;
  -- ★ subject は必ず auth.uid() から導出する。引数を取らない設計にしてある。
  SELECT opaque_key INTO v_key
    FROM career_ck_contributor_subjects
   WHERE auth_user_id = v_uid AND unlinked_at IS NULL;
  IF v_key IS NOT NULL THEN
    RETURN v_key;
  END IF;
  -- unlink 済みの行がある場合は新しい key を作らない（撤回の意思を尊重する）。
  IF EXISTS (SELECT 1 FROM career_ck_contributor_subjects WHERE auth_user_id = v_uid) THEN
    RAISE EXCEPTION 'CONTRIBUTION_WITHDRAWN';
  END IF;
  v_key := encode(gen_random_bytes(16), 'hex');
  INSERT INTO career_ck_contributor_subjects (auth_user_id, opaque_key)
       VALUES (v_uid, v_key);
  RETURN v_key;
END $$;

REVOKE ALL ON FUNCTION career_ck_ensure_subject() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION career_ck_ensure_subject() TO authenticated;

-- ── 6. 撤回（unlink）──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION career_ck_unlink_subject()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'LOGIN_REQUIRED';
  END IF;
  UPDATE career_ck_contributor_subjects
     SET unlinked_at = now()
   WHERE auth_user_id = v_uid AND unlinked_at IS NULL;
  -- ★ unlink 後は opaque key を解決できない ＝ 新規寄与を作れない（future blocked）。
  --   既存 contribution 本体はここでは触らない（既 publish の扱いは H-L5 / 法務判断）。
END $$;

REVOKE ALL ON FUNCTION career_ck_unlink_subject() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION career_ck_unlink_subject() TO authenticated;

COMMIT;

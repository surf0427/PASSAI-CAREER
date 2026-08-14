-- ============================================================================
-- ⛔ PRODUCTION CANDIDATE — NOT APPLIED ⛔
--
-- PASSAI CAREER — Consent policy manifest + append-only ledger（production 形）。
--
-- `supabase/prototype/consent_local_prototype.sql` は local 検証用で、
-- subject FK / retention が未確定のまま subject_user_id を FK なし uuid で持っていた。
-- 本 candidate はそれを production 形へ整える。
--
-- ★ 設計（P14-D で GO 済み・Option 2）:
--     append-only ledger / subject-scoped monotonic sequence / idempotency /
--     owner RLS / **direct client INSERT 禁止** / 現在状態は derived（table 化しない）
--
-- ★ 順序: CREATE TABLE → ENABLE RLS → CREATE POLICY → GRANT。
-- ============================================================================

BEGIN;

-- ── 1. policy manifest（どの scope の何 version が有効か）──────────────
CREATE TABLE IF NOT EXISTS career_consent_policies (
  scope               text        NOT NULL,
  consent_version     integer     NOT NULL,
  notice_version      text        NOT NULL,
  policy_digest       text        NOT NULL,
  legal_review_status text        NOT NULL DEFAULT 'REQUIRED',
  active              boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_consent_policies_pk PRIMARY KEY (scope, consent_version),
  CONSTRAINT career_consent_policies_scope_chk CHECK (scope IN (
    'personal_service_processing',
    'internal_aggregated_analytics',
    'user_facing_aggregated_insight',
    'ai_context_aggregated_insight',
    'externally_shared_insight',
    'company_knowledge_contribution'
  )),
  CONSTRAINT career_consent_policies_ver_chk    CHECK (consent_version >= 1),
  CONSTRAINT career_consent_policies_notice_chk CHECK (length(notice_version) > 0),
  CONSTRAINT career_consent_policies_digest_chk CHECK (length(policy_digest) > 0),
  CONSTRAINT career_consent_policies_legal_chk  CHECK (legal_review_status IN ('REQUIRED','PENDING','APPROVED'))
);

-- scope ごとに active は最大 1 つ。
CREATE UNIQUE INDEX IF NOT EXISTS career_consent_policies_active_uniq
  ON career_consent_policies (scope) WHERE active;

COMMENT ON TABLE career_consent_policies IS
  'Consent policy manifest. legal_review_status must be APPROVED before the scope can be used in production.';

ALTER TABLE career_consent_policies ENABLE ROW LEVEL SECURITY;
-- 本人が「自分が同意した policy の version / notice」を確認できるよう SELECT のみ許可。
DROP POLICY IF EXISTS "career_consent_policies read" ON career_consent_policies;
CREATE POLICY "career_consent_policies read"
  ON career_consent_policies FOR SELECT TO authenticated USING (true);

-- ── 2. append-only ledger ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS career_consent_ledger (
  subject_user_id  uuid        NOT NULL,
  seq              bigint      NOT NULL,
  action           text        NOT NULL,
  scope            text        NOT NULL,
  consent_version  integer,
  notice_version   text,
  policy_digest    text,
  -- idempotency（同一 client 再送を二重記録しない）。
  idempotency_key  text        NOT NULL,
  payload_digest   text        NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_consent_ledger_pk PRIMARY KEY (subject_user_id, seq),
  CONSTRAINT career_consent_ledger_seq_chk CHECK (seq >= 1),
  CONSTRAINT career_consent_ledger_action_chk CHECK (action IN (
    'consent_granted','consent_withdrawn','consent_reconfirmed',
    'consent_policy_superseded','account_deletion_requested','account_deleted'
  )),
  -- ★ auth.users への FK。ON DELETE は指定しない（RESTRICT 既定）。
  --   同意証跡をアカウント削除で消すかは法務判断（H-L7）であり、ここで確定しない。
  CONSTRAINT career_consent_ledger_user_fk
    FOREIGN KEY (subject_user_id) REFERENCES auth.users (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS career_consent_ledger_idem_uniq
  ON career_consent_ledger (subject_user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS career_consent_ledger_scope_idx
  ON career_consent_ledger (subject_user_id, scope, seq DESC);

COMMENT ON TABLE career_consent_ledger IS
  'Append-only consent ledger. Current state is DERIVED (never stored). No IP / user-agent / free text (see PROHIBITED_EVIDENCE_FIELDS).';

ALTER TABLE career_consent_ledger ENABLE ROW LEVEL SECURITY;

-- 本人のみ自分の証跡を読める。
DROP POLICY IF EXISTS "career_consent_ledger owner select" ON career_consent_ledger;
CREATE POLICY "career_consent_ledger owner select"
  ON career_consent_ledger FOR SELECT TO authenticated
  USING (auth.uid() = subject_user_id);

-- ⚠ INSERT / UPDATE / DELETE policy は **作らない**（append は RPC 経由のみ）。
--   これにより append-only が RLS レベルで担保される。

-- ── 3. GRANT（★ 最後）─────────────────────────────────────────────
GRANT SELECT ON career_consent_policies TO authenticated;
GRANT SELECT ON career_consent_ledger   TO authenticated;
-- anon には一切付与しない。

-- ── 4. append RPC（auth.uid() 束縛・subject-scoped monotonic seq）────
CREATE OR REPLACE FUNCTION career_consent_append(
  p_action          text,
  p_scope           text,
  p_consent_version integer,
  p_notice_version  text,
  p_policy_digest   text,
  p_idempotency_key text,
  p_payload_digest  text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_seq bigint;
  v_existing bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'LOGIN_REQUIRED';
  END IF;
  -- ★ subject は **必ず auth.uid()**。引数に user id を取らない（caller-selected 禁止）。

  -- idempotency: 同じ key が既にあればその seq を返す（二重記録しない）。
  SELECT seq INTO v_existing
    FROM career_consent_ledger
   WHERE subject_user_id = v_uid AND idempotency_key = p_idempotency_key;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- subject 単位の advisory lock で seq の競合を防ぐ（career_gd_post_message と同方式）。
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq
    FROM career_consent_ledger WHERE subject_user_id = v_uid;

  INSERT INTO career_consent_ledger (
    subject_user_id, seq, action, scope, consent_version,
    notice_version, policy_digest, idempotency_key, payload_digest
  ) VALUES (
    v_uid, v_seq, p_action, p_scope, p_consent_version,
    p_notice_version, p_policy_digest, p_idempotency_key, p_payload_digest
  );
  RETURN v_seq;
END $$;

REVOKE ALL ON FUNCTION career_consent_append(text,text,integer,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION career_consent_append(text,text,integer,text,text,text,text) TO authenticated;

COMMIT;

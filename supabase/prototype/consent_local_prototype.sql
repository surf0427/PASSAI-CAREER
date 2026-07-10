-- ============================================================================
-- ⛔ LOCAL PROTOTYPE ONLY — DO NOT APPLY TO PRODUCTION SUPABASE (P14-E) ⛔
--
-- 本ファイルは P14-D でGO判定された同意永続化設計を **local Supabase / synthetic** で
-- 検証するための prototype DDL。**production へ適用してはいけない。**
--   - `supabase/*_apply.sql`（production 適用ファイル）とは **別 directory**（prototype/）。
--   - 命名も `*_apply.sql` を避けている（apply 運用に混入させない）。
--   - CI / deploy から自動実行されない（本 repo に Supabase CLI / config.toml / auto-migration は無い）。
--   - account deletion の subject FK / retention は **未確定（LEGAL_REVIEW）** のため、
--     本 prototype は subject_user_id を **FK なし uuid**（PROVISIONAL）で持つ。
--     `auth.users ON DELETE CASCADE` を production 最終方針として確定してはいけない。
--
-- 設計根拠（P14-D）: Option 2（Ledger + Policy Manifest）/ append-only /
--   subject-scoped monotonic sequence（advisory lock + MAX+1・career_gd_post_message 準拠）/
--   idempotency（UNIQUE + payload digest）/ owner RLS / direct client INSERT 禁止 /
--   service_role-gated SECURITY DEFINER RPC / current state は derived（table 化しない）。
--
-- 本 SQL の意味論は lib/careerConsent/prototype/localLedgerModel.ts に忠実に再現し、
-- offline synthetic QA（scripts/career-consent-proto-*-qa.ts）で検証する
-- （live Postgres は本環境に無いため DB 実行はしない）。
-- ============================================================================

-- ── career_consent_policies（policy manifest の source of truth）──────────────
CREATE TABLE IF NOT EXISTS career_consent_policies (
  scope               text        NOT NULL,
  consent_version     integer     NOT NULL,
  notice_version      text        NOT NULL,
  purpose_version     text        NOT NULL,
  policy_digest       text        NOT NULL,
  effective_from      timestamptz NOT NULL,
  superseded_at       timestamptz NULL,
  active              boolean     NOT NULL DEFAULT false,
  legal_review_status text        NOT NULL DEFAULT 'REQUIRED',
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_consent_policies_pk PRIMARY KEY (scope, consent_version),
  CONSTRAINT career_consent_policies_scope_chk CHECK (scope IN (
    'personal_service_processing','internal_aggregated_analytics',
    'user_facing_aggregated_insight','ai_context_aggregated_insight',
    'externally_shared_insight','company_knowledge_contribution')),
  CONSTRAINT career_consent_policies_ver_chk    CHECK (consent_version >= 1),
  CONSTRAINT career_consent_policies_notice_chk CHECK (length(notice_version) > 0),
  CONSTRAINT career_consent_policies_digest_chk CHECK (length(policy_digest) > 0),
  CONSTRAINT career_consent_policies_legal_chk  CHECK (legal_review_status IN ('REQUIRED','PENDING','NOT_REQUIRED'))
);
-- scope ごとに active policy は最大 1 つ（部分 unique index）。
CREATE UNIQUE INDEX IF NOT EXISTS career_consent_policies_active_uniq
  ON career_consent_policies (scope) WHERE active;

-- ── career_consent_events（append-only 同意事象ledger・source of truth）────────
--   禁止列（IP / user_agent / device_fingerprint / free-text reason / raw policy text）は
--   **意図的に存在しない**。copy は notice_version / policy_digest で参照する。
CREATE TABLE IF NOT EXISTS career_consent_events (
  event_id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id            uuid        NOT NULL,  -- PROVISIONAL: FK なし（deletion 方針未確定）
  scope                      text        NOT NULL,
  action                     text        NOT NULL,
  consent_version            integer     NULL,
  notice_version             text        NULL,
  purpose_version            text        NULL,
  policy_digest              text        NULL,
  server_sequence            bigint      NOT NULL,  -- server 採番（advisory lock 直列化）
  effective_at               timestamptz NOT NULL,
  recorded_at                timestamptz NOT NULL DEFAULT now(),  -- server 生成
  source_surface             text        NOT NULL DEFAULT 'unspecified',
  actor_type                 text        NOT NULL DEFAULT 'user',
  idempotency_key            text        NOT NULL,
  payload_digest             text        NOT NULL,
  legal_review_marker        text        NULL,
  correction_target_event_id uuid        NULL,      -- correction は UPDATE せず新 event で表現
  CONSTRAINT career_consent_events_seq_uniq  UNIQUE (subject_user_id, server_sequence),
  CONSTRAINT career_consent_events_idem_uniq UNIQUE (subject_user_id, idempotency_key),
  CONSTRAINT career_consent_events_seq_pos   CHECK (server_sequence >= 1),
  CONSTRAINT career_consent_events_idem_ne   CHECK (length(idempotency_key) > 0),
  CONSTRAINT career_consent_events_digest_ne CHECK (length(payload_digest) > 0),
  CONSTRAINT career_consent_events_scope_chk CHECK (scope IN (
    'personal_service_processing','internal_aggregated_analytics',
    'user_facing_aggregated_insight','ai_context_aggregated_insight',
    'externally_shared_insight','company_knowledge_contribution','account')),
  CONSTRAINT career_consent_events_action_chk CHECK (action IN (
    'consent_granted','consent_withdrawn','consent_reconfirmed',
    'consent_policy_superseded','account_deletion_requested','account_deleted')),
  CONSTRAINT career_consent_events_actor_chk CHECK (actor_type IN ('user','system','legal','import'))
);
CREATE INDEX IF NOT EXISTS career_consent_events_subject_seq_idx
  ON career_consent_events (subject_user_id, server_sequence);

-- ── career_consent_withdrawal_outbox（withdrawal と同一 txn で追記）──────────────
CREATE TABLE IF NOT EXISTS career_consent_withdrawal_outbox (
  outbox_id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id                    uuid        NOT NULL,
  scope                              text        NOT NULL,
  consent_event_id                   uuid        NOT NULL REFERENCES career_consent_events(event_id),
  requested_at                       timestamptz NOT NULL DEFAULT now(),
  processed_at                       timestamptz NULL,
  attempts                           integer     NOT NULL DEFAULT 0,
  status                             text        NOT NULL DEFAULT 'pending',
  open_bucket_recompute_requested    boolean     NOT NULL DEFAULT true,
  eligibility_invalidation_requested boolean     NOT NULL DEFAULT true,
  cache_invalidation_requested       boolean     NOT NULL DEFAULT true,
  CONSTRAINT career_consent_outbox_status_chk CHECK (status IN ('pending','processed','failed'))
);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Ledger: owner SELECT のみ。**INSERT / UPDATE / DELETE policy は張らない**
--   → authenticated からの直接 INSERT / UPDATE / DELETE を不可にする（append-only を RLS でも担保）。
--   書き込みは RPC（service_role gateway）経由のみ。
ALTER TABLE career_consent_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='career_consent_events' AND policyname='career_consent_events owner select') THEN
    EXECUTE 'CREATE POLICY "career_consent_events owner select" ON public.career_consent_events '
         || 'FOR SELECT TO authenticated USING (auth.uid() = subject_user_id)';
  END IF;
END $$;

-- Policy manifest: authenticated は **active のみ** SELECT 可。historical / inactive は非公開。
ALTER TABLE career_consent_policies ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='career_consent_policies' AND policyname='career_consent_policies active read') THEN
    EXECUTE 'CREATE POLICY "career_consent_policies active read" ON public.career_consent_policies '
         || 'FOR SELECT TO authenticated USING (active = true)';
  END IF;
END $$;

-- Outbox: authenticated policy を張らない（server / batch のみ・service_role bypass 経由）。
ALTER TABLE career_consent_withdrawal_outbox ENABLE ROW LEVEL SECURITY;

-- ── Receipt read model（SECURITY INVOKER view・internal 列を出さない）──────────
--   owner の RLS を継承し、subject_user_id / server_sequence / idempotency_key /
--   payload_digest / recorded_at(exact) / actor_type / legal_marker / correction を **出さない**。
--   status（active/withdrawn/outdated 等）の完全導出は P14-C reducer（TS）を source of truth とし、
--   view は最小 projection のみを返す（SQL で reducer を二重実装しない）。
CREATE OR REPLACE VIEW career_consent_receipt_min
  WITH (security_invoker = true) AS
  SELECT scope, action, consent_version, notice_version, effective_at
    FROM career_consent_events;

-- ── Append RPC（SECURITY DEFINER・service_role gateway・advisory lock 採番）────────
--   career_gd_post_message と同型: 冪等事前 SELECT → advisory_xact_lock → MAX+1 → INSERT →
--   unique_violation 時は既存行返却。client の recorded_at / server_sequence は信頼しない。
DROP FUNCTION IF EXISTS career_consent_append_prototype(
  uuid, text, text, integer, text, text, text, timestamptz, text, text, text, text);
CREATE OR REPLACE FUNCTION career_consent_append_prototype(
  p_subject         uuid,
  p_scope           text,
  p_action          text,
  p_consent_version integer,
  p_notice_version  text,
  p_purpose_version text,
  p_policy_digest   text,
  p_effective_at    timestamptz,
  p_source_surface  text,
  p_actor_type      text,
  p_idempotency_key text,
  p_payload_digest  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp   -- search_path 固定（injection 対策）
AS $$
DECLARE
  v_row career_consent_events;
  v_seq bigint;
  v_now timestamptz := now();
BEGIN
  IF length(coalesce(p_idempotency_key, '')) = 0 THEN
    RETURN jsonb_build_object('status','rejected','reason','missing_idempotency_key');
  END IF;
  IF length(coalesce(p_payload_digest, '')) = 0 THEN
    RETURN jsonb_build_object('status','rejected','reason','missing_payload_digest');
  END IF;
  IF p_effective_at > v_now THEN
    RETURN jsonb_build_object('status','rejected','reason','future_effective_timestamp');
  END IF;

  -- 冪等: 同一 (subject, idempotency_key) が既存なら payload 一致で duplicate / 不一致で conflict。
  SELECT * INTO v_row FROM career_consent_events
    WHERE subject_user_id = p_subject AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_row.payload_digest = p_payload_digest THEN
      RETURN jsonb_build_object('status','duplicate','event_id',v_row.event_id,'server_sequence',v_row.server_sequence);
    ELSE
      RETURN jsonb_build_object('status','conflict','reason','idempotency_conflict');
    END IF;
  END IF;

  -- grant / reconfirm は active policy manifest と version + digest を照合。
  IF p_action IN ('consent_granted','consent_reconfirmed') THEN
    PERFORM 1 FROM career_consent_policies
      WHERE scope = p_scope AND consent_version = p_consent_version
        AND active = true AND policy_digest = p_policy_digest;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status','rejected','reason','policy_invalid');
    END IF;
  END IF;

  -- subject 単位で seq 採番を直列化（naked MAX+1 を単独で使わない）。
  PERFORM pg_advisory_xact_lock(hashtextextended(p_subject::text, 0));
  SELECT COALESCE(MAX(server_sequence), 0) + 1 INTO v_seq
    FROM career_consent_events WHERE subject_user_id = p_subject;

  INSERT INTO career_consent_events
    (subject_user_id, scope, action, consent_version, notice_version, purpose_version,
     policy_digest, server_sequence, effective_at, recorded_at, source_surface, actor_type,
     idempotency_key, payload_digest)
  VALUES
    (p_subject, p_scope, p_action, p_consent_version, p_notice_version, p_purpose_version,
     p_policy_digest, v_seq, p_effective_at, v_now, p_source_surface, p_actor_type,
     p_idempotency_key, p_payload_digest)
  RETURNING * INTO v_row;

  -- withdrawal は同一 transaction で outbox を追記。
  IF p_action = 'consent_withdrawn' THEN
    INSERT INTO career_consent_withdrawal_outbox (subject_user_id, scope, consent_event_id)
    VALUES (p_subject, p_scope, v_row.event_id);
  END IF;

  RETURN jsonb_build_object('status','inserted','event_id',v_row.event_id,'server_sequence',v_row.server_sequence);

EXCEPTION WHEN unique_violation THEN
  -- idempotency race: 同時に同一 key が入った場合は既存行を冪等に返す。
  SELECT * INTO v_row FROM career_consent_events
    WHERE subject_user_id = p_subject AND idempotency_key = p_idempotency_key;
  IF FOUND AND v_row.payload_digest = p_payload_digest THEN
    RETURN jsonb_build_object('status','duplicate','event_id',v_row.event_id,'server_sequence',v_row.server_sequence);
  END IF;
  RAISE;
END;
$$;

-- 直接実行を PUBLIC から剥奪。local prototype では service_role gateway（server route）だけが実行。
-- anon / authenticated には EXECUTE を付与しない（client direct write を不可能にする）。
REVOKE ALL ON FUNCTION career_consent_append_prototype(
  uuid, text, text, integer, text, text, text, timestamptz, text, text, text, text) FROM PUBLIC;
-- GRANT EXECUTE ... TO service_role;  -- local 適用時のみ。production では付与方針を別途確定する。

-- ============================================================================
-- ⛔ 再掲: 本ファイルは production 適用禁止。local Supabase 検証専用の prototype。
-- ============================================================================

-- ============================================================================
-- career_generation_jobs — 長時間 AI 生成（自己分析まとめ生成 pilot）の
--   owner-scoped 耐障害ジョブ台帳。
--
-- 目的（STEP-CAREER-GENJOB-01 / members pilot）:
--   Claude が遅くても・接続が切れても、生成結果を失わず・二重実行せず・
--   後から安全に回収できる構造の DB 基盤。単一 bounded invocation 内で生成を
--   進めつつ、POST は claim 直後に 202 を返し、client は status を poll する。
--
--   本 table は「result の durable 保存 + idempotency + attempt fencing」を担う。
--   route / status endpoint / client 復帰は後続 STEP で配線する（本 migration では未使用）。
--
-- 設計方針（PASSAI CAREER 既存規約に整合）:
--   - localStorage が canonical・Supabase は member 限定という既存方針は維持する。
--     本 table は **member（メール登録済み）専用の durable 復旧基盤**。anon は対象外。
--   - 命名・updated_at trigger・RLS owner 判定は career_features_apply.sql と同形。
--   - **書き込みは server-side（service_role / SECURITY DEFINER function）のみ**。
--     browser から直接 INSERT/UPDATE/DELETE させない（GRANT でも塞ぐ）。
--   - raw input / prompt 本文 / provider raw error / PII は保存しない。
--     input は hash revision（input_revision / prompt_revision / output_schema_revision）
--     のみ保存する。result は正規化済みの構造化 JSON のみ。
--
-- 冪等性: 全 DDL は再実行安全（IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS
--   / DO ブロックの trigger 存在チェック / REVOKE・GRANT は自然に冪等）。
--
-- 適用: Supabase SQL Editor で本ファイル全文を実行（service_role / postgres 権限）。
--   本番接続・実データは Claude Code 側では扱わない（operator 手動適用）。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §1 table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_generation_jobs (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 機能識別（例: feature='self_analysis' / operation='summary'）。
  feature                text        NOT NULL,
  operation              text        NOT NULL,

  -- server-authoritative idempotency key（SHA-256 hex）。natural key=(user_id, idempotency_key)。
  idempotency_key        text        NOT NULL,

  -- hash revision のみ保存（raw input は保存しない）。
  input_revision         text        NOT NULL,
  prompt_revision        text        NOT NULL,
  output_schema_revision text        NOT NULL,
  model                  text        NOT NULL,

  -- ライフサイクル。
  status                 text        NOT NULL DEFAULT 'queued',

  -- attempt fencing。claim / reclaim ごとに新しい attempt_token を発行し、
  -- completed/failed 更新は attempt_token 一致でのみ許可する（lease を失った古い attempt を弾く）。
  attempt_token          uuid,
  lease_expires_at       timestamptz,
  attempt_count          int         NOT NULL DEFAULT 0,

  -- 結果 / 失敗（result は completed 時のみ・error_code は固定 allowlist のみ）。
  result                 jsonb,
  error_code             text,

  -- observability（数値のみ・PII なし）。非 streaming のため ttft_ms は nullable で未計測。
  provider_duration_ms   int,
  total_duration_ms      int,
  ttft_ms                int,

  started_at             timestamptz,
  completed_at           timestamptz,
  failed_at              timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- 同一 (user_id, idempotency_key) は 1 行（重複生成防止の核）。
  CONSTRAINT career_generation_jobs_natural_key UNIQUE (user_id, idempotency_key),

  -- status は 4 値のみ。
  CONSTRAINT career_generation_jobs_status_chk
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),

  -- status ↔ 各列の整合（incomplete を completed 扱いしない・failed に result を残さない 等）。
  CONSTRAINT career_generation_jobs_invariants CHECK (
    attempt_count >= 0
    AND (provider_duration_ms IS NULL OR provider_duration_ms >= 0)
    AND (total_duration_ms IS NULL OR total_duration_ms >= 0)
    AND (ttft_ms IS NULL OR ttft_ms >= 0)
    AND (
      (status = 'queued'
        AND result IS NULL AND error_code IS NULL
        AND completed_at IS NULL AND failed_at IS NULL)
   OR (status = 'running'
        AND started_at IS NOT NULL AND attempt_token IS NOT NULL AND lease_expires_at IS NOT NULL
        AND result IS NULL AND error_code IS NULL
        AND completed_at IS NULL AND failed_at IS NULL)
   OR (status = 'completed'
        AND result IS NOT NULL AND completed_at IS NOT NULL
        AND error_code IS NULL AND failed_at IS NULL)
   OR (status = 'failed'
        AND result IS NULL
        AND error_code IS NOT NULL AND failed_at IS NOT NULL)
    )
  )
);

-- owner 別の一覧 / observability。
CREATE INDEX IF NOT EXISTS career_generation_jobs_user_feature_created_idx
  ON career_generation_jobs (user_id, feature, created_at DESC);

-- stale（lease 切れ running）掃引 / reclaim 用の部分 index。
CREATE INDEX IF NOT EXISTS career_generation_jobs_running_lease_idx
  ON career_generation_jobs (lease_expires_at)
  WHERE status = 'running';

COMMENT ON TABLE career_generation_jobs IS
  'STEP-CAREER-GENJOB-01. 長時間 AI 生成の owner-scoped 耐障害ジョブ台帳（自己分析まとめ生成 pilot）。'
  'member 専用 durable 復旧基盤。書き込みは server-side（service_role / SECURITY DEFINER）のみ。'
  'raw input / prompt 本文 / provider raw error / PII は保存しない（hash revision のみ）。'
  'natural key=(user_id, idempotency_key)。attempt fencing=(status=running AND attempt_token 一致)。';

-- ----------------------------------------------------------------------------
-- §2 updated_at trigger（schema.sql §3 の set_updated_at() を冪等に張る）
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'career_generation_jobs_set_updated_at'
      AND tgrelid = 'public.career_generation_jobs'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER career_generation_jobs_set_updated_at '
         || 'BEFORE UPDATE ON public.career_generation_jobs '
         || 'FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- §3 RLS — owner SELECT のみ（書き込み policy は張らない）。
--   Anonymous Auth 経由でも role=authenticated で届くので policy 対象は authenticated。
--   書き込みは service_role（RLS bypass）/ SECURITY DEFINER function 経由のみ。
--   → authenticated 向けの INSERT/UPDATE/DELETE policy は **意図的に作らない**。
-- ----------------------------------------------------------------------------
ALTER TABLE public.career_generation_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS career_generation_jobs_owner_select ON public.career_generation_jobs;
CREATE POLICY career_generation_jobs_owner_select
  ON public.career_generation_jobs
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- §4 GRANT/REVOKE — browser direct write を塞ぐ（RLS だけに頼らない）。
--   authenticated: owner SELECT のみ（RLS で owner 制限）。INSERT/UPDATE/DELETE は付与しない。
--   anon: 一切なし。service_role: 書き込み担当なので ALL。
-- ----------------------------------------------------------------------------
REVOKE ALL ON public.career_generation_jobs FROM anon;
REVOKE ALL ON public.career_generation_jobs FROM authenticated;
GRANT SELECT ON public.career_generation_jobs TO authenticated;
GRANT ALL ON public.career_generation_jobs TO service_role;

-- ----------------------------------------------------------------------------
-- §5 atomic claim function — SELECT→INSERT の非原子的 race を避け、
--   単一 function 内で claim/reclaim を原子的に決める。戻り値で 6 outcome を区別する。
--
--   outcome:
--     CLAIMED_NEW           新規 claim 成功（呼び出し側が生成を開始してよい）
--     CLAIMED_RETRY         stale reclaim / transient failed 後の再 claim 成功（新 attempt_token）
--     ALREADY_RUNNING       別 attempt が実行中（lease 有効）。生成しない
--     ALREADY_COMPLETED     completed 済み。生成せず cached result を返す
--     FAILED_NON_RETRYABLE  非 retryable で失敗確定。生成しない
--     RETRY_LIMIT_REACHED   MAX_ATTEMPTS 到達。生成しない（stale running は failed へ確定させる）
--
--   attempt_count は「初回を含む最大試行回数」。新規=1、reclaim ごとに +1。
--   CLAIMED_NEW / CLAIMED_RETRY のみ attempt_token を返す（呼び出し側の fencing token）。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_generation_job_claim(
  p_user_id                uuid,
  p_feature                text,
  p_operation              text,
  p_idempotency_key        text,
  p_input_revision         text,
  p_prompt_revision        text,
  p_output_schema_revision text,
  p_model                  text,
  p_lease_seconds          int,
  p_max_attempts           int,
  p_nonretryable_codes     text[]
)
RETURNS TABLE (
  outcome       text,
  job_id        uuid,
  attempt_token uuid,
  status        text,
  attempt_count int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id    uuid;
  v_tok   uuid;
  v_row   public.career_generation_jobs%ROWTYPE;
  v_stale boolean;
BEGIN
  IF p_user_id IS NULL
     OR p_idempotency_key IS NULL OR p_idempotency_key = ''
     OR p_feature IS NULL OR p_feature = ''
     OR p_operation IS NULL OR p_operation = ''
     OR p_input_revision IS NULL OR p_input_revision = ''
     OR p_prompt_revision IS NULL OR p_prompt_revision = ''
     OR p_output_schema_revision IS NULL OR p_output_schema_revision = ''
     OR p_model IS NULL OR p_model = ''
     OR p_lease_seconds IS NULL OR p_lease_seconds <= 0
     OR p_max_attempts IS NULL OR p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'career_generation_job_claim: missing/invalid argument';
  END IF;

  -- (1) 新規 claim を原子的に試みる（最初から running で挿入。queued は永続化しない）。
  INSERT INTO public.career_generation_jobs (
    user_id, feature, operation, idempotency_key,
    input_revision, prompt_revision, output_schema_revision, model,
    status, attempt_token, attempt_count, started_at, lease_expires_at
  ) VALUES (
    p_user_id, p_feature, p_operation, p_idempotency_key,
    p_input_revision, p_prompt_revision, p_output_schema_revision, p_model,
    'running', gen_random_uuid(), 1, now(), now() + make_interval(secs => p_lease_seconds)
  )
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING id, career_generation_jobs.attempt_token INTO v_id, v_tok;

  IF FOUND THEN
    RETURN QUERY SELECT 'CLAIMED_NEW'::text, v_id, v_tok, 'running'::text, 1;
    RETURN;
  END IF;

  -- (2) 競合: 既存行を lock して直列に判定する。
  SELECT * INTO v_row
  FROM public.career_generation_jobs
  WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF v_row.status = 'completed' THEN
    RETURN QUERY SELECT 'ALREADY_COMPLETED'::text, v_row.id, NULL::uuid, 'completed'::text, v_row.attempt_count;
    RETURN;
  END IF;

  v_stale := (v_row.status = 'running' AND v_row.lease_expires_at <= now());

  IF v_row.status = 'running' AND NOT v_stale THEN
    RETURN QUERY SELECT 'ALREADY_RUNNING'::text, v_row.id, NULL::uuid, 'running'::text, v_row.attempt_count;
    RETURN;
  END IF;

  IF v_row.status = 'failed' AND v_row.error_code = ANY (p_nonretryable_codes) THEN
    RETURN QUERY SELECT 'FAILED_NON_RETRYABLE'::text, v_row.id, NULL::uuid, 'failed'::text, v_row.attempt_count;
    RETURN;
  END IF;

  IF v_row.attempt_count >= p_max_attempts THEN
    -- 試行上限。stale running のまま放置しないよう、必ず terminal failed へ確定させる。
    IF v_row.status = 'running' THEN
      UPDATE public.career_generation_jobs
      SET status = 'failed', error_code = 'RETRY_LIMIT_REACHED', failed_at = now(),
          result = NULL, attempt_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = v_row.id;
    END IF;
    RETURN QUERY SELECT 'RETRY_LIMIT_REACHED'::text, v_row.id, NULL::uuid, 'failed'::text, v_row.attempt_count;
    RETURN;
  END IF;

  -- (3) reclaim: 新 attempt_token・attempt_count+1・running へ戻し terminal 列を消す。
  UPDATE public.career_generation_jobs
  SET status = 'running',
      attempt_token = gen_random_uuid(),
      attempt_count = v_row.attempt_count + 1,
      started_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      result = NULL, error_code = NULL, completed_at = NULL, failed_at = NULL,
      input_revision = p_input_revision,
      prompt_revision = p_prompt_revision,
      output_schema_revision = p_output_schema_revision,
      model = p_model,
      updated_at = now()
  WHERE id = v_row.id
  RETURNING career_generation_jobs.attempt_token, career_generation_jobs.attempt_count
  INTO v_tok, v_row.attempt_count;

  RETURN QUERY SELECT 'CLAIMED_RETRY'::text, v_row.id, v_tok, 'running'::text, v_row.attempt_count;
END;
$$;

-- claim function は server-side（service_role）専用。browser / anon / authenticated には実行させない。
REVOKE ALL ON FUNCTION public.career_generation_job_claim(
  uuid, text, text, text, text, text, text, text, int, int, text[]
) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.career_generation_job_claim(
  uuid, text, text, text, text, text, text, text, int, int, text[]
) TO service_role;

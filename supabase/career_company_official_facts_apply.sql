-- ============================================================================
-- career_company_official_facts — Company Data Spine / Global Official Company Data DDL
--
-- ⚠ NOT APPLIED（本 slice ではファイル作成のみ。実環境への適用はしていない）
--    適用は operator が Supabase SQL Editor で手動実行する（Project B / CAREER 専用）。
--
-- 前提となる既存 DDL（**先に適用が必要**）:
--   supabase/career_company_identity_apply.sql
--     → career_company_master / career_company_aliases（どちらも現在 NOT APPLIED）
--
-- 位置づけ:
--   「その企業について、**出典 URL に遡れる形で**取得した公開事実」を全ユーザー共有で持つ。
--   ユーザーが志望企業名を入力した時点で先回り取得し、企業研究 / ES / 面接 / 志望動機 /
--   Career AI が **同じ 1 つの基盤**を読む（機能ごとに独自検索させない）。
--
-- 権威区分: global_shared_server_authoritative
--   - 企業の公開事実は **個人データではない**（user_id / contributor を一切持たない）。
--   - localStorage canonical の対象外（端末 canonical という概念が無い）。
--   - `CareerSourceKind`（Personal Memory の由来 Source）には **追加しない**。
--
-- 絶対に混同しない 3 つ（物理テーブルで分ける）:
--   1. career_company_official_facts — 外部一次情報の事実。source_id NOT NULL。
--   2. career_company_research_logs  — 本人の企業研究（既存・owner-scoped・別 table）。
--   3. career_company_derived        — AI が facts から導いた派生物。**facts へ昇格させない**。
--
-- Layer 5（career_company_knowledge_apply.sql）との関係:
--   Layer 5 は「ユーザーが明示共有した企業知見」であり **別 domain**。本ファイルは Layer 5 の
--   table を一切参照せず、LOCKED 状態の同ファイルを解錠もしない。
--
-- RLS 方針:
--   - sources / facts / derived : authenticated に SELECT のみ（anon には GRANT しない）。
--     企業の公開事実であり個人データを含まないため、認証済みユーザーは読める。
--   - enrichment_jobs           : **authenticated にも読ませない**（運用台帳。service_role のみ）。
--   - 書き込みは全 table で service_role / SECURITY DEFINER function のみ（policy を作らない＝default deny）。
--
-- 冪等性: 全 DDL は再実行安全（IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS /
--   DO ブロックの存在チェック / REVOKE・GRANT は自然に冪等）。
--
-- 破壊的変更: **無し**。既存 table への変更は career_company_master への
--   nullable カラム 1 本の追加のみ（ADD COLUMN IF NOT EXISTS）。
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- §1 career_company_master への追加（非破壊・nullable）
--
--   corporate_number: 法人番号（13桁）。名寄せの **真の一意キー**。
--   normalized_name は表記ゆれに強くないため（script を跨がない・法人格の扱いに依存する）、
--   公的 registry から法人番号が取れた企業については、こちらを一意性の根拠にする。
--   ★ 既存行は NULL のままで整合する（NOT NULL にしない）。
-- ----------------------------------------------------------------------------
ALTER TABLE public.career_company_master
  ADD COLUMN IF NOT EXISTS corporate_number text;

COMMENT ON COLUMN public.career_company_master.corporate_number IS
  'National corporate number (13 digits) when resolved from an authoritative registry. NULL is normal.';

-- 法人番号が入っている行だけ一意（NULL は重複可）。同一法人の二重登録を DB 側でも防ぐ。
CREATE UNIQUE INDEX IF NOT EXISTS career_company_master_corporate_number_uniq
  ON public.career_company_master (corporate_number)
  WHERE corporate_number IS NOT NULL;

-- ----------------------------------------------------------------------------
-- §2 career_company_sources — 出典（1 URL = 1 行）
--
--   ★ 取得した HTML 本文・ページ全文は **保存しない**。同一性判定は content_hash のみ。
--     （再配布リスクを構造的に避ける。抜粋は facts 側の rawExcerpt に限定する。）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.career_company_sources (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     text        NOT NULL
                   REFERENCES public.career_company_master (company_id) ON DELETE RESTRICT,

  source_url     text        NOT NULL,
  source_type    text        NOT NULL,
  source_domain  text        NOT NULL,

  http_status    int,
  -- 本文の SHA-256（本文そのものは保存しない）。同一なら再抽出しない＝AI コスト削減。
  content_hash   text,

  fetched_at     timestamptz NOT NULL DEFAULT now(),
  -- ページから取得できたときだけ入れる（推測して埋めない）。
  published_at   timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT career_company_sources_type_chk CHECK (
    source_type IN (
      'corporate_registry','official_site','ir_document',
      'press_release','job_posting','search_result'
    )
  ),
  CONSTRAINT career_company_sources_url_chk CHECK (
    source_url <> '' AND (source_url LIKE 'http://%' OR source_url LIKE 'https://%')
  ),
  CONSTRAINT career_company_sources_status_chk CHECK (
    http_status IS NULL OR (http_status >= 100 AND http_status <= 599)
  ),
  -- 同一 URL を同一時刻で二重登録しない。
  CONSTRAINT career_company_sources_natural_key UNIQUE (company_id, source_url, fetched_at)
);

COMMENT ON TABLE public.career_company_sources IS
  'Company Data Spine global source provenance. One row per fetched URL. NO page body is stored (content_hash only). NO personal data. Writes are service_role only.';

CREATE INDEX IF NOT EXISTS career_company_sources_company_fetched_idx
  ON public.career_company_sources (company_id, fetched_at DESC);

ALTER TABLE public.career_company_sources ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- §3 career_company_official_facts — 事実（1 事実 = 1 行 / EAV）
--
--   なぜ EAV か: 取得項目が増えるたびに ALTER TABLE を打たずに済ませるため。
--   fact_key はアプリ側 union（types/careerCompanyOfficial.ts）で閉じており、
--   未知 key は保存経路に入らない。
--
--   ★★ source_id NOT NULL ★★
--     出典の無い値を official fact として保存する経路を **DB で塞ぐ**。
--     AI 生成物はこの table に入れられない（derived table へ）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.career_company_official_facts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        text        NOT NULL
                      REFERENCES public.career_company_master (company_id) ON DELETE RESTRICT,

  fact_group        text        NOT NULL,
  fact_key          text        NOT NULL,
  -- {value, unit?, asOf?, rawExcerpt?}。原文の言い換え・要約はしない。
  fact_value        jsonb       NOT NULL,

  -- ★ 出典必須。ON DELETE RESTRICT で「出典だけ消える」状態を作らせない。
  source_id         uuid        NOT NULL
                      REFERENCES public.career_company_sources (id) ON DELETE RESTRICT,

  extraction_method text        NOT NULL,
  confidence        numeric(4,3) NOT NULL DEFAULT 0.500,

  fetched_at        timestamptz NOT NULL DEFAULT now(),
  -- fact_group 別 TTL から導出（lib/careerCompanyOfficial/freshness.ts と同じ値）。
  valid_until       timestamptz,

  -- 履歴を消さない（新しい事実で古い事実を上書き削除しない）。
  superseded_by     uuid        REFERENCES public.career_company_official_facts (id) ON DELETE SET NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT career_company_official_facts_group_chk CHECK (
    fact_group IN ('identity','profile','navigation','ir','recruiting','news')
  ),
  CONSTRAINT career_company_official_facts_method_chk CHECK (
    extraction_method IN ('structured_api','html_structured','llm_extraction')
  ),
  CONSTRAINT career_company_official_facts_confidence_chk CHECK (
    confidence >= 0 AND confidence <= 1
  ),
  CONSTRAINT career_company_official_facts_value_chk CHECK (
    jsonb_typeof(fact_value) = 'object' AND fact_value ? 'value'
  ),
  -- 同一 key を同一時刻で二重登録しない（再取得は別 fetched_at として積む）。
  CONSTRAINT career_company_official_facts_natural_key
    UNIQUE (company_id, fact_key, fetched_at)
);

COMMENT ON TABLE public.career_company_official_facts IS
  'Company Data Spine global official facts. source_id is NOT NULL: a fact without provenance cannot exist. AI-generated content MUST NOT be stored here (see career_company_derived). NO personal data. Writes are service_role only.';

-- 読み出し（company + group を最新順で引く）用。
CREATE INDEX IF NOT EXISTS career_company_official_facts_company_group_idx
  ON public.career_company_official_facts (company_id, fact_group, fetched_at DESC);

-- 現行値（superseded されていない）だけを引く用。
CREATE INDEX IF NOT EXISTS career_company_official_facts_current_idx
  ON public.career_company_official_facts (company_id, fact_key, fetched_at DESC)
  WHERE superseded_by IS NULL;

ALTER TABLE public.career_company_official_facts ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- §4 career_company_derived — AI 派生物（facts と物理的に分離）
--
--   ★ この table の内容は **事実ではない**。prompt では必ず別 block・別ラベルで扱う。
--     facts への昇格経路は作らない（コード側 QA でも import 経路を固定する）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.career_company_derived (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       text        NOT NULL
                     REFERENCES public.career_company_master (company_id) ON DELETE RESTRICT,

  derived_kind     text        NOT NULL,
  content          text        NOT NULL,
  -- 根拠にした fact key（トレーサビリティ。fact id ではなく key で持つ＝再取得に強い）。
  based_on_fact_keys text[]    NOT NULL DEFAULT '{}',

  model            text        NOT NULL,
  prompt_revision  text        NOT NULL,
  generated_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT career_company_derived_kind_chk CHECK (
    derived_kind IN ('profile_summary','research_starting_points')
  ),
  CONSTRAINT career_company_derived_natural_key
    UNIQUE (company_id, derived_kind, prompt_revision, generated_at)
);

COMMENT ON TABLE public.career_company_derived IS
  'Company Data Spine AI-derived summaries. usage=ai_derived_not_fact. MUST NEVER be promoted into career_company_official_facts. NO personal data. Writes are service_role only.';

CREATE INDEX IF NOT EXISTS career_company_derived_company_idx
  ON public.career_company_derived (company_id, derived_kind, generated_at DESC);

ALTER TABLE public.career_company_derived ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- §5 career_company_enrichment_jobs — global company-scoped 取得ジョブ台帳
--
--   ★★ user_id を **持たない** ★★
--     既存 career_generation_jobs は natural key=(user_id, idempotency_key) の
--     owner-scoped 台帳であり、100 人が「ソニー」を志望すると 100 job になる。
--     企業情報の取得は **全ユーザーで 1 回**でよい global work なので、別台帳にする。
--     設計パターン（server-authoritative idempotency / attempt fencing / lease /
--     MAX_ATTEMPTS / 固定 error allowlist）は career_generation_jobs と完全に同形。
--
--   natural key = (company_id, task, idempotency_key)
--     idempotency_key は server が company_id / task / fetcher_revision /
--     schema_revision から SHA-256 で算出する（client 申告値は使わない）。
--
--   status に 'partial' を持つ:
--     identity は取れたが profile ページの取得に失敗した、という **部分成功**を
--     failed に丸めない（取れた fact を捨てない）。partial は terminal だが retryable。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.career_company_enrichment_jobs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  company_id        text        NOT NULL
                      REFERENCES public.career_company_master (company_id) ON DELETE RESTRICT,
  -- 取得タスク（'identity_profile' 等）。fact_group の束を 1 単位にした論理名。
  task              text        NOT NULL,

  -- server-authoritative idempotency key（SHA-256 hex）。
  idempotency_key   text        NOT NULL,
  -- hash revision のみ保存（企業名・URL・HTML・prompt 本文は保存しない）。
  fetcher_revision  text        NOT NULL,
  schema_revision   text        NOT NULL,

  status            text        NOT NULL DEFAULT 'pending',

  -- attempt fencing（lease を失った古い attempt の書き込みを弾く）。
  attempt_token     uuid,
  lease_expires_at  timestamptz,
  attempt_count     int         NOT NULL DEFAULT 0,

  -- 結果は「何件書けたか」の数値のみ（事実本体は facts table 側）。
  facts_written     int,
  sources_written   int,
  -- 固定 allowlist のみ（provider の raw message は絶対に入れない）。
  error_code        text,

  -- observability（数値のみ・PII なし・URL なし）。
  provider_duration_ms int,
  total_duration_ms    int,

  started_at        timestamptz,
  completed_at      timestamptz,
  failed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT career_company_enrichment_jobs_natural_key
    UNIQUE (company_id, task, idempotency_key),

  CONSTRAINT career_company_enrichment_jobs_status_chk
    CHECK (status IN ('pending','running','completed','partial','failed')),

  CONSTRAINT career_company_enrichment_jobs_invariants CHECK (
    attempt_count >= 0
    AND (facts_written IS NULL OR facts_written >= 0)
    AND (sources_written IS NULL OR sources_written >= 0)
    AND (provider_duration_ms IS NULL OR provider_duration_ms >= 0)
    AND (total_duration_ms IS NULL OR total_duration_ms >= 0)
    AND (
      (status = 'pending'
        AND error_code IS NULL AND completed_at IS NULL AND failed_at IS NULL)
   OR (status = 'running'
        AND started_at IS NOT NULL AND attempt_token IS NOT NULL AND lease_expires_at IS NOT NULL
        AND error_code IS NULL AND completed_at IS NULL AND failed_at IS NULL)
   OR (status = 'completed'
        AND completed_at IS NOT NULL AND error_code IS NULL AND failed_at IS NULL)
      -- partial は「一部は書けた」terminal。error_code を残しつつ completed_at も持つ。
   OR (status = 'partial'
        AND completed_at IS NOT NULL AND failed_at IS NULL)
   OR (status = 'failed'
        AND error_code IS NOT NULL AND failed_at IS NOT NULL)
    )
  )
);

COMMENT ON TABLE public.career_company_enrichment_jobs IS
  'Company Data Spine global enrichment job ledger. Company-scoped (NO user_id) so N users wanting the same company converge to ONE external fetch. natural key=(company_id, task, idempotency_key). attempt fencing=(status=running AND attempt_token match). NO company name, URL, HTML, prompt or PII is stored.';

CREATE INDEX IF NOT EXISTS career_company_enrichment_jobs_company_idx
  ON public.career_company_enrichment_jobs (company_id, task, created_at DESC);

-- stale（lease 切れ running）掃引 / reclaim 用の部分 index。
CREATE INDEX IF NOT EXISTS career_company_enrichment_jobs_running_lease_idx
  ON public.career_company_enrichment_jobs (lease_expires_at)
  WHERE status = 'running';

-- updated_at trigger（schema.sql §3 の set_updated_at() を冪等に張る）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'career_company_enrichment_jobs_set_updated_at'
      AND tgrelid = 'public.career_company_enrichment_jobs'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER career_company_enrichment_jobs_set_updated_at '
         || 'BEFORE UPDATE ON public.career_company_enrichment_jobs '
         || 'FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
  END IF;
END $$;

ALTER TABLE public.career_company_enrichment_jobs ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- §6 RLS policy
--
--   sources / facts / derived : authenticated に read だけ許可（非個人データ）。
--   enrichment_jobs           : policy を作らない（default deny）。運用台帳を露出させない。
--   書き込み policy は **どの table にも作らない**（service_role 経由のみ）。
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "career_company_sources read" ON public.career_company_sources;
CREATE POLICY "career_company_sources read"
  ON public.career_company_sources
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "career_company_official_facts read" ON public.career_company_official_facts;
CREATE POLICY "career_company_official_facts read"
  ON public.career_company_official_facts
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "career_company_derived read" ON public.career_company_derived;
CREATE POLICY "career_company_derived read"
  ON public.career_company_derived
  FOR SELECT TO authenticated
  USING (true);

-- ⚠ career_company_enrichment_jobs には SELECT policy を **作らない**（default deny）。

-- ----------------------------------------------------------------------------
-- §7 atomic claim function（company-scoped）
--
--   career_generation_job_claim と同一の 6 outcome。違いは scope だけ:
--     owner-scoped (user_id, idempotency_key) → company-scoped (company_id, task, idempotency_key)
--
--   outcome:
--     CLAIMED_NEW          新規 claim 成功（呼び出し側が取得を開始してよい）
--     CLAIMED_RETRY        stale reclaim / retryable failed / partial 後の再 claim 成功
--     ALREADY_RUNNING      別 attempt が実行中（lease 有効）。取得しない ← ★ N 人同時入力の収束点
--     ALREADY_COMPLETED    completed 済み。取得しない
--     FAILED_NON_RETRYABLE 非 retryable で失敗確定。取得しない
--     RETRY_LIMIT_REACHED  MAX_ATTEMPTS 到達。取得しない
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_company_enrichment_job_claim(
  p_company_id         text,
  p_task               text,
  p_idempotency_key    text,
  p_fetcher_revision   text,
  p_schema_revision    text,
  p_lease_seconds      int,
  p_max_attempts       int,
  p_nonretryable_codes text[]
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
  v_row   public.career_company_enrichment_jobs%ROWTYPE;
  v_stale boolean;
BEGIN
  IF p_company_id IS NULL OR p_company_id = ''
     OR p_task IS NULL OR p_task = ''
     OR p_idempotency_key IS NULL OR p_idempotency_key = ''
     OR p_fetcher_revision IS NULL OR p_fetcher_revision = ''
     OR p_schema_revision IS NULL OR p_schema_revision = ''
     OR p_lease_seconds IS NULL OR p_lease_seconds <= 0
     OR p_max_attempts IS NULL OR p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'career_company_enrichment_job_claim: missing/invalid argument';
  END IF;

  -- (1) 新規 claim を原子的に試みる（最初から running で挿入。pending は永続化しない）。
  INSERT INTO public.career_company_enrichment_jobs (
    company_id, task, idempotency_key, fetcher_revision, schema_revision,
    status, attempt_token, attempt_count, started_at, lease_expires_at
  ) VALUES (
    p_company_id, p_task, p_idempotency_key, p_fetcher_revision, p_schema_revision,
    'running', gen_random_uuid(), 1, now(), now() + make_interval(secs => p_lease_seconds)
  )
  ON CONFLICT (company_id, task, idempotency_key) DO NOTHING
  RETURNING id, career_company_enrichment_jobs.attempt_token INTO v_id, v_tok;

  IF FOUND THEN
    RETURN QUERY SELECT 'CLAIMED_NEW'::text, v_id, v_tok, 'running'::text, 1;
    RETURN;
  END IF;

  -- (2) 競合: 既存行を lock して直列に判定する。
  SELECT * INTO v_row
  FROM public.career_company_enrichment_jobs
  WHERE company_id = p_company_id AND task = p_task AND idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF v_row.status = 'completed' THEN
    RETURN QUERY SELECT 'ALREADY_COMPLETED'::text, v_row.id, NULL::uuid, 'completed'::text, v_row.attempt_count;
    RETURN;
  END IF;

  v_stale := (v_row.status = 'running' AND v_row.lease_expires_at <= now());

  -- ★ 収束点: 別 attempt が実行中なら何もしない。100 人が同時に同じ企業を入力しても外部取得は 1 回。
  IF v_row.status = 'running' AND NOT v_stale THEN
    RETURN QUERY SELECT 'ALREADY_RUNNING'::text, v_row.id, NULL::uuid, 'running'::text, v_row.attempt_count;
    RETURN;
  END IF;

  IF v_row.status = 'failed' AND v_row.error_code = ANY (p_nonretryable_codes) THEN
    RETURN QUERY SELECT 'FAILED_NON_RETRYABLE'::text, v_row.id, NULL::uuid, 'failed'::text, v_row.attempt_count;
    RETURN;
  END IF;

  IF v_row.attempt_count >= p_max_attempts THEN
    IF v_row.status = 'running' THEN
      UPDATE public.career_company_enrichment_jobs
      SET status = 'failed', error_code = 'RETRY_LIMIT_REACHED', failed_at = now(),
          attempt_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = v_row.id;
    END IF;
    RETURN QUERY SELECT 'RETRY_LIMIT_REACHED'::text, v_row.id, NULL::uuid, 'failed'::text, v_row.attempt_count;
    RETURN;
  END IF;

  -- (3) reclaim: 新 attempt_token・attempt_count+1・running へ戻し terminal 列を消す。
  --     ★ facts / sources は消さない（部分成功で書けた事実は保持したまま再試行する）。
  UPDATE public.career_company_enrichment_jobs
  SET status = 'running',
      attempt_token = gen_random_uuid(),
      attempt_count = v_row.attempt_count + 1,
      started_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      error_code = NULL, completed_at = NULL, failed_at = NULL,
      fetcher_revision = p_fetcher_revision,
      schema_revision = p_schema_revision,
      updated_at = now()
  WHERE id = v_row.id
  RETURNING career_company_enrichment_jobs.attempt_token, career_company_enrichment_jobs.attempt_count
  INTO v_tok, v_row.attempt_count;

  RETURN QUERY SELECT 'CLAIMED_RETRY'::text, v_row.id, v_tok, 'running'::text, v_row.attempt_count;
END;
$$;

-- ----------------------------------------------------------------------------
-- §8 GRANT / REVOKE（★ 最後）
--
--   authenticated: 企業の公開事実 3 table を SELECT のみ。job 台帳は一切付与しない。
--   anon         : 一切付与しない。
--   service_role : 書き込み担当。
-- ----------------------------------------------------------------------------
REVOKE ALL ON public.career_company_sources          FROM anon, authenticated;
REVOKE ALL ON public.career_company_official_facts   FROM anon, authenticated;
REVOKE ALL ON public.career_company_derived          FROM anon, authenticated;
REVOKE ALL ON public.career_company_enrichment_jobs  FROM anon, authenticated;

GRANT SELECT ON public.career_company_sources        TO authenticated;
GRANT SELECT ON public.career_company_official_facts TO authenticated;
GRANT SELECT ON public.career_company_derived        TO authenticated;
-- ⚠ career_company_enrichment_jobs は authenticated へ **付与しない**。

GRANT ALL ON public.career_company_sources           TO service_role;
GRANT ALL ON public.career_company_official_facts    TO service_role;
GRANT ALL ON public.career_company_derived           TO service_role;
GRANT ALL ON public.career_company_enrichment_jobs   TO service_role;

-- claim function は server-side（service_role）専用。
REVOKE ALL ON FUNCTION public.career_company_enrichment_job_claim(
  text, text, text, text, text, int, int, text[]
) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.career_company_enrichment_job_claim(
  text, text, text, text, text, int, int, text[]
) TO service_role;

COMMIT;

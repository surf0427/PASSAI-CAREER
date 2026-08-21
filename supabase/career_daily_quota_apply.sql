-- ============================================================================
-- career_daily_usage / career_daily_usage_operations
--   — PASSAI Career BASIC の「機能別 1 日利用回数上限」の durable counter。
--
-- 目的（STEP-CAREER-DAILY-QUOTA）:
--   Vercel の複数インスタンスにまたがっても同じ利用回数になり、残り 1 回の状態で
--   同時に 2 request が来ても両方 ALLOW にならない（原子的な check + consume）。
--   process-local Map / in-memory counter は quota の最終権限にしない。
--
-- 「1 回」の定義:
--   AI call 数ではなく **ユーザーから見た top-level operation 数**。ES 1 本は内部で
--   最大 10 AI call だが利用回数は 1。どの route を計上点にするかは
--   `lib/careerQuota/anchors.ts` が正本。本 DDL は「与えられた operation_id で
--   1 回だけ数える」ことだけを担う。
--
-- 1 日の境界:
--   **日本時間（Asia/Tokyo）00:00**。client 時計は信用せず、本 function 内の
--   `now() AT TIME ZONE 'Asia/Tokyo'` が唯一の日付権威。日本に DST は無い。
--
-- 設計方針（PASSAI CAREER 既存規約に整合）:
--   - member（メール登録済み）専用。anon / guest は user_id を持たないため対象外
--     （guest の扱いは entitlement 統合の課題として route 側に記録してある）。
--   - **書き込みは server-side（service_role / SECURITY DEFINER function）のみ**。
--     browser から直接 INSERT/UPDATE/DELETE させない（RLS + GRANT の二重で塞ぐ）。
--   - PII / 入力本文 / prompt は保存しない。operation_id は SHA-256 digest のみ。
--
-- 冪等性: 全 DDL は再実行安全（IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS
--   / DO ブロックの trigger 存在チェック / REVOKE・GRANT は自然に冪等）。
--
-- 適用: Supabase SQL Editor（Project B / CAREER）で本ファイル全文を実行。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §1 counter table（user × feature × JST 日付 で 1 行）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_daily_usage (
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature        text        NOT NULL,
  usage_date_jst date        NOT NULL,
  used           int         NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT career_daily_usage_pkey PRIMARY KEY (user_id, feature, usage_date_jst),
  CONSTRAINT career_daily_usage_used_chk CHECK (used >= 0),
  -- feature 語彙は lib/careerQuota/limits.ts の CAREER_DAILY_QUOTA_FEATURES と同一集合。
  CONSTRAINT career_daily_usage_feature_chk CHECK (
    feature IN (
      'self_analysis', 'company_research', 'es',
      'interview', 'presentation', 'gd', 'matching'
    )
  )
);

COMMENT ON TABLE career_daily_usage IS
  'STEP-CAREER-DAILY-QUOTA. PASSAI Career の機能別 1 日利用回数カウンタ（JST 日付単位）。'
  '1 行 = (user, feature, JST 日付)。書き込みは service_role / SECURITY DEFINER のみ。'
  '「1 回」= ユーザーから見た top-level operation（内部 AI call 数ではない）。';

-- ----------------------------------------------------------------------------
-- §2 operation dedupe table（retry / 二重送信 / reload を 1 回に畳む）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_daily_usage_operations (
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature        text        NOT NULL,
  usage_date_jst date        NOT NULL,
  -- server が request 内容から計算した digest（client 指定の id ではない / PII を含まない）。
  operation_id   text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT career_daily_usage_operations_pkey
    PRIMARY KEY (user_id, feature, usage_date_jst, operation_id)
);

COMMENT ON TABLE career_daily_usage_operations IS
  'STEP-CAREER-DAILY-QUOTA. 同一 operation の二重消費を防ぐ台帳（server 計算の SHA-256 digest）。'
  '同一 (user, feature, JST 日付, operation_id) は 1 行 = 利用回数 +1 は 1 度だけ。';

-- 日次の掃除（保持ポリシー運用）のための index。
CREATE INDEX IF NOT EXISTS career_daily_usage_operations_date_idx
  ON career_daily_usage_operations (usage_date_jst);

-- ----------------------------------------------------------------------------
-- §3 updated_at trigger（schema.sql §3 の set_updated_at() を冪等に張る）
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'career_daily_usage_set_updated_at'
      AND tgrelid = 'public.career_daily_usage'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER career_daily_usage_set_updated_at '
         || 'BEFORE UPDATE ON public.career_daily_usage '
         || 'FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- §4 RLS — owner SELECT のみ（残り回数表示のため）。書き込み policy は張らない。
--   operations 台帳は owner にも見せない（内部の dedupe 実装であり UI 用途が無い）。
-- ----------------------------------------------------------------------------
ALTER TABLE public.career_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.career_daily_usage_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS career_daily_usage_owner_select ON public.career_daily_usage;
CREATE POLICY career_daily_usage_owner_select
  ON public.career_daily_usage
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- §5 GRANT/REVOKE — browser direct write を塞ぐ（RLS だけに頼らない）。
--   client が used を書き換えて上限を迂回する経路を構造的に無くす。
-- ----------------------------------------------------------------------------
REVOKE ALL ON public.career_daily_usage FROM anon;
REVOKE ALL ON public.career_daily_usage FROM authenticated;
GRANT SELECT ON public.career_daily_usage TO authenticated;
GRANT ALL ON public.career_daily_usage TO service_role;

REVOKE ALL ON public.career_daily_usage_operations FROM anon;
REVOKE ALL ON public.career_daily_usage_operations FROM authenticated;
GRANT ALL ON public.career_daily_usage_operations TO service_role;

-- ----------------------------------------------------------------------------
-- §6 atomic consume function
--
--   check と consume を **1 statement の中**で決める。SELECT してから UPDATE する
--   実装だと、残り 1 回に 2 request が同時に来たとき両方 ALLOW になりうる。
--
--   outcome:
--     CONSUMED      利用回数を +1 した（呼び出し側は AI を実行してよい）
--     DEDUPED       同一 operation を既に計上済み（+0 で実行してよい＝ retry / 二重送信）
--     LIMIT_REACHED 本日の上限に到達（呼び出し側は 429 を返し AI を呼ばない）
--
--   引数 p_operation_ids は「同一操作とみなす id の候補列」。[1] が canonical
--   （実際に記録する id）で、以降は時間 bucket 境界の別名。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_daily_quota_consume(
  p_user_id       uuid,
  p_feature       text,
  p_operation_ids text[],
  p_limit         int
)
RETURNS TABLE (
  outcome      text,
  used_count   int,
  limit_count  int,
  reset_at     timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_date      date;
  v_reset     timestamptz;
  v_used      int;
  v_canonical text;
BEGIN
  IF p_user_id IS NULL
     OR p_feature IS NULL OR p_feature = ''
     OR p_operation_ids IS NULL OR array_length(p_operation_ids, 1) IS NULL
     OR p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'career_daily_quota_consume: missing/invalid argument';
  END IF;

  -- 日付権威は **DB の JST**。client 時計・呼び出し側の日付は一切受け取らない。
  v_date      := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_reset     := ((v_date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo');
  v_canonical := p_operation_ids[1];

  -- (1) 既に計上済みの operation か（retry / 二重送信 / reload 後の再送）。
  IF EXISTS (
    SELECT 1 FROM public.career_daily_usage_operations o
    WHERE o.user_id = p_user_id
      AND o.feature = p_feature
      AND o.usage_date_jst = v_date
      AND o.operation_id = ANY (p_operation_ids)
  ) THEN
    SELECT u.used INTO v_used
    FROM public.career_daily_usage u
    WHERE u.user_id = p_user_id AND u.feature = p_feature AND u.usage_date_jst = v_date;
    RETURN QUERY SELECT 'DEDUPED'::text, COALESCE(v_used, 0), p_limit, v_reset;
    RETURN;
  END IF;

  -- (2) operation を先に確保する。同一 operation の同時 2 request は
  --     ここで 1 本だけが勝ち、負けた側は DEDUPED（+0 で実行可）になる。
  INSERT INTO public.career_daily_usage_operations (user_id, feature, usage_date_jst, operation_id)
  VALUES (p_user_id, p_feature, v_date, v_canonical)
  ON CONFLICT (user_id, feature, usage_date_jst, operation_id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT u.used INTO v_used
    FROM public.career_daily_usage u
    WHERE u.user_id = p_user_id AND u.feature = p_feature AND u.usage_date_jst = v_date;
    RETURN QUERY SELECT 'DEDUPED'::text, COALESCE(v_used, 0), p_limit, v_reset;
    RETURN;
  END IF;

  -- (3) 原子的 consume。conflict 時は行 lock を取ったうえで最新値に対して
  --     `used < p_limit` を評価するため、並行 request が上限を追い越せない。
  --     条件を満たさなければ **1 行も返らない** ＝ 上限到達。
  INSERT INTO public.career_daily_usage (user_id, feature, usage_date_jst, used)
  VALUES (p_user_id, p_feature, v_date, 1)
  ON CONFLICT (user_id, feature, usage_date_jst) DO UPDATE
    SET used = career_daily_usage.used + 1
    WHERE career_daily_usage.used < p_limit
  RETURNING career_daily_usage.used INTO v_used;

  IF v_used IS NULL THEN
    -- 上限到達。予約した operation 行は残さない（明日の同一操作を潰さないため）。
    DELETE FROM public.career_daily_usage_operations
    WHERE user_id = p_user_id
      AND feature = p_feature
      AND usage_date_jst = v_date
      AND operation_id = v_canonical;

    SELECT u.used INTO v_used
    FROM public.career_daily_usage u
    WHERE u.user_id = p_user_id AND u.feature = p_feature AND u.usage_date_jst = v_date;
    RETURN QUERY SELECT 'LIMIT_REACHED'::text, COALESCE(v_used, p_limit), p_limit, v_reset;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'CONSUMED'::text, v_used, p_limit, v_reset;
END $$;

-- 実行権限は service_role のみ（client から直接 RPC できない）。
REVOKE ALL ON FUNCTION public.career_daily_quota_consume(uuid, text, text[], int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.career_daily_quota_consume(uuid, text, text[], int) FROM anon;
REVOKE ALL ON FUNCTION public.career_daily_quota_consume(uuid, text, text[], int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.career_daily_quota_consume(uuid, text, text[], int) TO service_role;

COMMENT ON FUNCTION public.career_daily_quota_consume(uuid, text, text[], int) IS
  'STEP-CAREER-DAILY-QUOTA. 日次利用回数の原子的 check + consume。'
  'JST 日付は本 function 内で決定（client 時計を信用しない）。'
  'outcome=CONSUMED / DEDUPED / LIMIT_REACHED。';

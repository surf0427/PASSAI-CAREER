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
--   ★ Claude Code からは適用しない（この環境に DDL 実行手段が無い）。operator 手動。
--   ★ 適用後、下の「適用状態」を更新すること。
--
-- 適用状態: **未適用**（2026-08-22 時点 / Project B の read-only probe で確認:
--   career_daily_usage・career_daily_usage_operations = PGRST205、
--   career_daily_quota_consume・_settle = PGRST202）。
--
-- 前提: 本ファイルは **単体で適用できる**（依存する set_updated_at() を下で
--   冪等に定義するため、他の career DDL の適用順序に依存しない）。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §0 updated_at を UPDATE 毎に自動更新する共通トリガ関数。
--
--   他の career DDL（career_billing_apply.sql / schema.sql §3）と同一定義。
--   ★ ここで冪等に定義しておかないと、この関数が未定義の DB へ本ファイルを単体適用
--     したときに §3 の CREATE TRIGGER が落ちる（実 Postgres で再現確認済み）。
--     既に定義済みの DB では CREATE OR REPLACE が同じ内容で上書きするだけ。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := timezone('utc', now());
  RETURN NEW;
END;
$$;

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

  -- 実行状態。dedupe は「まだ完了していない実行への再送」だけに効かせる。
  --   in_flight … 実行中（この間に来た同一 digest の request は retry / 二重送信）
  --   settled   … 実行が成功して結果を返し終わった（以降の同一 digest は **新しい実行**）
  state          text        NOT NULL DEFAULT 'in_flight',
  -- in_flight 中に畳んだ再送の回数。上限を超えたら dedupe をやめる（コスト増幅の上限）。
  dedupe_hits    int         NOT NULL DEFAULT 0,
  -- この operation が消費した回数（＝ ユーザーが明示的に実行し直した回数）。
  executions     int         NOT NULL DEFAULT 1,

  started_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT career_daily_usage_operations_pkey
    PRIMARY KEY (user_id, feature, usage_date_jst, operation_id),
  CONSTRAINT career_daily_usage_operations_state_chk
    CHECK (state IN ('in_flight', 'settled')),
  CONSTRAINT career_daily_usage_operations_counts_chk
    CHECK (dedupe_hits >= 0 AND executions >= 1)
);

COMMENT ON TABLE career_daily_usage_operations IS
  'STEP-CAREER-DAILY-QUOTA. 実行中の operation への再送だけを畳む台帳（server 計算の SHA-256 digest）。'
  'state=in_flight のあいだの同一 digest は retry / 二重送信として +0。'
  'settled 後の同一 digest は「ユーザーが明示的に実行し直した」＝ 新しい logical operation として +1。';

-- 日次の掃除（保持ポリシー運用）のための index。
CREATE INDEX IF NOT EXISTS career_daily_usage_operations_date_idx
  ON career_daily_usage_operations (usage_date_jst);

-- ----------------------------------------------------------------------------
-- §3 updated_at trigger（§0 の set_updated_at() を冪等に張る）
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
-- §6 counter helpers — 条件付き UPSERT による原子的 +1。
--
--   conflict 時は行 lock を取ったうえで **最新値**に対して `used < p_limit` を
--   評価するため、並行 request が上限を追い越せない。条件を満たさなければ
--   1 行も返らず、NULL（= 上限到達）を返す。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_daily_quota_increment(
  p_user_id uuid,
  p_feature text,
  p_date    date,
  p_limit   int
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_used int;
BEGIN
  INSERT INTO public.career_daily_usage (user_id, feature, usage_date_jst, used)
  VALUES (p_user_id, p_feature, p_date, 1)
  ON CONFLICT (user_id, feature, usage_date_jst) DO UPDATE
    SET used = career_daily_usage.used + 1
    WHERE career_daily_usage.used < p_limit
  RETURNING career_daily_usage.used INTO v_used;

  RETURN v_used;
END $$;

-- 現在の used（行が無ければ 0、上限到達時は limit へ丸めない素の値）。
CREATE OR REPLACE FUNCTION public.career_daily_quota_used(
  p_user_id uuid,
  p_feature text,
  p_date    date,
  p_limit   int
)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT u.used FROM public.career_daily_usage u
      WHERE u.user_id = p_user_id AND u.feature = p_feature AND u.usage_date_jst = p_date),
    0
  );
$$;

-- ----------------------------------------------------------------------------
-- §6.1 atomic consume function
--
--   check と consume を **1 statement の中**で決める。SELECT してから UPDATE する
--   実装だと、残り 1 回に 2 request が同時に来たとき両方 ALLOW になりうる。
--
--   ★ dedupe の意味論（本 function の中核）
--
--     「同じ入力内容なら永久に同一 operation」にしてはいけない。それだと
--     ユーザーが明示的に「もう一度添削 / 再分析 / 再評価」しても消費されず、
--     同じ内容を繰り返すだけで上限を無限に迂回できてしまう。
--
--     そこで operation は **実行状態**を持つ:
--       - in_flight（実行中）に届いた同一 digest … retry / 二重送信 / timeout 後の再送
--                                                  → DEDUPED（+0）
--       - settled（成功して返し終わった）後の同一 digest
--                                                  … ユーザーによる明示的な再実行
--                                                  → CONSUMED（+1・再 arm）
--     これで「事故の重複は無料 / 意図した再実行は課金」が成立する。
--
--     コスト増幅の上限（濫用対策）:
--       - dedupe_hits が p_max_dedupe_hits に達したら、以降は畳まず消費する。
--         同一 request を並列に浴びせても「1 消費で無制限の AI 実行」にならない。
--       - settle されないまま p_lease_seconds を過ぎた in_flight は stale とみなし、
--         次の同一 digest は新しい実行として消費する（crash / 強制中断で
--         永久に無料になる穴を塞ぐ）。
--
--   outcome:
--     CONSUMED      利用回数を +1 した（呼び出し側は AI を実行してよい）
--     DEDUPED       実行中の同一 operation への再送（+0 で実行してよい）
--     LIMIT_REACHED 本日の上限に到達（呼び出し側は 429 を返し AI を呼ばない）
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_daily_quota_consume(
  p_user_id         uuid,
  p_feature         text,
  p_operation_id    text,
  p_limit           int,
  p_lease_seconds   int,
  p_max_dedupe_hits int
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
  v_date     date;
  v_reset    timestamptz;
  v_used     int;
  v_op       public.career_daily_usage_operations%ROWTYPE;
  v_reusable boolean;
BEGIN
  IF p_user_id IS NULL
     OR p_feature IS NULL OR p_feature = ''
     OR p_operation_id IS NULL OR p_operation_id = ''
     OR p_limit IS NULL OR p_limit <= 0 OR p_limit > 1000
     OR p_lease_seconds IS NULL OR p_lease_seconds <= 0
     OR p_max_dedupe_hits IS NULL OR p_max_dedupe_hits < 0 THEN
    RAISE EXCEPTION 'career_daily_quota_consume: missing/invalid argument';
  END IF;

  -- 日付権威は **DB の JST**。client 時計・呼び出し側の日付は一切受け取らない。
  v_date  := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_reset := ((v_date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo');

  -- (1) 新規 operation を原子的に試みる。勝てば「初回実行」。
  INSERT INTO public.career_daily_usage_operations (
    user_id, feature, usage_date_jst, operation_id, state, dedupe_hits, executions, started_at
  ) VALUES (
    p_user_id, p_feature, v_date, p_operation_id, 'in_flight', 0, 1, now()
  )
  ON CONFLICT (user_id, feature, usage_date_jst, operation_id) DO NOTHING;

  IF FOUND THEN
    v_used := public.career_daily_quota_increment(p_user_id, p_feature, v_date, p_limit);
    IF v_used IS NULL THEN
      -- 上限到達。予約した operation 行は残さない（翌日の同一操作を潰さないため）。
      DELETE FROM public.career_daily_usage_operations
      WHERE user_id = p_user_id AND feature = p_feature
        AND usage_date_jst = v_date AND operation_id = p_operation_id;
      RETURN QUERY SELECT 'LIMIT_REACHED'::text, public.career_daily_quota_used(p_user_id, p_feature, v_date, p_limit), p_limit, v_reset;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'CONSUMED'::text, v_used, p_limit, v_reset;
    RETURN;
  END IF;

  -- (2) 既存 operation。行 lock を取り、並行する同一 digest の判定を直列化する。
  SELECT * INTO v_op
  FROM public.career_daily_usage_operations
  WHERE user_id = p_user_id AND feature = p_feature
    AND usage_date_jst = v_date AND operation_id = p_operation_id
  FOR UPDATE;

  -- 実行中 かつ lease 内 かつ 畳み上限内 → retry / 二重送信として +0。
  v_reusable := v_op.state = 'in_flight'
            AND v_op.started_at > now() - make_interval(secs => p_lease_seconds)
            AND v_op.dedupe_hits < p_max_dedupe_hits;

  IF v_reusable THEN
    UPDATE public.career_daily_usage_operations
    SET dedupe_hits = dedupe_hits + 1
    WHERE user_id = p_user_id AND feature = p_feature
      AND usage_date_jst = v_date AND operation_id = p_operation_id;
    RETURN QUERY SELECT 'DEDUPED'::text, public.career_daily_quota_used(p_user_id, p_feature, v_date, p_limit), p_limit, v_reset;
    RETURN;
  END IF;

  -- (3) settled / stale / 畳み上限超過 → **新しい logical operation** として消費する。
  v_used := public.career_daily_quota_increment(p_user_id, p_feature, v_date, p_limit);
  IF v_used IS NULL THEN
    -- 既存行は消さない（過去の実行記録であり、予約ではない）。
    RETURN QUERY SELECT 'LIMIT_REACHED'::text, public.career_daily_quota_used(p_user_id, p_feature, v_date, p_limit), p_limit, v_reset;
    RETURN;
  END IF;

  UPDATE public.career_daily_usage_operations
  SET state = 'in_flight',
      dedupe_hits = 0,
      executions = executions + 1,
      started_at = now(),
      settled_at = NULL
  WHERE user_id = p_user_id AND feature = p_feature
    AND usage_date_jst = v_date AND operation_id = p_operation_id;

  RETURN QUERY SELECT 'CONSUMED'::text, v_used, p_limit, v_reset;
END $$;

-- ----------------------------------------------------------------------------
-- §7 settle function — 実行が成功して返し終わったことを記録する。
--
--   これ以降、同じ digest で来た request は「ユーザーが明示的に実行し直した」と
--   みなして +1 する。冪等（何度呼んでも結果は同じ）。
--   ★ 失敗した実行では **呼ばない**。失敗のまま in_flight を残すことで、
--     ユーザーの再試行が二重課金にならない（lease 切れで自然に回収される）。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.career_daily_quota_settle(
  p_user_id      uuid,
  p_feature      text,
  p_operation_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL
     OR p_feature IS NULL OR p_feature = ''
     OR p_operation_id IS NULL OR p_operation_id = '' THEN
    RAISE EXCEPTION 'career_daily_quota_settle: missing/invalid argument';
  END IF;

  UPDATE public.career_daily_usage_operations
  SET state = 'settled', settled_at = now()
  WHERE user_id = p_user_id
    AND feature = p_feature
    AND usage_date_jst = (now() AT TIME ZONE 'Asia/Tokyo')::date
    AND operation_id = p_operation_id
    AND state = 'in_flight';
END $$;

-- ----------------------------------------------------------------------------
-- §8 実行権限 — browser / anon / authenticated からは一切呼べない。
--
--   ★ PostgreSQL は関数作成時に PUBLIC へ EXECUTE を暗黙付与する。明示的に
--     REVOKE しないと anon / authenticated が PostgREST 経由で RPC を直接叩き、
--     user_id / feature / limit / operation_id を偽装できてしまう。
--   ★ したがって全 quota 関数について PUBLIC / anon / authenticated から剥奪し、
--     service_role にだけ EXECUTE を与える（server 経由のみ）。
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.career_daily_quota_consume(uuid, text, text, int, int, int)',
    'public.career_daily_quota_increment(uuid, text, date, int)',
    'public.career_daily_quota_used(uuid, text, date, int)',
    'public.career_daily_quota_settle(uuid, text, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
  END LOOP;
END $$;

COMMENT ON FUNCTION public.career_daily_quota_consume(uuid, text, text, int, int, int) IS
  'STEP-CAREER-DAILY-QUOTA. 日次利用回数の原子的 check + consume。'
  'JST 日付は本 function 内で決定（client 時計を信用しない）。'
  'in_flight 中の同一 digest は DEDUPED（retry）/ settled 後は CONSUMED（明示的な再実行）。'
  'EXECUTE は service_role のみ。';

COMMENT ON FUNCTION public.career_daily_quota_settle(uuid, text, text) IS
  'STEP-CAREER-DAILY-QUOTA. 実行成功の記録（冪等）。以降の同一 digest は新しい実行として消費される。';

-- ----------------------------------------------------------------------------
-- §9 適用後の確認（SQL Editor で実行して 4 行とも service_role のみになること）
--
--   SELECT p.proname, p.prosecdef, array_to_string(p.proacl, ' | ') AS acl
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname LIKE 'career_daily_quota%';
--
--   期待: prosecdef = true、acl に anon= / authenticated= / PUBLIC の EXECUTE が無い。
-- ----------------------------------------------------------------------------

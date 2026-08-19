-- ============================================================================
-- career_billing — PASSAI CAREER の Stripe 課金状態（Supabase **Project B**）
-- ============================================================================
--
-- ❗ 適用状態: **未適用**。operator が Supabase SQL Editor（Project B / CAREER 専用 =
--    career_accounts / career_profiles などがある側）で手動実行する。
--    適用後、本ヘッダの「適用状態」を更新すること。
--    ★ Claude Code からは本番 DB へ適用しない（AGENTS §38）。
--
-- ── なぜ受験版 subscriptions を使わないのか ────────────────────────────────
--
--   受験版の課金テーブル（supabase/schema.sql §25-29 の subscriptions /
--   stripe_events）は **Project A** にあり、user_id は Project A の auth.users を指す。
--   CAREER の identity は Project B の auth.users（career_accounts.id と同一空間）なので、
--   受験版テーブルに CAREER の契約を書くと user_id が別 namespace を指す split-brain に
--   なる。よって CAREER 専用に Project B 側で同型のテーブルを持つ。
--   （docs/auth/career_login_design.md / scripts/career-supabase-project-boundary-qa.ts）
--
-- ── 責務の分離 ─────────────────────────────────────────────────────────────
--
--   Stripe                  = billing truth（金銭の正本）
--   webhook                 = Stripe → PASSAI CAREER 同期
--   career_subscriptions    = app 側の entitlement projection
--   auth.users / career_accounts = identity
--
--   ★ 権利判定は career_subscriptions から毎回導出する
--     （lib/careerBilling/entitlementPolicy.ts）。受験版の profiles.plan のような
--     denormalized cache は **作らない**。理由: career_accounts は
--     career_member_privileges_apply.sql で authenticated に UPDATE を GRANT して
--     いるため、そこに plan 列を置くとブラウザから 'premium' へ書き換えられてしまう。
--     受験版はこれを trigger で塞いでいるが、CAREER は cache 自体を持たない方が単純。
--
-- ── テーブル ───────────────────────────────────────────────────────────────
--   §1 career_billing_customers  1 CAREER account : 1 Stripe Customer の canonical mapping
--   §2 career_subscriptions      Stripe Subscription の同期先
--   §3 career_stripe_events      webhook 冪等化ストア
--   §4 GRANT / REVOKE            ★ 明示付与（career table の必須作法）
--
-- 冪等性: 全 DDL は再実行安全（IF NOT EXISTS / DROP POLICY IF EXISTS /
--   DO ブロックの trigger 存在チェック / REVOKE・GRANT は自然に冪等）。
-- ============================================================================

-- updated_at を UPDATE 毎に自動更新する共通トリガ関数（他 career DDL と同一定義。
-- 単体適用でも動くよう冪等に定義する）。
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
-- §1 career_billing_customers — CAREER account ⇄ Stripe Customer の 1:1 mapping
--
--   受験版 checkout は「subscriptions 行があれば customer 再利用、無ければ
--   customer_email で Stripe に自動生成させる」方式で、コード内コメント自身が
--   「重複 Customer リスクは test mode で許容。恒久的解決は後日」と記録している。
--   CAREER は本番前提のため、その既知ギャップを DB 制約で閉じる:
--     - user_id PRIMARY KEY            → 1 account が 2 つの Customer を持てない
--     - stripe_customer_id UNIQUE      → 1 Customer が 2 account に紐づかない
--   checkout を何度中断しても Customer は増えない（lib/careerBilling/customer.ts）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_billing_customers (
  user_id             uuid         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id  text         NOT NULL UNIQUE,
  created_at          timestamptz  NOT NULL DEFAULT timezone('utc', now()),
  updated_at          timestamptz  NOT NULL DEFAULT timezone('utc', now())
);

COMMENT ON TABLE career_billing_customers IS
  'PASSAI CAREER の account(auth.users.id) と Stripe Customer の canonical 1:1 mapping。'
  'checkout / portal は必ず本表経由で customer を解決する（client からは受け取らない）。'
  '書き込みは service_role(webhook / checkout route) のみ。';
COMMENT ON COLUMN career_billing_customers.user_id IS
  'auth.users(id)。CAREER の唯一の所有者キー。';
COMMENT ON COLUMN career_billing_customers.stripe_customer_id IS
  'Stripe Customer ID (cus_...)。UNIQUE により Customer の使い回しを禁止する。';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'career_billing_customers_set_updated_at'
      AND tgrelid = 'public.career_billing_customers'::regclass
  ) THEN
    CREATE TRIGGER career_billing_customers_set_updated_at
      BEFORE UPDATE ON public.career_billing_customers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- §2 career_subscriptions — Stripe Subscription 状態の projection
--
--   設計方針（受験版 subscriptions を踏襲）:
--     - 1 user は時系列で複数 subscription を持ち得る（plan 変更 / 解約 → 再契約）。
--       よって user_id は UNIQUE にしない。
--     - stripe_subscription_id を UNIQUE にし、webhook の upsert conflict target
--       にする。これが **同一 event の再配送で行が増えない**ことの保証。
--     - 「今有効なプラン」の判定は本表を読んで
--       lib/careerBilling/entitlementPolicy.ts の deriveCareerEffectivePlan で導出する。
--       SQL 側では判定しない（policy を 1 箇所に閉じるため）。
--
--   status CHECK について:
--     Stripe が将来 status を追加すると upsert が CHECK 違反で落ち、webhook が
--     transient error（500）→ Stripe retry を繰り返す。検知はできるが自動回復は
--     しないため、その場合は CHECK を緩める migration を別途当てること（受験版と同仕様）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_subscriptions (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id      text         NOT NULL,
  stripe_subscription_id  text         NOT NULL UNIQUE,
  plan                    text         NOT NULL,
  status                  text         NOT NULL,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean      NOT NULL DEFAULT false,
  created_at              timestamptz  NOT NULL DEFAULT timezone('utc', now()),
  updated_at              timestamptz  NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT career_subscriptions_plan_check
    CHECK (plan IN ('basic', 'premium')),
  CONSTRAINT career_subscriptions_status_check
    CHECK (status IN ('trialing', 'active', 'past_due', 'canceled',
                      'incomplete', 'incomplete_expired', 'unpaid', 'paused'))
);

COMMENT ON TABLE career_subscriptions IS
  'PASSAI CAREER の Stripe サブスク状態（Project B）。書き込みは service_role(webhook) のみ。'
  '権利判定は本表から毎回導出する（denormalized な plan cache は持たない）。';
COMMENT ON COLUMN career_subscriptions.user_id IS
  'auth.users(id)。CAREER の所有者キー。';
COMMENT ON COLUMN career_subscriptions.stripe_subscription_id IS
  'Stripe Subscription ID (sub_...)。UNIQUE。webhook 冪等化の upsert conflict target。';
COMMENT ON COLUMN career_subscriptions.plan IS
  'basic | premium。webhook が STRIPE_PRICE_ID_CAREER_* から逆引きして書く。'
  '受験版 Price は一致しないため CAREER の行にはならない。';
COMMENT ON COLUMN career_subscriptions.cancel_at_period_end IS
  '解約予約フラグ。true でも current_period_end までは権利を維持する。';

CREATE INDEX IF NOT EXISTS career_subscriptions_user_id_idx
  ON career_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS career_subscriptions_customer_idx
  ON career_subscriptions(stripe_customer_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'career_subscriptions_set_updated_at'
      AND tgrelid = 'public.career_subscriptions'::regclass
  ) THEN
    CREATE TRIGGER career_subscriptions_set_updated_at
      BEFORE UPDATE ON public.career_subscriptions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;


-- ----------------------------------------------------------------------------
-- §3 career_stripe_events — webhook 冪等化ストア
--
--   Stripe は同一 event を retry で複数回送る前提。event_id を PK にして
--   「既に processed_at が入っていれば何もしない」で再配送を吸収する。
--   payload は raw のまま保存（調査・再処理用）。PII を含み得るため取扱注意。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_stripe_events (
  event_id      text         PRIMARY KEY,
  type          text         NOT NULL,
  payload       jsonb        NOT NULL,
  received_at   timestamptz  NOT NULL DEFAULT timezone('utc', now()),
  processed_at  timestamptz,
  error         text
);

COMMENT ON TABLE career_stripe_events IS
  'PASSAI CAREER の Stripe webhook event 冪等化ストア。event_id PK で再配送を弾く。'
  'service_role のみが読み書きする。payload は PII を含み得る。';
COMMENT ON COLUMN career_stripe_events.processed_at IS
  'NULL=受信したが未処理（次の配送で再処理される）。値あり=処理確定。'
  '永続失敗のときは processed_at を立てたうえで error に理由を残す。';

CREATE INDEX IF NOT EXISTS career_stripe_events_type_idx
  ON career_stripe_events(type);
CREATE INDEX IF NOT EXISTS career_stripe_events_received_idx
  ON career_stripe_events(received_at DESC);


-- ----------------------------------------------------------------------------
-- §4 RLS + GRANT/REVOKE
--
--   ★ career table には GRANT を必ず同梱する（supabase/career_member_privileges_apply.sql
--     の教訓: RLS policy だけ作って GRANT を書かなかった 16 table が、member から
--     SELECT/INSERT/UPDATE/DELETE 一切できず「静かに保存されない」状態になっていた）。
--
--   本 3 表の方針は **全部 server 専用**:
--     - anon          : 一切なし。
--     - authenticated : 一切なし。
--         ブラウザは課金状態を GET /api/career/billing/status（server 判定）から読む。
--         直接 SELECT する実コードが無いので、最小権限の原則により GRANT しない。
--         → 将来ブラウザから直接読む必要が出たら、career_subscriptions にだけ
--            `GRANT SELECT ... TO authenticated` と owner SELECT policy を足すこと。
--            **INSERT/UPDATE/DELETE は絶対に付与しない**（課金状態の client 改竄防止）。
--     - service_role  : ALL（webhook / checkout / portal / status が使う唯一の経路）。
--
--   RLS は GRANT と直交する二重防御として有効化しておく。policy を 1 つも作らない
--   ことで、仮に将来誤って authenticated に GRANT が付いても行は 1 件も見えない。
--   （service_role は BYPASSRLS のため影響を受けない。）
-- ----------------------------------------------------------------------------
ALTER TABLE career_billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE career_subscriptions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE career_stripe_events     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.career_billing_customers FROM anon, authenticated;
REVOKE ALL ON public.career_subscriptions     FROM anon, authenticated;
REVOKE ALL ON public.career_stripe_events     FROM anon, authenticated;

GRANT ALL ON public.career_billing_customers TO service_role;
GRANT ALL ON public.career_subscriptions     TO service_role;
GRANT ALL ON public.career_stripe_events     TO service_role;

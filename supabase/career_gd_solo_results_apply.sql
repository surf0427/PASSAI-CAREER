-- ============================================================
-- career_gd_solo_results — ソロ GD（1人 + AI 参加者）評価履歴の durable mirror
--
-- 背景（この DDL が必要な理由）:
--   ES / 面接 / プレゼン / 企業研究 / 相談 は localStorage canonical +
--   Supabase durable mirror + login 時 restore が揃っているのに、
--   **ソロ GD だけ localStorage（key='careerGdResults'）のみ**だった。
--   端末変更・ブラウザデータ削除で評価履歴が完全に失われる状態であり、
--   他 4 機能と persistence の水準が揃っていない。
--
-- マルチ GD との関係（混ぜない）:
--   マルチ GD は career_gd_room_results（supabase/career_gd_multi_apply.sql §…）が
--   既に durable mirror として存在し、room 単位・service_role 書き込み・
--   participant 単位の共有ランキングという **別のセマンティクス**を持つ。
--   ソロ GD には room が存在せず、評価軸（logic/cooperation/volume/roleExecution/
--   drive/listening）もマルチ（logicalThinking/collaboration/initiative/creativity/
--   persuasiveness/discussionSkill）とは別体系。
--   ★ よって career_gd_room_results を再利用せず、専用テーブルを立てる。
--     既存マルチ GD のテーブル・RLS・hydrate 経路には一切触れない。
--
-- 設計方針（career_features_apply.sql §81〜§92 と完全に同形）:
--   - localStorage が canonical。本テーブルは best-effort durable mirror。
--   - 履歴系なので natural key = UNIQUE(user_id, client_id)。
--     client_id = localStorage 上の CareerGdResult.id（= セッション id）。
--     再保存・login 時 backfill が冪等になる。
--   - AI 出力（feedbacks / matchingHints / theme / transcript / participants）は
--     jsonb で持つ（schema_boundary_policy §10: AI 出力の構造化前 raw を許容）。
--     一覧・絞り込みに使う識別子（format / participation_mode / self_company_grade /
--     favorite）だけ通常カラムへ昇格する。
--   - RLS は owner 直接判定（auth.uid() = user_id）の 4 policy。
--     public / anon から直接読み書きできる policy は作らない。
--
-- 安全性:
--   - 本ファイルは **再実行安全（idempotent）**。
--     CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / policy・trigger は存在チェック付き。
--   - DROP TABLE / TRUNCATE / 既存データ削除は一切行わない。
--   - 既存テーブル（career_gd_rooms / career_gd_room_members / career_gd_room_messages /
--     career_gd_room_results）には触れない。
--   - 前提: pgcrypto / set_updated_at()（schema.sql §3）/ auth.users が既存であること。
--
-- 適用: Supabase SQL Editor（Project B）へ貼り付けて実行する。
--       本 repo からは適用しない（PostgREST のみで DDL 権限を持たないため）。
-- ============================================================

-- ------------------------------------------------------------
-- career_gd_solo_results — ソロ GD 評価履歴（/career/gd ソロプレイ）。
--     localStorage key='careerGdResults'（CareerGdResult[]）が canonical。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_gd_solo_results (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id           text        NOT NULL,
  -- 一覧・絞り込み用に昇格するカラム（本文・評価そのものは jsonb 側に持つ）。
  participation_mode  text        NOT NULL DEFAULT 'solo',
  format              text        NOT NULL DEFAULT '',
  self_role           text        NOT NULL DEFAULT '',
  self_company_grade  text        NOT NULL DEFAULT '',
  time_limit_sec      integer,
  favorite            boolean     NOT NULL DEFAULT false,
  -- AI 出力・スナップショット（構造化前の raw 形式を許容）。
  theme               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  participants        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  transcript          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  feedbacks           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ranking             jsonb,
  matching_hints      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  overall_summary     text        NOT NULL DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_gd_solo_results_natural_key UNIQUE (user_id, client_id)
);

CREATE INDEX IF NOT EXISTS career_gd_solo_results_user_created_idx
  ON career_gd_solo_results (user_id, created_at DESC);

COMMENT ON TABLE career_gd_solo_results IS
  'ソロ GD 評価履歴 mirror。LS key=careerGdResults canonical。'
  'マルチ GD（career_gd_room_results）とは評価軸・書き込み主体・共有範囲が異なる別系統。'
  'feedbacks=全参加者(AI含む)の 6 軸評価+server 算出 totalScore/companyGrade。'
  'matching_hints=本人ぶんの他機能連携ヒント。overall_summary=GD 全体の総括。';

-- ------------------------------------------------------------
-- updated_at trigger（set_updated_at() は schema.sql §3 で定義済み・再定義しない）。
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'career_gd_solo_results_set_updated_at'
      AND tgrelid = 'public.career_gd_solo_results'::regclass
  ) THEN
    CREATE TRIGGER career_gd_solo_results_set_updated_at
      BEFORE UPDATE ON public.career_gd_solo_results
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ------------------------------------------------------------
-- RLS — owner 直接判定（auth.uid() = user_id）の 4 policy を冪等に張る。
--   career_features_apply.sql の RLS ブロックと同形。
-- ------------------------------------------------------------
DO $$
DECLARE
  t text := 'career_gd_solo_results';
BEGIN
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||' owner select') THEN
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (auth.uid() = user_id)', t||' owner select', t);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||' owner insert') THEN
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)', t||' owner insert', t);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||' owner update') THEN
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)', t||' owner update', t);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=t||' owner delete') THEN
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (auth.uid() = user_id)', t||' owner delete', t);
  END IF;
END $$;

-- ------------------------------------------------------------
-- GRANTs — authenticated にだけ最小 DML を付与する。
--
--   背景（初版 DDL の omission）:
--     本 DDL は career_features_apply.sql（§81〜§92）の書き方を写したが、そちらは
--     GRANT 文を持たない。この career プロジェクトは public テーブルへの default
--     privileges が付いていないため、GRANT を書かないと RLS 以前に 42501
--     permission denied で弾かれる（career_gd_multi_apply.sql の GRANT ブロックが
--     同じ事象を STEP-GD-13.5 で記録している）。
--     実 DB 検証で career_gd_solo_results の authenticated が
--     REFERENCES / TRIGGER / TRUNCATE のみ、INSERT / SELECT / UPDATE 欠落と判明したため補う。
--     （既存 career_es_logs / career_interview_results / career_presentation_results /
--       career_profiles は authenticated = INSERT, SELECT, UPDATE を保持しており、
--       本テーブルだけがこの posture から外れていた。）
--
--   方針（最小権限・deny-by-default 維持）:
--     - 付与するのは **SELECT / INSERT / UPDATE のみ**。GD ソロの実操作は
--       lib/supabase/careerGdSolo.ts の upsert（INSERT + UPDATE）と select（SELECT）だけで、
--       削除経路はコード上に存在しないため **DELETE は付与しない**
--       （career_es_logs / career_interview_results / career_presentation_results と同 posture）。
--     - **anon には一切付与しない**（GRANT 無し → 引き続き 42501 で拒否）。
--     - service_role にも付与しない（本テーブルは browser client 専用 mirror であり、
--       既存 browser mirror 群と同じく service_role は使わない）。
--
--   ★ GRANT は RLS の代替ではない。権限の重ね合わせは次のとおり:
--       authenticated  … GRANT が SQL 操作自体を許可する
--       RLS policy     … auth.uid() = user_id で **自分の行だけ**に絞る
--     上の owner policy 4 本はそのまま維持する（GRANT のために RLS を緩めない）。
--
--   idempotent: GRANT は再実行しても no-op。
-- ------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO authenticated;   -- Supabase 既定で付与済みだが冪等に明示
GRANT SELECT, INSERT, UPDATE ON public.career_gd_solo_results TO authenticated;

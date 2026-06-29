-- ============================================================
-- career_* features — Supabase 永続化 DDL apply（STEP-CAREER-SUPABASE-01）
--
-- 就活版（PASSAI CAREER）の既存機能を localStorage canonical のまま、
-- ログイン済み（member）ユーザーの durable mirror として Supabase へ永続化する。
-- career_values（schema.sql §80）/ self_prs §35 / interview_practice_records §53 と
-- 同じ auth-scoped 永続層であり、mirror_events 系統ではない。受験版データには一切関与しない。
--
-- 設計方針:
--   - localStorage が canonical。本テーブル群は best-effort durable mirror。
--   - 1 ユーザーの所有行は auth.uid() = user_id で RLS により閉じる（authenticated）。
--   - 単一レコード系（profile / activities）は UNIQUE(user_id) で 1 ユーザー 1 行・upsert。
--   - 履歴系（self_analysis_results / self_prs / matching_results / es_logs /
--     interview_sessions / interview_results / presentation_sessions /
--     presentation_results / consultation_threads）は natural key
--     UNIQUE(user_id, client_id)。client_id = localStorage 上のレコード id。
--     これで再保存・login 時 backfill が冪等になる。
--   - AI 出力（result / 構造化途中の値）は jsonb で持つ（schema_boundary_policy §10:
--     「AI 出力の構造化前 raw 形式」を許容）。検索したい識別子・状態だけ通常カラムにする。
--
-- 安全性:
--   - 本ファイルは **再実行安全（idempotent）**。CREATE TABLE IF NOT EXISTS /
--     ALTER TABLE ADD COLUMN IF NOT EXISTS / policy・trigger は存在チェック付き。
--   - DROP TABLE / TRUNCATE / 既存データ削除は一切行わない。
--   - 前提: pgcrypto / set_updated_at()（schema.sql §3）/ auth.users が既存であること。
--
-- 正本は supabase/schema.sql（§81 以降）。本ファイルは Supabase SQL Editor 貼り付け用の
-- idempotent apply ヘルパ。
-- ============================================================

-- 共通: updated_at trigger を冪等に張るためのヘルパ的 DO ブロックを各テーブルで使う。
--       set_updated_at() は schema.sql §3 で定義済み（再定義しない）。

-- ------------------------------------------------------------
-- §81 career_profiles — 基本情報/プロフィール（/career/profile）。1 ユーザー 1 行。
--     localStorage key='careerBasicFormData'（CareerProfile）。
--     大学/学部/学科は CareerProfile.preferences[0] 由来。data に正規化済み全体を保持。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_profiles (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             text        NOT NULL DEFAULT '',
  university       text        NOT NULL DEFAULT '',
  faculty          text        NOT NULL DEFAULT '',
  department       text        NOT NULL DEFAULT '',
  grade            text        NOT NULL DEFAULT '',
  graduation_year  text        NOT NULL DEFAULT '',
  gender           text        NOT NULL DEFAULT '',
  data             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_profiles_user_unique UNIQUE (user_id)
);
ALTER TABLE career_profiles ADD COLUMN IF NOT EXISTS name            text  NOT NULL DEFAULT '';
ALTER TABLE career_profiles ADD COLUMN IF NOT EXISTS university      text  NOT NULL DEFAULT '';
ALTER TABLE career_profiles ADD COLUMN IF NOT EXISTS faculty         text  NOT NULL DEFAULT '';
ALTER TABLE career_profiles ADD COLUMN IF NOT EXISTS department      text  NOT NULL DEFAULT '';
ALTER TABLE career_profiles ADD COLUMN IF NOT EXISTS grade           text  NOT NULL DEFAULT '';
ALTER TABLE career_profiles ADD COLUMN IF NOT EXISTS graduation_year text  NOT NULL DEFAULT '';
ALTER TABLE career_profiles ADD COLUMN IF NOT EXISTS gender          text  NOT NULL DEFAULT '';
ALTER TABLE career_profiles ADD COLUMN IF NOT EXISTS data            jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON TABLE career_profiles IS
  'STEP-CAREER-SUPABASE-01. 就活版プロフィールの auth-scoped durable mirror。'
  'localStorage key=careerBasicFormData が canonical。1 ユーザー 1 行（UNIQUE(user_id)）。'
  'data に正規化済み CareerProfile 全体（jsonb）。name/university/... は検索/表示用の昇格カラム。';

-- ------------------------------------------------------------
-- §82 career_activities — 活動整理/ガクチカ素材（/career/activity）。1 ユーザー 1 行。
--     localStorage key='careerActivityData'（CareerActivity, 18 セクションの単一文書）。
--     構造が大きく頻繁に進化するため data 全体を jsonb で持つ（§10: opaque 構造化 raw）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_activities (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_activities_user_unique UNIQUE (user_id)
);
COMMENT ON TABLE career_activities IS
  'STEP-CAREER-SUPABASE-01. 就活版「活動整理」の auth-scoped durable mirror。'
  'localStorage key=careerActivityData が canonical。1 ユーザー 1 行。data=CareerActivity 全体（jsonb）。';

-- ------------------------------------------------------------
-- §83 career_self_analysis_results — 自己分析の結果履歴（/career/self-analysis）。
--     localStorage key='careerSelfAnalysisLogs'（CareerSelfAnalysisLog[]）。
--     careerAnalyzeState（壁打ち作業中メモリ）は ephemeral のため永続化対象外。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_self_analysis_results (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   text        NOT NULL,
  user_input  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_self_analysis_results_natural_key UNIQUE (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS career_self_analysis_results_user_created_idx
  ON career_self_analysis_results (user_id, created_at DESC);
COMMENT ON TABLE career_self_analysis_results IS
  'STEP-CAREER-SUPABASE-01. 自己分析の結果履歴 mirror。LS key=careerSelfAnalysisLogs canonical。'
  'natural key=(user_id, client_id)。client_id=CareerSelfAnalysisLog.id。';

-- ------------------------------------------------------------
-- §84 career_self_prs — 自己 PR カード（/career/self-analysis）。
--     localStorage key='careerSelfPRs'（SelfPR[]、共有ドメイン型 @/types/selfPR）。
--     受験版 self_prs §35 とは別テーブル（就活データを混ぜない）。data に SelfPR 全体。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_self_prs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   text        NOT NULL,
  data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_self_prs_natural_key UNIQUE (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS career_self_prs_user_created_idx
  ON career_self_prs (user_id, created_at DESC);
COMMENT ON TABLE career_self_prs IS
  'STEP-CAREER-SUPABASE-01. 就活版 自己 PR カード mirror。LS key=careerSelfPRs canonical。'
  'natural key=(user_id, client_id)。client_id=SelfPR.id。受験版 self_prs §35 とは別テーブル。';

-- ------------------------------------------------------------
-- §85 career_matching_results — 企業マッチング結果履歴（/career/matching）。
--     localStorage key='careerMatchingResults'（CareerMatchingLog[]）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_matching_results (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   text        NOT NULL,
  user_input  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_matching_results_natural_key UNIQUE (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS career_matching_results_user_created_idx
  ON career_matching_results (user_id, created_at DESC);
COMMENT ON TABLE career_matching_results IS
  'STEP-CAREER-SUPABASE-01. 企業マッチング結果履歴 mirror。LS key=careerMatchingResults canonical。';

-- ------------------------------------------------------------
-- §86 career_es_logs — ES 生成/添削ログ（/career/es）。
--     localStorage key='careerEsLogs'（CareerEsLog[]）。
--     favorite / submitted は絞り込み用に昇格。meta に company/question/charLimit/
--     selectionType/industry/jobType/sourceLogId/sourceType をまとめる。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_es_logs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id      text        NOT NULL,
  user_input     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  edited_result  jsonb,
  favorite       boolean     NOT NULL DEFAULT false,
  submitted      boolean     NOT NULL DEFAULT false,
  meta           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_es_logs_natural_key UNIQUE (user_id, client_id)
);
ALTER TABLE career_es_logs ADD COLUMN IF NOT EXISTS edited_result jsonb;
ALTER TABLE career_es_logs ADD COLUMN IF NOT EXISTS favorite  boolean NOT NULL DEFAULT false;
ALTER TABLE career_es_logs ADD COLUMN IF NOT EXISTS submitted boolean NOT NULL DEFAULT false;
ALTER TABLE career_es_logs ADD COLUMN IF NOT EXISTS meta      jsonb   NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS career_es_logs_user_created_idx
  ON career_es_logs (user_id, created_at DESC);
COMMENT ON TABLE career_es_logs IS
  'STEP-CAREER-SUPABASE-01. ES 生成/添削ログ mirror。LS key=careerEsLogs canonical。'
  'favorite/submitted は昇格カラム。meta=その他メタ情報の jsonb。';

-- ------------------------------------------------------------
-- §87 career_interview_sessions — 面接セッション（/career/interview）。upsert。
--     localStorage key='careerInterviewSessions'（CareerInterviewSession[]）。
--     進行に応じて in-place 更新されるため upsert（onConflict=(user_id, client_id)）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_interview_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id       text        NOT NULL,
  status          text        NOT NULL DEFAULT 'in_progress',
  mode            text        NOT NULL DEFAULT '',
  interview_type  text        NOT NULL DEFAULT '',
  turns           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  max_turns       integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_interview_sessions_natural_key UNIQUE (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS career_interview_sessions_user_updated_idx
  ON career_interview_sessions (user_id, updated_at DESC);
COMMENT ON TABLE career_interview_sessions IS
  'STEP-CAREER-SUPABASE-01. 面接セッション mirror。LS key=careerInterviewSessions canonical。'
  '進行中に upsert。turns=会話履歴の jsonb。';

-- ------------------------------------------------------------
-- §88 career_interview_results — 面接の最終評価履歴（/career/interview）。
--     localStorage key='careerInterviewResults'（CareerInterviewResult[]）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_interview_results (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id       text        NOT NULL,
  mode            text        NOT NULL DEFAULT '',
  interview_type  text        NOT NULL DEFAULT '',
  turns           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  result          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_interview_results_natural_key UNIQUE (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS career_interview_results_user_created_idx
  ON career_interview_results (user_id, created_at DESC);
COMMENT ON TABLE career_interview_results IS
  'STEP-CAREER-SUPABASE-01. 面接の最終評価履歴 mirror。LS key=careerInterviewResults canonical。';

-- ------------------------------------------------------------
-- §89 career_presentation_sessions — プレゼンセッション（/career/presentation）。upsert。
--     localStorage key='careerPresentationSessions'（CareerPresentationSession[]）。
--     受験版 presentation_sessions §63 とは別テーブル（録画/Storage/課金は未移植）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_presentation_sessions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id          text        NOT NULL,
  status             text        NOT NULL DEFAULT 'in_progress',
  presentation_type  text        NOT NULL DEFAULT '',
  mode               text        NOT NULL DEFAULT '',
  theme              text        NOT NULL DEFAULT '',
  time_limit_sec     integer,
  duration_sec       integer,
  transcript         text        NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_presentation_sessions_natural_key UNIQUE (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS career_presentation_sessions_user_updated_idx
  ON career_presentation_sessions (user_id, updated_at DESC);
COMMENT ON TABLE career_presentation_sessions IS
  'STEP-CAREER-SUPABASE-01. プレゼンセッション mirror。LS key=careerPresentationSessions canonical。'
  '受験版 presentation_sessions §63 とは別テーブル。録画/Storage/課金は未移植。';

-- ------------------------------------------------------------
-- §90 career_presentation_results — プレゼン評価履歴（/career/presentation）。
--     localStorage key='careerPresentationResults'（CareerPresentationResult[]）。
--     qa は result 画面の Q&A（任意）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_presentation_results (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id          text        NOT NULL,
  presentation_type  text        NOT NULL DEFAULT '',
  mode               text        NOT NULL DEFAULT '',
  theme              text        NOT NULL DEFAULT '',
  time_limit_sec     integer,
  duration_sec       integer,
  transcript         text        NOT NULL DEFAULT '',
  result             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  qa                 jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_presentation_results_natural_key UNIQUE (user_id, client_id)
);
ALTER TABLE career_presentation_results ADD COLUMN IF NOT EXISTS qa jsonb;
CREATE INDEX IF NOT EXISTS career_presentation_results_user_created_idx
  ON career_presentation_results (user_id, created_at DESC);
COMMENT ON TABLE career_presentation_results IS
  'STEP-CAREER-SUPABASE-01. プレゼン評価履歴 mirror。LS key=careerPresentationResults canonical。'
  'qa=結果画面の Q&A（任意 jsonb）。';

-- ------------------------------------------------------------
-- §91 career_consultation_threads — 就活相談 AI のスレッド（/career/consultation）。upsert。
--     localStorage key='careerConsultationLogs'（CareerConsultationThread[]）。
--     messages はスレッド内メッセージ配列を jsonb で同居（MVP: 別 messages テーブルにしない）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_consultation_threads (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   text        NOT NULL,
  title       text        NOT NULL DEFAULT '',
  messages    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_consultation_threads_natural_key UNIQUE (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS career_consultation_threads_user_updated_idx
  ON career_consultation_threads (user_id, updated_at DESC);
COMMENT ON TABLE career_consultation_threads IS
  'STEP-CAREER-SUPABASE-01. 就活相談 AI のスレッド mirror。LS key=careerConsultationLogs canonical。'
  'messages=スレッド内メッセージ配列（jsonb）。MVP では別 messages テーブルに分割しない。';

-- ============================================================
-- updated_at trigger（全テーブル）— set_updated_at()（schema.sql §3）を冪等に張る。
-- ============================================================
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'career_profiles',
    'career_activities',
    'career_self_analysis_results',
    'career_self_prs',
    'career_matching_results',
    'career_es_logs',
    'career_interview_sessions',
    'career_interview_results',
    'career_presentation_sessions',
    'career_presentation_results',
    'career_consultation_threads'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = t || '_set_updated_at'
        AND tgrelid = ('public.' || t)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        t || '_set_updated_at', t
      );
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- RLS — 全テーブルで owner 直接判定（auth.uid() = user_id）の 4 policy を冪等に張る。
--   Anonymous Auth 経由でも role=authenticated として届くので policy 対象は authenticated。
--   public / anon から直接全件読み書きできる policy は作らない（禁止）。
--   career_values §81 / self_prs §37 / interview_practice_records §55 と同形。
-- ============================================================
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'career_profiles',
    'career_activities',
    'career_self_analysis_results',
    'career_self_prs',
    'career_matching_results',
    'career_es_logs',
    'career_interview_sessions',
    'career_interview_results',
    'career_presentation_sessions',
    'career_presentation_results',
    'career_consultation_threads'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
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
  END LOOP;
END $$;

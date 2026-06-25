-- ============================================================
-- career_values — DDL apply (STEP-CAREER-VALUES-01)
-- supabase/schema.sql §80 の逐語スライス。正本は schema.sql。
-- 本ファイルは Supabase SQL Editor 貼り付け用の apply ヘルパ。
-- 前提: pgcrypto / set_updated_at()（schema.sql §3）/ auth.users が既存であること。
-- ============================================================

-- 80. career_values — 「就活軸整理」(/career/values) の auth-scoped 永続ミラー
--     STEP-CAREER-VALUES-01。
--
--     就活版（career）の「就活軸整理」機能（重視/避けたい条件・業界・職種・働き方・
--     会社タイプ・キャリア志向・社風のチェック項目 + 各カテゴリ備考 + 総合備考）の
--     durable mirror。localStorage（key='careerValues'）が canonical で、本 table は
--     ログイン済みユーザー（member）の同期先（best-effort durable mirror）。
--     self_prs §35 / interview_practice_records §53 と同じ auth-scoped 永続層であり、
--     mirror_events 系統ではない。受験版データには一切関与しない。
--
--     1 ユーザー 1 行（UNIQUE(user_id)）。保存は upsert（onConflict=user_id）で冪等。
--     チェック項目の選択は 8 カテゴリそれぞれ jsonb 配列（日本語ラベル文字列の配列）。
--     notes は各カテゴリの自由記述備考の jsonb マップ、overall_note は総合備考テキスト。
--     これらは AI（自己分析・ES・面接・企業マッチング・企業分析・相談）が後から参照する
--     構造化データであり、DB は jsonb の shape を強制しない（既存 durable table と同方針）。
--
--     前提: pgcrypto / set_updated_at()（§3）/ auth.users が既存であること。
-- ============================================================
CREATE TABLE career_values (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  priorities           jsonb        NOT NULL DEFAULT '[]'::jsonb,
  avoidances           jsonb        NOT NULL DEFAULT '[]'::jsonb,
  industries           jsonb        NOT NULL DEFAULT '[]'::jsonb,
  job_types            jsonb        NOT NULL DEFAULT '[]'::jsonb,
  work_styles          jsonb        NOT NULL DEFAULT '[]'::jsonb,
  company_types        jsonb        NOT NULL DEFAULT '[]'::jsonb,
  career_goals         jsonb        NOT NULL DEFAULT '[]'::jsonb,
  culture_preferences  jsonb        NOT NULL DEFAULT '[]'::jsonb,
  notes                jsonb        NOT NULL DEFAULT '{}'::jsonb,
  overall_note         text         NOT NULL DEFAULT '',
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT career_values_user_unique UNIQUE (user_id)
);

COMMENT ON TABLE career_values IS
  'STEP-CAREER-VALUES-01. 就活版「就活軸整理」の auth-scoped durable mirror。'
  'localStorage key=careerValues が canonical。1 ユーザー 1 行（UNIQUE(user_id)）。'
  '8 カテゴリの選択（jsonb 配列）+ notes（カテゴリ別備考 jsonb）+ overall_note（総合備考）。'
  'AI（自己分析/ES/面接/企業マッチング/企業分析/相談）が参照する構造化データ。';

COMMENT ON COLUMN career_values.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id. UNIQUE で 1 行/ユーザー。';

COMMENT ON COLUMN career_values.priorities IS
  'A. 重視する条件。チェックされた日本語ラベルの jsonb 配列。';
COMMENT ON COLUMN career_values.avoidances IS
  'B. 避けたい条件。チェックされた日本語ラベルの jsonb 配列。';
COMMENT ON COLUMN career_values.industries IS
  'C. 興味ある業界。チェックされた日本語ラベルの jsonb 配列。';
COMMENT ON COLUMN career_values.job_types IS
  'D. 興味ある職種。チェックされた日本語ラベルの jsonb 配列。';
COMMENT ON COLUMN career_values.work_styles IS
  'E. 働き方の希望。チェックされた日本語ラベルの jsonb 配列。';
COMMENT ON COLUMN career_values.company_types IS
  'F. 会社タイプ。チェックされた日本語ラベルの jsonb 配列。';
COMMENT ON COLUMN career_values.career_goals IS
  'G. キャリア志向。チェックされた日本語ラベルの jsonb 配列。';
COMMENT ON COLUMN career_values.culture_preferences IS
  'H. 人間関係・社風。チェックされた日本語ラベルの jsonb 配列。';
COMMENT ON COLUMN career_values.notes IS
  'カテゴリ別の自由記述備考（{ priorities, avoidances, ... } の jsonb マップ）。'
  'チェック項目で拾いきれない例外・ニュアンスを回収する。';
COMMENT ON COLUMN career_values.overall_note IS
  '総合備考（全カテゴリ横断の自由記述テキスト）。';

-- trigger: keep updated_at fresh on UPDATE（upsert の ON CONFLICT DO UPDATE 経路を含む）。
CREATE TRIGGER career_values_set_updated_at
  BEFORE UPDATE ON career_values
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- RLS — career_values（owner 直接判定 / 全 CRUD）。
--   Anonymous Auth 経由でも role=authenticated として届くので policy 対象は authenticated。
--   すべての行操作を auth.uid() = user_id で閉じる（self_prs §37 / interview_practice_records
--   §55 と同形）。UPDATE policy は upsert の DO UPDATE 経路に必要。
ALTER TABLE career_values ENABLE ROW LEVEL SECURITY;

CREATE POLICY "career_values owner select"
  ON career_values
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "career_values owner insert"
  ON career_values
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "career_values owner update"
  ON career_values
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "career_values owner delete"
  ON career_values
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

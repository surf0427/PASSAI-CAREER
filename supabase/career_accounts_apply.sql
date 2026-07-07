-- ============================================================================
-- career_accounts — 就活版（CAREER）の auth-canonical アカウント行
-- ============================================================================
--
-- 目的:
--   就活版のログイン（email OTP）に紐づく identity 行。表示用ID（display_user_id）と
--   補助のメールを保持する。受験版 profiles と同方針だが **別テーブル・別 namespace**。
--
-- 所有者契約:
--   - id は auth.users(id)（= auth.uid()）。**所有者判定 / RLS / 保存キーの唯一の正本**。
--   - display_user_id は **表示用のみ**。UNIQUE だが所有者判定・FK・認証には使わない。
--   - email は復帰・表示の補助（nullable）。ログイン識別には使わない。
--
-- 既存テーブルとの関係:
--   - 既存 career_profiles（supabase/career_features_apply.sql）は localStorage
--     （key=careerBasicFormData）の data mirror で key=user_id。**本テーブルとは別物**。
--     名前衝突を避けるため identity 行は career_accounts という別名にしている。
--   - 受験版 profiles / 課金テーブルには一切触れない。
--
-- 適用: career 専用 Supabase プロジェクトに対して本ファイルを実行する。冪等
--   （IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS）。
-- ----------------------------------------------------------------------------

-- updated_at を UPDATE 毎に自動更新するトリガ関数（schema.sql §3 と同等。単体適用でも
-- 動くよう冪等に定義）。
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := timezone('utc', now());
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS career_accounts (
  id               uuid         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- display_user_id は UNIQUE だが **nullable**。受験版 profiles と同じく、ログイン時に
  -- account 行を作成し（display_user_id=null）、表示IDは onboarding で後から設定する。
  -- NOT NULL にするとログイン直後の行作成が詰まり導線が硬直するため nullable に統一。
  display_user_id  text         UNIQUE,
  email            text,
  created_at       timestamptz  NOT NULL DEFAULT timezone('utc', now()),
  updated_at       timestamptz  NOT NULL DEFAULT timezone('utc', now())
);

-- 既に NOT NULL 版で適用済みの環境を冪等に nullable へ緩める（再実行安全）。
ALTER TABLE career_accounts ALTER COLUMN display_user_id DROP NOT NULL;

COMMENT ON TABLE career_accounts IS
  '就活版(CAREER)の auth-canonical アカウント行。id = auth.users.id (= auth.uid()) が '
  '唯一の所有者キー。display_user_id は表示用(UNIQUE)で所有者判定/FK/認証には使わない。'
  'email はログイン識別に使わない(identity は常に id)。受験版 profiles とは別テーブル。';

COMMENT ON COLUMN career_accounts.id IS
  'auth.users(id). 所有者 identity（RLS / 権限はすべてこの列で判定）。';
COMMENT ON COLUMN career_accounts.display_user_id IS
  'ユーザーが選ぶ表示用ID。UNIQUE だが所有者キーには絶対に使わない。';
COMMENT ON COLUMN career_accounts.email IS
  '表示・復帰補助のメール（nullable）。ログイン識別には使わない。';

-- updated_at トリガ（冪等に張る）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'career_accounts_set_updated_at'
      AND tgrelid = 'public.career_accounts'::regclass
  ) THEN
    CREATE TRIGGER career_accounts_set_updated_at
      BEFORE UPDATE ON public.career_accounts
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- RLS — 所有者判定は auth.uid() = id に統一（display_user_id では判定しない）。
--   select / insert / update / delete のすべてを自分の行のみに閉じる。
--   （他人の display_user_id は SELECT できないため、重複判定は UNIQUE 制約が担う。）
-- ----------------------------------------------------------------------------
ALTER TABLE career_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "career_accounts owner select" ON career_accounts;
CREATE POLICY "career_accounts owner select"
  ON career_accounts
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "career_accounts owner insert" ON career_accounts;
CREATE POLICY "career_accounts owner insert"
  ON career_accounts
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "career_accounts owner update" ON career_accounts;
CREATE POLICY "career_accounts owner update"
  ON career_accounts
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "career_accounts owner delete" ON career_accounts;
CREATE POLICY "career_accounts owner delete"
  ON career_accounts
  FOR DELETE
  TO authenticated
  USING (auth.uid() = id);

-- ============================================================
-- career_user_events — 匿名集計の土台となる「本文を持たない観測ログ」（STEP-CAREER-EVENTLOG-P1）
--
-- 目的:
--   各機能の完了イベントや低リスク metadata を、本文なしで安全に記録する土台。
--   将来の匿名集計・利用傾向分析・集合知の一次データにする（P1 では記録のみ。表示・集計はしない）。
--
-- 設計方針（append-only 観測ログ。mirror ではない）:
--   - 本テーブルは「本文を持たない観測ログ」。ES 本文・面接回答・相談本文・自己分析回答・
--     企業研究 verifiedText / raw・GD transcript / message・氏名・メール・大学名・生スコアの詳細値・
--     自由記述の原文・prompt 全文・AI response 全文は **絶対に入れない**。
--     混入防止は書き込み側（lib/careerEvents/sanitize.ts の allowlist）で担保する。
--   - 1 ユーザーの所有行は auth.uid() = user_id で RLS により閉じる（authenticated）。
--   - append-only。UPDATE / DELETE の policy は張らない（ログ完全性のため）。退会時は
--     auth.users への FK ON DELETE CASCADE で自動削除される。
--   - GD multiplayer 系（career_gd_*_apply.sql）の deny-by-default とは別系統。
--     こちらは既存 career mirror テーブル（career_features_apply.sql）と同じ owner-scoped。
--
-- 配置:
--   career_user_events は独立した新規サブシステムのため、GD multi（career_gd_multi_apply.sql 等）と
--   同様に **自己完結の idempotent apply ファイル**として持つ（152KB の schema.sql には追記しない）。
--
-- 安全性:
--   - 本ファイルは **再実行安全（idempotent）**。CREATE TABLE IF NOT EXISTS /
--     CREATE INDEX IF NOT EXISTS / policy は存在チェック付き。
--   - DROP TABLE / TRUNCATE / 既存データ削除は一切行わない。
--   - 前提: pgcrypto（gen_random_uuid）/ auth.users が既存であること。
-- ============================================================

CREATE TABLE IF NOT EXISTS career_user_events (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_event_id    text        NULL,
  event_type         text        NOT NULL,
  feature            text        NOT NULL,
  company_id         uuid        NULL,
  industry           text        NULL,
  job_type           text        NULL,
  selection_phase    text        NULL,
  score_band         text        NULL,
  weakness_category  text        NULL,
  next_action        text        NULL,
  completion_status  text        NULL,
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- client_event_id が非 null のときだけ (user_id, client_event_id) を一意にする部分 unique index。
-- fire-and-forget の二重記録を冪等に吸収するための任意 key（null 許容のイベントは重複可）。
CREATE UNIQUE INDEX IF NOT EXISTS career_user_events_client_event_uniq
  ON career_user_events (user_id, client_event_id)
  WHERE client_event_id IS NOT NULL;

-- 集計・自分の履歴取得用の index。
CREATE INDEX IF NOT EXISTS career_user_events_user_occurred_idx
  ON career_user_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS career_user_events_feature_type_idx
  ON career_user_events (feature, event_type);
CREATE INDEX IF NOT EXISTS career_user_events_industry_occurred_idx
  ON career_user_events (industry, occurred_at DESC);
CREATE INDEX IF NOT EXISTS career_user_events_job_type_occurred_idx
  ON career_user_events (job_type, occurred_at DESC);

COMMENT ON TABLE career_user_events IS
  'STEP-CAREER-EVENTLOG-P1. 本文を持たない観測ログ（append-only）。将来の匿名集計の一次データ。'
  'ES/面接/相談/自己分析/企業研究の本文・GD transcript・氏名/メール/大学名・生スコア詳細値・'
  '自由記述原文・prompt/response 全文は保存しない（書き込み側 allowlist で担保）。'
  'owner-scoped RLS（auth.uid()=user_id）。UPDATE/DELETE policy なし＝append-only。退会は FK CASCADE。';

-- ============================================================
-- RLS — owner が自分の行だけ SELECT / INSERT できる（append-only なので UPDATE/DELETE policy は張らない）。
--   Anonymous Auth 経由でも role=authenticated として届くため policy 対象は authenticated。
--   public / anon から直接読み書きできる policy は作らない（禁止）。
-- ============================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.career_user_events ENABLE ROW LEVEL SECURITY';

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='career_user_events'
      AND policyname='career_user_events owner select'
  ) THEN
    EXECUTE 'CREATE POLICY "career_user_events owner select" ON public.career_user_events '
         || 'FOR SELECT TO authenticated USING (auth.uid() = user_id)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='career_user_events'
      AND policyname='career_user_events owner insert'
  ) THEN
    EXECUTE 'CREATE POLICY "career_user_events owner insert" ON public.career_user_events '
         || 'FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)';
  END IF;
END $$;

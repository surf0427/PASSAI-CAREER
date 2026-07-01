-- ============================================================
-- career_gd_* multi — GD Phase2「合言葉参加型マルチGD」DB 基盤 DDL apply（STEP-GD-10）
--
-- 就活版（PASSAI CAREER）の GD（グループディスカッション）Phase2 マルチプレイ用。
-- Phase1 ソロGD は localStorage canonical のまま（careerGdSessions / careerGdResults）で不変。
-- 本テーブル群は「複数ユーザーが共有する状態」を扱うため server 正本（mirror ではない）。
-- 受験版データ・既存 career_* テーブルには一切関与しない。
--
-- 【Phase2 確定方針（本 DDL の前提）】
--   - Phase2 マルチは member ログイン必須。guest 参加は不可（auth.uid() を持つ user のみ）。
--   - 合言葉は MVP では 6 桁数字コード。DB には平文を保存しない。
--       join_code_hash = HMAC_SHA256(normalized_code, server_side_pepper) を保存（deterministic）。
--       pepper は server-only env（CAREER_GD_JOIN_CODE_PEPPER、無ければ SUPABASE_SERVICE_ROLE_KEY）。
--       deterministic なので「同じ 6 桁コード＝同じ hash」となり、waiting 中の
--       UNIQUE(join_code_hash) が平文コードの重複を正しく防ぐ（room ごとの salt は使わない）。
--       平文コードは作成 API 応答で 1 回だけ host に返す（表示・共有用。DB には残さない）。
--   - code_expires_at（作成から 30 分想定）を過ぎた waiting room は join 不可。
--   - join 可能なのは status='waiting' のみ。active / finished / cancelled には join 不可。
--   - RLS は「API ゲートウェイ方式」。クライアントから本テーブルを直接叩かせない。
--       service-role を使う API route（app/api/career/gd/room/**）だけが DB 操作する前提で、
--       認証・参加権限・host 権限はアプリ層（API route）で検証する。
--       → 本 DDL では anon/authenticated への許可ポリシーを付けない（deny-by-default）。
--   - AI 参加者は user_id = NULL / is_ai = true で表現する。
--   - Realtime は Phase3。Phase2 は 2〜3 秒ポーリング＋手動更新で進行する。
--   - ランダムマッチングは Phase3。音声 / WebRTC も Phase3。
--
-- 安全性:
--   - 本ファイルは **再実行安全（idempotent）**。CREATE TABLE IF NOT EXISTS /
--     CREATE INDEX IF NOT EXISTS / trigger・RLS は存在チェック付き DO ブロック。
--   - DROP TABLE / TRUNCATE / 既存データ削除は一切行わない。
--   - 既存テーブル（受験版・既存 career_*）への ALTER は行わない（新規テーブルのみ）。
--     （join_code_hash はアプリ層で HMAC 生成するため DB 側 digest は使わない）
--   - 前提: pgcrypto（gen_random_uuid）/ set_updated_at()（schema.sql §3）/
--     auth.users が既存であること。
--
-- 注意: 本ファイルはまだ Supabase へ適用しない（STEP-GD-10 は DDL / checklist 追加のみ）。
--       適用手順・検証は docs/gd/gd_multi_post_apply_checklist.md を参照。
-- ============================================================

-- ------------------------------------------------------------
-- ① career_gd_rooms — ルーム本体。合言葉（hash）・状態・テーマ・想定人数などを持つ。
--    1 room = 1 GD セッション。status: waiting → active → finished（任意時点で cancelled）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_gd_rooms (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id              uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status                    text        NOT NULL DEFAULT 'waiting',
  format                    text        NOT NULL DEFAULT 'free',
  theme                     jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- GdTheme（start 時に確定）
  time_limit_sec            int         NOT NULL DEFAULT 900,
  planned_participant_count int         NOT NULL DEFAULT 4,
  join_code_hash            text        NOT NULL,                       -- HMAC(code, pepper)。平文は保存しない
  code_expires_at           timestamptz NOT NULL,
  started_at                timestamptz,
  finished_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_gd_rooms_status_chk
    CHECK (status IN ('waiting', 'active', 'finished', 'cancelled')),
  CONSTRAINT career_gd_rooms_format_chk
    CHECK (format IN ('free', 'case', 'abstract')),
  CONSTRAINT career_gd_rooms_planned_count_chk
    CHECK (planned_participant_count BETWEEN 2 AND 8),
  CONSTRAINT career_gd_rooms_time_limit_chk
    CHECK (time_limit_sec BETWEEN 300 AND 1800)
);

-- 同じ合言葉（hash）で waiting 中の room は 1 つだけ（active 以降は対象外＝再利用可）。
CREATE UNIQUE INDEX IF NOT EXISTS career_gd_rooms_waiting_code_uniq
  ON career_gd_rooms (join_code_hash) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS career_gd_rooms_host_idx
  ON career_gd_rooms (host_user_id);
CREATE INDEX IF NOT EXISTS career_gd_rooms_status_idx
  ON career_gd_rooms (status);
CREATE INDEX IF NOT EXISTS career_gd_rooms_code_expires_idx
  ON career_gd_rooms (code_expires_at);

-- ------------------------------------------------------------
-- ② career_gd_room_members — 参加者（人間 + AI 補完を混在）。
--    AI は user_id = NULL / is_ai = true。participant_id で transcript と突合する。
--    role は開始時に assignRoles で全員へランダム割当。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_gd_room_members (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        uuid        NOT NULL REFERENCES career_gd_rooms(id) ON DELETE CASCADE,
  user_id        uuid        REFERENCES auth.users(id) ON DELETE CASCADE,  -- AI は NULL
  is_ai          boolean     NOT NULL DEFAULT false,
  is_host        boolean     NOT NULL DEFAULT false,
  participant_id text        NOT NULL,                       -- GdParticipant.id（transcript と対応）
  display_name   text        NOT NULL DEFAULT '',
  role           text        NOT NULL DEFAULT 'member',
  persona        jsonb,                                      -- AI のみ（assertiveness / style）
  joined_at      timestamptz NOT NULL DEFAULT now(),
  left_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_gd_room_members_role_chk
    CHECK (role IN ('facilitator', 'scribe', 'timekeeper', 'presenter', 'member')),
  -- 同一ユーザーは 1 room に 1 回だけ。AI 行は user_id=NULL のため UNIQUE の対象外（複数可）。
  CONSTRAINT career_gd_room_members_user_uniq UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS career_gd_room_members_room_idx
  ON career_gd_room_members (room_id);
CREATE INDEX IF NOT EXISTS career_gd_room_members_user_idx
  ON career_gd_room_members (user_id);

-- ------------------------------------------------------------
-- ③ career_gd_room_messages — 発言ログ。seq で室内順序を保証。client_msg_id で二重投稿防止。
--    kind='system' は進行アナウンス。AI 発言は sender_user_id=NULL。
--    （Phase3 で Realtime 購読対象。Phase2 はポーリングで after=<seq> 取得）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_gd_room_messages (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        uuid        NOT NULL REFERENCES career_gd_rooms(id) ON DELETE CASCADE,
  participant_id text        NOT NULL,                       -- 発言者（human / ai 共通）
  sender_user_id uuid        REFERENCES auth.users(id) ON DELETE SET NULL,  -- 人間のみ
  seq            bigint      NOT NULL,                       -- 室内連番（順序保証・サーバ採番）
  content        text        NOT NULL,
  kind           text        NOT NULL DEFAULT 'speech',
  client_msg_id  text,                                       -- 二重投稿防止（クライアント採番）
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_gd_room_messages_kind_chk
    CHECK (kind IN ('speech', 'system')),
  CONSTRAINT career_gd_room_messages_seq_uniq   UNIQUE (room_id, seq),
  -- client_msg_id は NULL 可（system 等）。UNIQUE は複数 NULL を許容するので衝突しない。
  CONSTRAINT career_gd_room_messages_dedup_uniq UNIQUE (room_id, client_msg_id)
);

CREATE INDEX IF NOT EXISTS career_gd_room_messages_room_seq_idx
  ON career_gd_room_messages (room_id, seq);

-- ------------------------------------------------------------
-- ④ career_gd_room_results — 各ユーザーの結果（1 room × 1 user = 1 行）。
--    self_feedback = 本人の詳細 FB（本人のみ表示）。ranking = 全体（参加者全員に共有）。
--    matching_hints = 本人ぶん（careerMatching / consultation 連携用）。
--    AI 参加者は結果行を作らない（人間のみ）。恒久保存＆一覧は各自の localStorage
--    careerGdResults 側（Phase1 canonical）に書き戻して /career/gd/view で見返す。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_gd_room_results (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id            uuid        NOT NULL REFERENCES career_gd_rooms(id) ON DELETE CASCADE,
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  participant_id     text        NOT NULL,
  self_feedback      jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- GdParticipantFeedback（本人）
  ranking            jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- GdRankingEntry[]（全体・共有）
  self_company_grade text        NOT NULL DEFAULT 'B',
  overall_summary    text        NOT NULL DEFAULT '',
  matching_hints     jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- GdMatchingHints（本人）
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_gd_room_results_uniq UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS career_gd_room_results_room_idx
  ON career_gd_room_results (room_id);
CREATE INDEX IF NOT EXISTS career_gd_room_results_user_idx
  ON career_gd_room_results (user_id);

-- ============================================================
-- updated_at trigger — set_updated_at()（schema.sql §3）を冪等に張る。
--   messages は updated_at を持たない（created_at のみ・追記専用）ため対象外。
-- ============================================================
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'career_gd_rooms',
    'career_gd_room_members',
    'career_gd_room_results'
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
-- RLS — 「API ゲートウェイ方式」。全テーブルで RLS を有効化するが、
--   anon / authenticated へ SELECT / INSERT / UPDATE / DELETE を許可する policy は
--   一切作らない（deny-by-default）。
--
--   → ブラウザの anon / authenticated クライアントからは本テーブルを直接読めも書けもしない。
--     DB 操作は service-role を使う API route（app/api/career/gd/room/**）だけが行う前提で、
--     認証（member ログイン）・参加権限（room member か）・host 権限（start/finish）は
--     アプリ層（API route）で検証する。service-role は RLS をバイパスするため API は動作する。
--
--   これにより RLS は「全部拒否」の 1 方針で済み、合言葉検証・membership 検証を
--   アプリ層に集約できる（合言葉は平文で DB に無く、非メンバーは room を列挙・閲覧できない）。
-- ============================================================
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'career_gd_rooms',
    'career_gd_room_members',
    'career_gd_room_messages',
    'career_gd_room_results'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- 明示的に「anon/authenticated 直接アクセスを許す policy は作らない」。
    -- service-role は RLS をバイパスするため、API route 経由の操作のみ通る。
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 【将来案・現時点では有効化しない】本人結果のみ直接 SELECT を許可する場合の policy。
--   MVP は結果取得も API route 経由に統一するため、下記はコメントのまま残す。
--   もし client から自分の結果を直接読ませたくなったら、この 1 本だけ有効化する。
-- ------------------------------------------------------------
-- DO $$
-- BEGIN
--   IF NOT EXISTS (
--     SELECT 1 FROM pg_policies
--     WHERE schemaname='public' AND tablename='career_gd_room_results'
--       AND policyname='career_gd_room_results owner select'
--   ) THEN
--     EXECUTE 'CREATE POLICY "career_gd_room_results owner select"
--              ON public.career_gd_room_results
--              FOR SELECT TO authenticated USING (auth.uid() = user_id)';
--   END IF;
-- END $$;

-- ============================================================
-- 適用前後の確認は docs/gd/gd_multi_post_apply_checklist.md を参照。
-- 本 STEP（GD-10）では本ファイルを Supabase へ適用しない（DDL / checklist の追加のみ）。
-- ============================================================

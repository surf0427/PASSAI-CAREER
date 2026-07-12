-- ============================================================
-- career_personal_memory — DDL apply (P16-A / Data Spine Layer 2)
-- 正本は schema.sql（本ファイルは Supabase SQL Editor 貼り付け用の apply ヘルパ）。
-- 前提: pgcrypto / set_updated_at()（schema.sql §3）/ auth.users が既存であること。
-- ★ 本ファイルは「追加のみ」。実環境への適用（実行）は運用判断（未適用）。
-- ============================================================

-- career_personal_memory — Data Spine Layer 2「Personal Career Memory」の owner-scoped 永続ストア。
--   processing scope = personal_service_processing（本人専用・通常サービス処理。Layer 4/5 集約とは無関係）。
--
--   位置づけ（P15-F 設計 → P16-A 実装）:
--     - Source Data（localStorage canonical + 既存 durable mirror）が **原本**。本 table は
--       Source から純関数で **決定的に再構築可能な typed projection（要約）** のみを保持する。
--     - prompt 完成文字列は保存しない。transcript / ES 本文 / company raw text / 会話全文は保存しない。
--     - Career Event Signal（career_user_events 由来）は **保存しない**（独立 subsystem）。
--     - 1 user × section = 1 row（UNIQUE(user_id, section_key)）。保存は section 別 upsert で冪等。
--     - self_prs §35 / interview_practice_records §53 / career_values §80 と同じ auth-scoped 永続層。
--
--   MVP section（P16-A）: base / self_analysis / es / interview の 4 種のみ許可（CHECK で固定）。
--     presentation / matching / consultation / company_research / gd / signals は将来 CHECK 拡張で追加する。
--
--   payload:
--     - jsonb NOT NULL（**DEFAULT を置かない**。空 object が section 別 payload schema を満たす保証が無いため、
--       TypeScript runtime validation を通過した payload だけを書き込む）。
--     - DB-level の完全 shape 検証はしない（application validation が正）。防御として object 型のみ CHECK。
--
--   status:
--     - DB に持つのは 'fresh' | 'stale' | 'failed' の 3 状態のみ。
--       missing（行不在）/ rebuilding（一過性）/ unsupported_version（read 時に schema_version 不一致で導出）は
--       DB enum 化せず read 時に導出する（無意味な enum 肥大を避ける）。
--
--   前提: pgcrypto / set_updated_at()（§3）/ auth.users が既存であること。
-- ============================================================
CREATE TABLE career_personal_memory (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  section_key       text         NOT NULL,
  schema_version    int          NOT NULL,
  source_revision   text         NOT NULL,
  source_updated_at timestamptz,
  generated_at      timestamptz  NOT NULL DEFAULT now(),
  status            text         NOT NULL DEFAULT 'fresh',
  payload           jsonb        NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT career_personal_memory_user_section_unique UNIQUE (user_id, section_key),
  -- MVP 4 section のみ許可（将来拡張時にこの CHECK を広げる）。
  CONSTRAINT career_personal_memory_section_key_check
    CHECK (section_key IN ('base', 'self_analysis', 'es', 'interview')),
  -- schema_version は正の整数。
  CONSTRAINT career_personal_memory_schema_version_check
    CHECK (schema_version > 0),
  -- DB 保存する status は 3 状態のみ。
  CONSTRAINT career_personal_memory_status_check
    CHECK (status IN ('fresh', 'stale', 'failed')),
  -- payload は object のみ（配列・スカラ・null を弾く。完全 shape は application validation）。
  CONSTRAINT career_personal_memory_payload_object_check
    CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE career_personal_memory IS
  'P16-A / Data Spine Layer 2 Personal Career Memory。processing scope=personal_service_processing。'
  'Source Data が原本で本 table は決定的に再構築可能な typed projection のみ保持。'
  'prompt 文字列 / transcript / ES 本文 / raw text / Event Signal は保存しない。'
  '1 user × section = 1 row（UNIQUE(user_id, section_key)）。MVP section=base/self_analysis/es/interview。';

COMMENT ON COLUMN career_personal_memory.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id. 退会は FK CASCADE。';
COMMENT ON COLUMN career_personal_memory.section_key IS
  'memory section 識別子。MVP は base/self_analysis/es/interview（CHECK で固定）。';
COMMENT ON COLUMN career_personal_memory.schema_version IS
  'payload 型の版。read 時に現行版と不一致なら unsupported_version として request-time fallback。';
COMMENT ON COLUMN career_personal_memory.source_revision IS
  'この payload が由来する Source Data の決定的 revision token（stale 判定の基準。security hash ではない）。';
COMMENT ON COLUMN career_personal_memory.source_updated_at IS
  '由来 Source の最新時刻（観測用・任意）。';
COMMENT ON COLUMN career_personal_memory.generated_at IS
  'この payload を生成した時刻（compare-and-set の単調性・stale overwrite 防止に使う）。';
COMMENT ON COLUMN career_personal_memory.status IS
  'DB 保存 status。fresh|stale|failed のみ。missing/rebuilding/unsupported_version は read 時に導出。';
COMMENT ON COLUMN career_personal_memory.payload IS
  'section 別 discriminated payload（jsonb・object のみ）。DEFAULT は置かない（validated payload のみ書込）。';

-- trigger: keep updated_at fresh on UPDATE（upsert の ON CONFLICT DO UPDATE 経路を含む）。
CREATE TRIGGER career_personal_memory_set_updated_at
  BEFORE UPDATE ON career_personal_memory
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- owner query 用 index（section 絞り込み read の owner-scoped 走査）。
CREATE INDEX career_personal_memory_user_section_idx
  ON career_personal_memory (user_id, section_key);

-- ============================================================
-- RLS — owner が自分の行だけ SELECT / INSERT / UPDATE / DELETE できる。
--   career_values §80 / self_prs §37 / interview_practice_records §55 と同形（4 policy）。
--   Anonymous Auth 経由でも role=authenticated として届くため policy 対象は authenticated。
--   public / anon から直接読み書きできる policy は作らない（禁止）。
--   DELETE を owner に許可する理由: reset / source deletion に伴う owner 主導のクリーンアップを可能にするため
--   （account deletion は FK CASCADE が担う）。既存 durable mirror（career_values 等）と同一規約。
-- ============================================================
ALTER TABLE career_personal_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "career_personal_memory owner select"
  ON career_personal_memory
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "career_personal_memory owner insert"
  ON career_personal_memory
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "career_personal_memory owner update"
  ON career_personal_memory
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "career_personal_memory owner delete"
  ON career_personal_memory
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

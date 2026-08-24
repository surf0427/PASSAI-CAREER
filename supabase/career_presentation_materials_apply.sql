-- ============================================================
-- PASSAI CAREER — プレゼン発表資料（file material）storage 適用 SQL
--
-- 対象 project: **CAREER（Project B）のみ**。
--   受験版（Project A）の presentation_materials_migration.sql とは別物・別 bucket。
--   両者を同じ project に混在させないこと（career-supabase-project-boundary-qa が
--   コード側の境界を守る。DB 側の境界は本ファイルの適用先で守る）。
--
-- 目的:
--   private bucket 'career-presentation-materials' を作る。
--   /career/presentation/setup で添付された発表資料（PDF / PNG / JPG）の実体を置く。
--
-- ★ CAREER のアクセス経路（受験版との違い・ここが重要）:
--   受験版は browser が user JWT で Storage を直接読み書きするため、RLS が
--   **機能の前提条件**だった。
--   CAREER は browser から Storage を一切触らない。upload / download / delete は
--   すべて server route（/api/career/presentation/material と evaluate）が
--   service-role client で行い、object path は server が
--   `${auth.uid()}/${sessionId}/material.${ext}` として生成する。
--   したがって:
--     - bucket が private であること（public=false）だけが機能上の必須条件。
--     - 下の RLS ポリシーは **多層防御**（将来 client 直アクセスを足したときの保険、
--       および anon/authenticated から他人の object へ到達できないことの明示）。
--     - RLS ポリシーを貼らなくても、policy が無い＝ anon/authenticated からは
--       アクセス不可（fail-closed）で、service-role だけが通る。
--
-- 冪等性: ON CONFLICT DO NOTHING / DROP POLICY IF EXISTS → CREATE。
--   既存データ破壊なし・DROP TABLE / DROP BUCKET なし。
--
-- 適用: Supabase Dashboard（CAREER Project B）の SQL Editor で実行する。
-- 検証:
--   SELECT id, public FROM storage.buckets WHERE id = 'career-presentation-materials';
--   -- 期待: 1 行・public = false
-- ============================================================

-- 1. private bucket（public=false）。
--    ★ ファイルサイズ / MIME の上限は route 側（lib/careerPresentation/material.ts）が正本。
--      bucket 側にも同値を置き、経路を問わず超過を弾く（多層防御）。
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'career-presentation-materials',
  'career-presentation-materials',
  false,
  10485760,                                        -- 10MB（= CAREER_PRESENTATION_MATERIAL_MAX_BYTES）
  ARRAY['application/pdf', 'image/png', 'image/jpeg']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 2. storage.objects RLS（多層防御）。
--    本人（先頭フォルダ = auth.uid()）の object にだけ SELECT / INSERT / UPDATE を許す。
--    DELETE は service_role のみ（policy を作らない＝ authenticated からは不可）。
DROP POLICY IF EXISTS "career-presentation-materials owner select" ON storage.objects;
CREATE POLICY "career-presentation-materials owner select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'career-presentation-materials'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "career-presentation-materials owner insert" ON storage.objects;
CREATE POLICY "career-presentation-materials owner insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'career-presentation-materials'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "career-presentation-materials owner update" ON storage.objects;
CREATE POLICY "career-presentation-materials owner update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'career-presentation-materials'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'career-presentation-materials'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

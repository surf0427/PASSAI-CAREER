-- ============================================================================
-- career_member_privileges — member (authenticated) の table 権限 apply
--
-- ❗ 適用状態: **未適用**。operator が Supabase SQL Editor で手動実行する
--    (Project B / CAREER 専用 = career_accounts / career_profiles などがある側)。
--    適用後、本ヘッダの「適用状態」を更新すること。
--
-- ── 何を直すのか ────────────────────────────────────────────────────────────
--
-- 症状 (2026-08-18 に Project B の information_schema.role_table_grants で実測):
--   下記 16 table について `authenticated` が保持している権限が
--     REFERENCES / TRIGGER / TRUNCATE
--   の 3 つだけで、
--     SELECT / INSERT / UPDATE / DELETE
--   が **1 件も無い**。
--
--   これらの table は「localStorage が canonical、ログイン済み member の durable
--   mirror」であり、書き込みも読み出しも **browser の anon key + user session
--   (= role `authenticated`)** で行う (lib/supabase/career*.ts /
--   lib/careerSupabase/account.ts / lib/careerEvents/record.ts)。
--   server 側の read も cookie ベースの user-scoped client
--   (lib/careerSupabase/serverClient.ts) を使うため、やはり `authenticated` で走る。
--
--   したがって DML 権限が無い現状では、member がログインしても
--     - career_accounts 行が作られない
--     - ES / 面接 / プレゼン / 自己分析 / 活動整理 / 就活軸 の mirror が保存されない
--     - login 時の backfill (lib/repository/careerBackfill.ts) が全 feature で失敗する
--   という状態になる。しかも全 mirror が never-throw / best-effort のため
--   **UI には一切エラーが出ない**（静かに保存されないだけ）。
--
-- 原因 (repo 側):
--   これらの table を作る DDL
--     supabase/career_features_apply.sql   (12 table)
--     supabase/career_accounts_apply.sql   (career_accounts)
--     supabase/career_values_apply.sql     (career_values)
--     supabase/career_events_apply.sql     (career_user_events)
--     supabase/career_personal_memory_apply.sql (career_personal_memory)
--   には GRANT 文が **1 行も無い**。RLS policy だけを作って権限付与を
--   Supabase の default privileges 任せにしていた。
--   一方、正常に動いている career_gd_* / career_generation_jobs / career_company_*
--   の DDL には明示 GRANT があり (例: career_generation_jobs_apply.sql §4)、
--   この差がそのまま「動く table / 動かない table」の差になっている。
--   同じ問題は career_gd_multi_apply.sql のヘッダにも記録されている
--   （「public テーブルへの service_role の default 権限が付いておらず 42501 に
--     なることが STEP-GD-13.5 の実機検証で判明した」）。
--
--   ★ `REFERENCES / TRIGGER / TRUNCATE` だけが残っている理由 = **UNKNOWN**。
--     repo 内に ALTER DEFAULT PRIVILEGES も REVOKE も存在しないため、Supabase
--     プロジェクト側の設定に由来すると考えられるが、本 repo からは断定できない。
--     ただし PostgreSQL の意味論として、**default privileges は既存 object に遡って
--     効かない**ため、本ファイルの明示 GRANT が後から取り消されることはない。
--     以後 career table を追加するときは、その DDL に GRANT を必ず同梱すること。
--
-- ── 方針 ────────────────────────────────────────────────────────────────────
--
--   1. **最小権限**。table ごとに、実コードが実際に使う DML だけを付与する
--      (下表の Evidence 欄参照)。`GRANT ALL` は使わない。
--   2. **anon には一切与えない**。これらは全て個人データであり、未ログインの
--      anon が触れてよい行は 1 行も無い。
--   3. **service_role にも与えない**。16 table のいずれも service_role 経由で
--      アクセスするコードが存在しない（全て browser client / user-scoped server
--      client）。将来 admin 経路を足すときに、その STEP で明示的に足す。
--   4. **TRUNCATE / TRIGGER / REFERENCES は剥がす**（NOT_REQUIRED）。理由は §0。
--   5. schema / table / column / RLS policy は **一切変更しない**。本ファイルは
--      権限 (GRANT/REVOKE) だけを扱う。
--   6. 冪等。REVOKE→GRANT の順で書いているため何度実行しても同じ最終状態になる
--      （既存 GRANT の重複付与も no-op）。
--
-- ── §0 なぜ TRUNCATE / TRIGGER / REFERENCES を剥がすのか ─────────────────────
--
--   TRUNCATE  : **RLS が適用されない**。行単位の owner 制限を完全に迂回して
--               table 全体（他 member の行を含む）を消せてしまう。member に
--               持たせてよい権限ではない。アプリは TRUNCATE を一切使わない
--               （career DDL 内でも「TRUNCATE は行わない」と明記されている）。
--   TRIGGER   : table に trigger を作成できる権限。作成された trigger は書き込み時に
--               実行されるため、任意ロジックの注入経路になり得る。アプリは
--               PostgREST 経由でしか DB に触れず DDL を発行しないため不要。
--   REFERENCES: 当該 table を参照する外部キーを張れる権限。アプリは DDL を
--               発行しないため不要。
--
--   いずれも「member の通常操作（自分の行の CRUD）」には不要であり、
--   3 つとも NOT_REQUIRED と判定した。
--
-- ── §1 付与内容と根拠 ───────────────────────────────────────────────────────
--
--   S=SELECT / I=INSERT / U=UPDATE / D=DELETE
--   ※ supabase-js の `.upsert()` は `INSERT ... ON CONFLICT DO UPDATE` を発行するため
--     **INSERT と UPDATE の両方**が要る。下表で upsert = I+U と表記する。
--
--   table                         S I U D  Evidence (実コード)
--   ----------------------------- - - - -  ------------------------------------------
--   career_accounts               S I U .  lib/careerSupabase/account.ts
--                                          select / insert / upsert
--   career_profiles               S I U .  lib/supabase/careerProfile.ts select+upsert
--   career_activities             S I U .  lib/supabase/careerActivity.ts select+upsert
--   career_values                 S I U .  lib/supabase/careerValues.ts select+upsert
--   career_self_analysis_results  S I U .  lib/supabase/careerSelfAnalysis.ts select+upsert
--   career_self_prs               S I U .  lib/supabase/careerSelfAnalysis.ts select+upsert
--                                          (login backfill 経路)
--   career_es_logs                S I U .  lib/supabase/careerEs.ts select+upsert
--   career_interview_sessions     S I U .  lib/supabase/careerInterview.ts select+upsert
--   career_interview_results      S I U .  lib/supabase/careerInterview.ts select+upsert
--   career_presentation_sessions  S I U .  lib/supabase/careerPresentation.ts select+upsert
--   career_presentation_results   S I U .  lib/supabase/careerPresentation.ts select+upsert
--   career_company_research_logs  S I U .  lib/supabase/careerCompanyResearch.ts select+upsert
--   career_matching_results       S I U .  lib/supabase/careerMatching.ts select+upsert
--                                          ★ 企業マッチング機能自体は延期中(flag OFF)だが、
--                                            careerBackfill.ts は flag を見ずに login 時へ
--                                            upsert するため、権限が無いと login backfill が
--                                            この 1 件で失敗する。よって付与する。
--   career_consultation_threads   S I U D  lib/supabase/careerConsultation.ts
--                                          select+upsert に加え delete あり
--                                          (app/career/consultation/page.tsx のスレッド削除)
--   career_user_events            S I . .  lib/careerEvents/record.ts insert /
--                                          read.ts・readSignals.ts select。
--                                          ★ append-only。career_events_apply.sql にも
--                                            update / delete policy が無いため、
--                                            UPDATE / DELETE は付与しない。
--   career_personal_memory        S I U D  lib/careerMemory/persistence/repository.ts
--                                          select / upsert / deleteSection
--                                          (deleteSection は invalidation 経路)
--
--   ★ 上記以外の DELETE は付与しない。ES / 面接 / プレゼン等の履歴には現状
--     「Supabase 側からも消す」UI が存在しない（削除は localStorage のみ）。
--     lib/careerSourceData/mirrorDelete.ts の resetCareerSourceData は実装済みだが
--     まだ UI から到達しない。**reset / 全削除 UI を実装する STEP で**、対象 table に
--     DELETE を追加すること（本ファイルに 1 行足すだけで済む）。
--
-- ── §2 RLS との関係 ─────────────────────────────────────────────────────────
--
--   GRANT は「table に触れてよいか」、RLS は「どの行に触れてよいか」。両方必要。
--   本ファイルは RLS を **一切変更しない**。既存 policy は全 16 table で
--   owner-scoped かつ `TO authenticated` であることを確認済み:
--     career_features_apply.sql の DO ブロック  … 12 table に owner select/insert/update/delete
--                                                  (auth.uid() = user_id)
--     career_accounts_apply.sql                 … auth.uid() = id  (owner 列が id である点に注意)
--     career_values_apply.sql                   … auth.uid() = user_id
--     career_events_apply.sql                   … select / insert のみ (auth.uid() = user_id)
--     career_personal_memory_apply.sql          … auth.uid() = user_id
--   よって本 GRANT 後も、member が触れるのは自分の行だけである。
--   RLS は ENABLE のままであり、policy の条件を緩めてもいない。
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- §3 権限のリセット
--
--   まず anon / authenticated から全権限を落とす。これにより
--     - 現在ぶら下がっている TRUNCATE / TRIGGER / REFERENCES が消える
--     - anon に何も残らないことが保証される
--   そのうえで §4 で必要な DML だけを authenticated へ付け直す。
--   （career_generation_jobs_apply.sql §4 / career_company_official_facts_apply.sql
--     と同じ「REVOKE ALL してから必要分だけ GRANT」パターン。）
--
--   ★ service_role は対象外。これらの table を service_role で触るコードは無く、
--     現状 service_role にも権限が無いため、あえて何もしない（付与も剥奪もしない）。
-- ----------------------------------------------------------------------------
REVOKE ALL ON public.career_accounts               FROM anon, authenticated;
REVOKE ALL ON public.career_profiles               FROM anon, authenticated;
REVOKE ALL ON public.career_activities             FROM anon, authenticated;
REVOKE ALL ON public.career_values                 FROM anon, authenticated;
REVOKE ALL ON public.career_self_analysis_results  FROM anon, authenticated;
REVOKE ALL ON public.career_self_prs               FROM anon, authenticated;
REVOKE ALL ON public.career_es_logs                FROM anon, authenticated;
REVOKE ALL ON public.career_interview_sessions     FROM anon, authenticated;
REVOKE ALL ON public.career_interview_results      FROM anon, authenticated;
REVOKE ALL ON public.career_presentation_sessions  FROM anon, authenticated;
REVOKE ALL ON public.career_presentation_results   FROM anon, authenticated;
REVOKE ALL ON public.career_company_research_logs  FROM anon, authenticated;
REVOKE ALL ON public.career_matching_results       FROM anon, authenticated;
REVOKE ALL ON public.career_consultation_threads   FROM anon, authenticated;
REVOKE ALL ON public.career_user_events            FROM anon, authenticated;
REVOKE ALL ON public.career_personal_memory        FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- §4 member (authenticated) へ必要な DML だけを付与
--
--   §1 の表がそのまま以下に対応する。RLS が行を owner に閉じる。
-- ----------------------------------------------------------------------------

-- 単一レコード系 / 履歴系: SELECT + upsert(INSERT,UPDATE)。DELETE 経路なし。
GRANT SELECT, INSERT, UPDATE ON public.career_accounts              TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_profiles              TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_activities            TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_values                TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_self_analysis_results TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_self_prs              TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_es_logs               TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_interview_sessions    TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_interview_results     TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_presentation_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_presentation_results  TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_company_research_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.career_matching_results      TO authenticated;

-- 相談スレッド: 上記に加えてユーザーがスレッドを削除できる（UI あり）。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.career_consultation_threads TO authenticated;

-- 利用イベント: append-only。UPDATE / DELETE policy が無いため付与しない。
GRANT SELECT, INSERT ON public.career_user_events TO authenticated;

-- Personal Memory: section 単位の upsert と削除（invalidation 経路）。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.career_personal_memory TO authenticated;

COMMIT;

-- ============================================================================
-- §5 適用後の検証 (このファイルとは別に、SQL Editor で実行する)
--
--   (A) authenticated の権限が意図どおりか
--
--     SELECT table_name, privilege_type
--     FROM information_schema.role_table_grants
--     WHERE table_schema = 'public'
--       AND grantee = 'authenticated'
--       AND table_name IN (
--         'career_accounts','career_profiles','career_activities','career_values',
--         'career_self_analysis_results','career_self_prs','career_es_logs',
--         'career_interview_sessions','career_interview_results',
--         'career_presentation_sessions','career_presentation_results',
--         'career_company_research_logs','career_matching_results',
--         'career_consultation_threads','career_user_events','career_personal_memory')
--     ORDER BY table_name, privilege_type;
--
--     期待: 合計 49 行（grantor が単一の通常ケース）。内訳:
--       career_user_events            … INSERT, SELECT                 =  2
--       career_consultation_threads   … DELETE, INSERT, SELECT, UPDATE =  4
--       career_personal_memory        … DELETE, INSERT, SELECT, UPDATE =  4
--       残り 13 table                 … INSERT, SELECT, UPDATE  (3 × 13) = 39
--                                                                 合計   49
--       ★ TRUNCATE / TRIGGER / REFERENCES が 1 行も出ないこと。
--
--   (B) anon に何も残っていないこと（0 行であること）
--
--     SELECT table_name, privilege_type
--     FROM information_schema.role_table_grants
--     WHERE table_schema = 'public'
--       AND grantee = 'anon'
--       AND table_name LIKE 'career\_%'
--     ORDER BY table_name, privilege_type;
--
--   (C) RLS が有効なままであること（16 行すべて rowsecurity = true）
--
--     SELECT relname, relrowsecurity
--     FROM pg_class
--     WHERE relnamespace = 'public'::regnamespace
--       AND relname LIKE 'career\_%'
--     ORDER BY relname;
-- ============================================================================

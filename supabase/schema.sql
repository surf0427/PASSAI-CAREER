-- Phase1 Supabase schema — StudentProfile mirror sink (minimal).
--
-- Design rationale & open questions:
--   docs/supabase/schema_phase1_student_profile.md
--
-- Phase1 contract this SQL upholds:
--   - localStorage remains canonical. This table is best-effort mirror only.
--   - No SELECT path exists yet. SELECT / DELETE policies are intentionally
--     omitted so the database itself blocks reads, mirroring
--     docs/supabase/phase1_runtime_strategy.md §8.
--   - No auth coupling. user_id / FK introduction is deferred to a Phase2
--     migration STEP (see schema_phase1_student_profile.md §10).
--   - This file is not applied automatically by any runtime code; it is
--     intended to be executed once via the Supabase SQL editor / CLI.

-- 1. Required extension (Supabase usually has it pre-installed; declare for
--    safety so the rest of the file runs on a fresh project).
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- 2. Table.
CREATE TABLE student_profile_mirrors (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_hash     text        NOT NULL UNIQUE,
  schema_version  text        NOT NULL,
  payload         jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE student_profile_mirrors IS
  'Phase1 best-effort mirror sink for StudentProfile. localStorage is canonical. '
  'No SELECT policy by design — see docs/supabase/schema_phase1_student_profile.md.';

COMMENT ON COLUMN student_profile_mirrors.source_hash IS
  'Deterministic identity of the canonical snapshot. Upsert conflict target.';

COMMENT ON COLUMN student_profile_mirrors.schema_version IS
  'Canonical contract version. Future migrations may filter on this.';

COMMENT ON COLUMN student_profile_mirrors.payload IS
  'Opaque jsonb snapshot. Phase1 has no query requirements; structured-column '
  'expansion is deferred to a later STEP (schema_phase1_student_profile.md §9).';


-- 3. Trigger: keep updated_at fresh on every UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER student_profile_mirrors_set_updated_at
  BEFORE UPDATE ON student_profile_mirrors
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 4. RLS — write-only access for the anon role.
--    INSERT + UPDATE are required because the mirror helper performs an
--    upsert (INSERT ... ON CONFLICT DO UPDATE). SELECT and DELETE policies
--    are intentionally not created so the database mirrors the Phase1
--    no-reads / no-destructive-rollback contract at the storage layer.
ALTER TABLE student_profile_mirrors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "student_profile_mirrors anon insert"
  ON student_profile_mirrors
  FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "student_profile_mirrors anon update"
  ON student_profile_mirrors
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);


-- 5. Mirror events sink (observability) — Phase1.
--    Append-only event log capturing the outcome of every mirror attempt.
--    Used to gate rollout-stage decisions per feature_rollout_matrix.md §11
--    and mirror_observability.md §14. See docs/supabase/observability_sink.md
--    for design rationale, retention strategy, and open questions.
--
--    Strict exclusions (enforced by absence, not by CHECK):
--      - no payload column (payloads belong in mirror tables, not events)
--      - no source_hash column (deferred; see observability_sink.md §6)
--      - no user_id / auth coupling (deferred to Phase2)
--      - no IP / user-agent / browser fingerprint columns
CREATE TABLE mirror_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  feature         text        NOT NULL,
  mirror_status   text        NOT NULL,
  failure_reason  text,
  skip_reason     text,
  duration_ms     integer,
  environment     text        NOT NULL,
  schema_version  text,
  client_version  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE mirror_events IS
  'Phase1 best-effort observability sink for mirror attempts. Append-only. '
  'No PII, no payload. The application layer (TypeScript MirrorResult unions) '
  'is the source of truth for valid enum values; this table accepts any text '
  'to keep enum evolution doc-first. See docs/supabase/observability_sink.md.';

COMMENT ON COLUMN mirror_events.feature IS
  'Short feature label (e.g. "studentProfile", "basicInfo"). Matches '
  'feature_rollout_matrix.md Feature/Domain identifiers.';

COMMENT ON COLUMN mirror_events.mirror_status IS
  'One of "success" | "failure" | "skipped" | "disabled" '
  '(mirror_observability.md §7). No DB-side CHECK by design — see §6 of the '
  'observability sink doc.';

COMMENT ON COLUMN mirror_events.failure_reason IS
  'Set when mirror_status = "failure". One of mirror_observability.md §8 '
  'reasons. NULL otherwise.';

COMMENT ON COLUMN mirror_events.skip_reason IS
  'Set when mirror_status = "skipped". One of mirror_observability.md §9 '
  'reasons. NULL otherwise.';

COMMENT ON COLUMN mirror_events.duration_ms IS
  'Mirror attempt duration in milliseconds. NULL acceptable for pre-flight '
  'skips that short-circuit before timing begins.';

COMMENT ON COLUMN mirror_events.environment IS
  'One of "development" | "preview" | "production". Operator decides how to '
  'partition rollout-stage queries by environment.';

COMMENT ON COLUMN mirror_events.schema_version IS
  'Mirror payload contract version that produced this event. Helps separate '
  'events caused by contract drift from events caused by infrastructure.';

COMMENT ON COLUMN mirror_events.client_version IS
  'App build identifier (commit hash / release tag). Lets operators '
  'correlate spikes in failure rate to deploys.';


-- 6. RLS — INSERT-only for anon. No SELECT / UPDATE / DELETE policy: the
--    application can only append, and reads happen via service-role context
--    in the Supabase SQL editor. This mirrors the no-reads / no-destructive
--    contract of student_profile_mirrors.
ALTER TABLE mirror_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mirror_events anon insert"
  ON mirror_events
  FOR INSERT
  TO anon
  WITH CHECK (true);


-- 7. Second feature mirror table — basicInfo.
--    Same shape as student_profile_mirrors (`<feature>_mirrors` convention
--    + jsonb payload + sha256 source_hash conflict key). Mirror helper:
--      lib/supabase/mirrorBasicInfo.ts
--    Design rationale: docs/supabase/basic_info_mirror_schema_preview.md
--
--    PII contract enforced by the mirror helper, not by SQL:
--      - `name` is stripped from `payload` before INSERT (the only direct-PII
--        field on canonical BasicInfo).
--      - `source_hash` is derived over the post-strip payload, so `name`
--        cannot leak via hash either.
--    The COMMENT below restates the contract so an operator reading the
--    schema sees the rule without needing to open the mirror helper.
CREATE TABLE basic_info_mirrors (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_hash     text        NOT NULL UNIQUE,
  schema_version  text        NOT NULL,
  payload         jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at      timestamptz NOT NULL DEFAULT timezone('utc', now())
);

COMMENT ON TABLE basic_info_mirrors IS
  'Phase1 best-effort mirror sink for basicInfo. localStorage is canonical. '
  'No SELECT policy by design. PII rule: payload MUST NOT contain raw `name` '
  '— the mirror helper (lib/supabase/mirrorBasicInfo.ts) strips it before '
  'INSERT. See docs/supabase/basic_info_mirror_schema_preview.md.';

COMMENT ON COLUMN basic_info_mirrors.source_hash IS
  'sha256(JSON.stringify(payloadWithoutName) + schema_version). Computed by '
  'the mirror helper at write time; NOT present on the canonical BasicInfo '
  'type. Upsert conflict target.';

COMMENT ON COLUMN basic_info_mirrors.schema_version IS
  'basicInfo canonical shape version. Pinned to "1" at first apply. Bump '
  'when normalizeBasicInfo / pruneSubjectGrades change post-prune shape.';

COMMENT ON COLUMN basic_info_mirrors.payload IS
  'Opaque jsonb snapshot of post-prune BasicInfo MINUS `name`. MUST NOT '
  'contain raw user-supplied name. Phase1 has no query requirements; '
  'structured-column expansion is deferred to a later STEP.';


-- 8. Trigger: keep updated_at fresh on every UPDATE. Reuses the existing
--    set_updated_at() function defined for student_profile_mirrors (§3) so
--    the two mirror tables share UPDATE-side semantics.
CREATE TRIGGER basic_info_mirrors_set_updated_at
  BEFORE UPDATE ON basic_info_mirrors
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 9. RLS — write-only access for the anon role.
--    INSERT + UPDATE are required because the mirror helper performs an
--    upsert (INSERT ... ON CONFLICT DO UPDATE). SELECT and DELETE policies
--    are intentionally not created so the database mirrors the Phase1
--    no-reads / no-destructive-rollback contract at the storage layer.
ALTER TABLE basic_info_mirrors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "basic_info_mirrors anon insert"
  ON basic_info_mirrors
  FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "basic_info_mirrors anon update"
  ON basic_info_mirrors
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);


-- 10. Third feature mirror table — diagnosis (受験タイプ診断).
--     Same shape as student_profile_mirrors / basic_info_mirrors
--     (`<feature>_mirrors` convention + jsonb payload + sha256 source_hash
--     conflict key). Mirror helper:
--       lib/supabase/mirrorDiagnosis.ts
--     Design rationale: docs/supabase/diagnosis_mirror_schema_preview.md
--
--     This is the **no-PII mirror precedent** in Phase1:
--       - `answers` are numeric indices into QUESTIONS option arrays — no
--         user free text.
--       - `resultType` is a fixed enum (1|2|3|4) deterministically computed
--         by calcResultType(answers).
--       - `resultTitle` / `resultDescription` are app-authored static
--         strings from the in-page RESULT_TYPES dictionary — not user data.
--       - No payload strip layer (unlike basic_info_mirrors which removes
--         `name`).
--
--     `source_hash` excludes `createdAt` / `resultTitle` / `resultDescription`
--     so identical retakes dedup and app-side copy edits do not force
--     schema_version bumps. See docs/supabase/diagnosis_mirror_schema_preview.md
--     §7-§8.
CREATE TABLE diagnosis_mirrors (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_hash     text        NOT NULL UNIQUE,
  schema_version  text        NOT NULL,
  payload         jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at      timestamptz NOT NULL DEFAULT timezone('utc', now())
);

COMMENT ON TABLE diagnosis_mirrors IS
  'Phase1 best-effort mirror sink for diagnosis (受験タイプ診断). '
  'localStorage is canonical. No SELECT policy by design. Payload carries '
  'NO user free text — answers are numeric indices, resultType is a fixed '
  'enum, resultTitle / resultDescription are app-authored static strings. '
  'No PII strip layer is required at the mirror helper. See '
  'docs/supabase/diagnosis_mirror_schema_preview.md.';

COMMENT ON COLUMN diagnosis_mirrors.source_hash IS
  'sha256(JSON.stringify({ answers, resultType }) + schema_version). '
  'Computed by lib/supabase/mirrorDiagnosis.ts at write time; NOT present '
  'on the canonical DiagnosisResult type. Upsert conflict target. '
  'createdAt / resultTitle / resultDescription are intentionally excluded '
  'from the hash so identical retakes dedup and app-supplied copy edits '
  'do not force schema_version bumps.';

COMMENT ON COLUMN diagnosis_mirrors.schema_version IS
  'diagnosis canonical shape version. Pinned to "1" at first apply. Bump '
  'triggers: QUESTIONS array changes (length / option order), '
  'DiagnosisType enum extends, or calcResultType logic changes. Title / '
  'description copy edits do NOT trigger a bump.';

COMMENT ON COLUMN diagnosis_mirrors.payload IS
  'Opaque jsonb snapshot of DiagnosisResult { resultType, resultTitle, '
  'resultDescription, answers, createdAt }. Stored verbatim — no strip, '
  'no normalize. App-authored title / description are durable historical '
  'snapshots and may differ from the current in-code RESULT_TYPES.';


-- 11. Trigger: keep updated_at fresh on every UPDATE. Reuses the existing
--     set_updated_at() function defined for student_profile_mirrors (§3)
--     and shared with basic_info_mirrors (§8) so all three mirror tables
--     share UPDATE-side semantics.
CREATE TRIGGER diagnosis_mirrors_set_updated_at
  BEFORE UPDATE ON diagnosis_mirrors
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 12. RLS — write-only access for the anon role.
--     INSERT + UPDATE required for upsert (INSERT ... ON CONFLICT DO UPDATE).
--     SELECT / DELETE policies intentionally absent, matching the other
--     two mirror tables.
ALTER TABLE diagnosis_mirrors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "diagnosis_mirrors anon insert"
  ON diagnosis_mirrors
  FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "diagnosis_mirrors anon update"
  ON diagnosis_mirrors
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);


-- 13. Fourth feature mirror table — activityData (活動整理).
--     Same shape as student_profile_mirrors / basic_info_mirrors /
--     diagnosis_mirrors (`<feature>_mirrors` convention + jsonb payload +
--     sha256 source_hash conflict key). Mirror helper:
--       lib/supabase/mirrorActivityData.ts
--     Design rationale: docs/supabase/activity_mirror_schema_preview.md
--
--     This is the **narrative-soft PII** mirror precedent:
--       - No direct-name PII field on `ActivityData` (no `name`-equivalent),
--         so `stripName`-style boundary enforcement does NOT apply here.
--       - Narrative free-text fields (`clubName`, `theme`, `description`,
--         `achievement`, `role`, `challenge`, `action`, `reflection`,
--         `futureConnection`, and their per-activity-type analogues) carry
--         contextual identity. Cannot be stripped without destroying the
--         artifact — the narrative IS the mirror's content.
--       - Phase1 anonymous posture rests on: (a) anon SELECT absent →
--         operator service-role only, (b) no `user_id` column → cross-row
--         linkage impossible, (c) anon UPDATE allowed for upsert idempotency.
--
--     Trigger contract — **submit-driven only**:
--       Mirror dispatch lives in `hooks/useActivityForm.ts:handleSubmit`,
--       NOT in `lib/activityStorage.ts:saveActivityData` (the autosave
--       path). Per-keystroke autosave generates 1000-5000 writes per
--       editing session; submit-driven keeps it to ~1 per session.
--       See STEP-PHASE1M decision and post-apply checklist §3.3 for the
--       typing-only verification used to detect a regression.
--
--     `source_hash` covers the FULL payload — unlike basic_info_mirrors
--     (which strips `name` first) and diagnosis_mirrors (which hashes
--     `{ answers, resultType }` only). Every narrative field is part of
--     content identity. See activity_mirror_schema_preview.md §7.
CREATE TABLE activity_mirrors (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_hash     text        NOT NULL UNIQUE,
  schema_version  text        NOT NULL,
  payload         jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at      timestamptz NOT NULL DEFAULT timezone('utc', now())
);

COMMENT ON TABLE activity_mirrors IS
  'Phase1 best-effort mirror sink for activityData (活動整理). localStorage '
  'is canonical. No SELECT policy by design. Payload carries no direct-name '
  'PII field but DOES carry user-authored narrative free text (clubName / '
  'activityContent / theme / description / achievement / role / challenge / '
  'action / reflection / futureConnection, etc.). Operator sign-off on the '
  'Phase1 anonymous-RLS exposure of these narratives is the gate that lets '
  'this table exist. See docs/supabase/activity_mirror_schema_preview.md §6.';

COMMENT ON COLUMN activity_mirrors.source_hash IS
  'sha256(JSON.stringify(payload) + schema_version). Computed by '
  'lib/supabase/mirrorActivityData.ts at write time over the FULL payload — '
  'unlike basic_info_mirrors (which strips `name` first) and diagnosis_mirrors '
  '(which hashes a subset). Every narrative field is part of content '
  'identity. Upsert conflict target.';

COMMENT ON COLUMN activity_mirrors.schema_version IS
  'activityData canonical shape version. Pinned to "1" at first apply. '
  'Bump triggers: adding/removing/renaming any of the 9 top-level arrays, '
  'any BaseActivity field, any feature-specific Activity type field, or '
  'the `type` discriminator. Validator changes (lib/activityValidator.ts) '
  'do NOT trigger a bump.';

COMMENT ON COLUMN activity_mirrors.payload IS
  'Opaque jsonb snapshot of the post-validate ActivityData (9 top-level '
  'arrays, each with feature-specific shape). Stored verbatim — no strip, '
  'no normalize, no sort. Shape MUST match what lib/aiInputHash.ts consumes '
  'to keep AI cache hashes stable across canonical and mirror.';


-- 14. Trigger: reuses the shared set_updated_at() function defined in §3
--     and used by §8 / §11 so all four mirror tables share UPDATE-side
--     semantics.
CREATE TRIGGER activity_mirrors_set_updated_at
  BEFORE UPDATE ON activity_mirrors
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 15. RLS — write-only access for the anon role.
--     INSERT + UPDATE required for upsert (INSERT ... ON CONFLICT DO UPDATE).
--     SELECT / DELETE policies intentionally absent, matching the other
--     three mirror tables.
ALTER TABLE activity_mirrors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activity_mirrors anon insert"
  ON activity_mirrors
  FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "activity_mirrors anon update"
  ON activity_mirrors
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);


-- 16. profiles — auth user 行（STEP-AUTH-02）。
--
--     Phase1 mirror layer とは別系統の "auth canonical" テーブル。
--     mirror_* と違い READ する。所有者契約:
--       - id は auth.users(id) を参照する。所有者判定 / RLS / 保存キーの正本。
--       - display_user_id は表示用のみ。所有者判定・FK には絶対に使わない。
--       - plan は Phase1 では 'free' 固定。Stripe 連携は別 STEP。
--
--     PII 観点:
--       - id (uuid) は auth.users 由来で外部露出しても安全。
--       - display_user_id はユーザー自身が選ぶ識別子。
--       - plan は free/paid 等の課金状態。
--       - 上記いずれも個人特定 PII を含まない（活動 narrative や本名なし）。
--     したがって duplicate check 用に display_user_id を authenticated に
--     read 許可することを許容する（後段 RLS 参照）。
CREATE TABLE profiles (
  id               uuid         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_user_id  text         UNIQUE,
  plan             text         NOT NULL DEFAULT 'free',
  is_qa_user       boolean      NOT NULL DEFAULT false,
  created_at       timestamptz  NOT NULL DEFAULT timezone('utc', now()),
  updated_at       timestamptz  NOT NULL DEFAULT timezone('utc', now())
);

COMMENT ON TABLE profiles IS
  'STEP-AUTH-02 auth canonical profile. id = auth.users.id (= auth.uid()) is '
  'the only legitimate owner key. display_user_id is display-only and MUST NOT '
  'be used for ownership / FK / billing identity. plan is free in Phase1; '
  'Stripe wiring is a later STEP.';

COMMENT ON COLUMN profiles.id IS
  'auth.users(id). Owner identity (RLS / Stripe / permissions all use this).';

COMMENT ON COLUMN profiles.display_user_id IS
  'User-chosen display ID. Optional (nullable). UNIQUE for collision-free '
  'lookup but never used as ownership key.';

COMMENT ON COLUMN profiles.plan IS
  'Billing plan label. Phase1 default = "free". Driven by Stripe webhook in '
  'STEP-BILLING-02 以降 (service_role 経由)。client からの直接書き換えは '
  '§24 trigger (enforce_profile_plan_protection) で禁止済み。';

COMMENT ON COLUMN profiles.is_qa_user IS
  'QA bypass flag. true のユーザーは課金プラン / 月次回数制限を全 feature で '
  'bypass する (lib/billing/planGate.ts ensurePlanQuota)。権限昇格フラグなので '
  'client (anon/authenticated) からの書き換えは §24 trigger '
  '(enforce_profile_plan_protection) で禁止。設定は service_role / SQL 経由のみ。';


-- 17. Trigger: keep updated_at fresh on every UPDATE
--     (reuses set_updated_at() defined in §3).
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 18. RLS — profiles
--     Anonymous auth で発行された JWT は role=authenticated として届く
--     （`is_anonymous=true` claim 付き）。よって policy 対象は authenticated。
--
--     SELECT  : authenticated 全体に許可。
--               profiles の列はいずれも非 PII（id=uuid, display_user_id=
--               ユーザー選択 ID, plan=課金種別, timestamps）であり、
--               display_user_id の重複チェックに必要。
--     INSERT  : auth.uid() = id のみ。自分以外の行を作らせない。
--     UPDATE  : auth.uid() = id のみ。他人の行を書き換えさせない。
--               plan 列の client 書き換え禁止は §24 の trigger
--               (enforce_profile_plan_protection) で強制する。RLS policy
--               自体は列制限を持たない（trigger が SoT）。
--     DELETE  : 未許可。退会フローは別 STEP で設計する。
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles authenticated select"
  ON profiles
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "profiles owner insert"
  ON profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles owner update"
  ON profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);


-- ──────────────────────────────────────────────────────────────────────
-- STEP-CHAT-PERSISTENCE-01: Tutor Chat 永続化（auth-scoped）
--
-- profiles と同じく Phase2 Auth 系の auth-scoped table。N=4 mirror freeze
-- とは別レイヤー（mirror_* ではなく user_id を持つ canonical-ish 永続層）。
-- localStorage canonical の "同期先 / mirror 的扱い" として導入する。
-- Tutor 既存の localStorage 保存挙動は壊さず、Supabase 側は best-effort で
-- 後追い同期する。RLS は常に auth.uid() = user_id で閉じる。
--
--   §19  tutor_chat_threads  table
--   §20  tutor_chat_threads  trigger (set_updated_at)
--   §21  tutor_chat_threads  RLS
--   §22  tutor_chat_messages table
--   §23  tutor_chat_messages RLS
--
-- 所有者契約:
--   user_id は auth.users(id) を参照する owner key。
--   display_user_id は本 table 群で扱わない（表示用の別 namespace）。
-- ──────────────────────────────────────────────────────────────────────


-- 19. tutor_chat_threads
CREATE TABLE tutor_chat_threads (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title             text         NOT NULL DEFAULT '新しい相談',
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  last_message_at   timestamptz,
  local_thread_id   text,
  metadata          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT tutor_chat_threads_local_unique UNIQUE (user_id, local_thread_id)
);

COMMENT ON TABLE tutor_chat_threads IS
  'STEP-CHAT-PERSISTENCE-01 Tutor chat thread (auth-scoped). user_id is the '
  'sole owner key (auth.users.id). local_thread_id maps back to the '
  'localStorage thread.id so the mirror is idempotent under retries.';

COMMENT ON COLUMN tutor_chat_threads.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id.';

COMMENT ON COLUMN tutor_chat_threads.local_thread_id IS
  'localStorage の TutorChatThread.id をそのまま入れる。upsert の natural key '
  '(user_id, local_thread_id) として使う。NULL は許容（古い row との互換）。';


-- 20. trigger: keep updated_at fresh (re-uses set_updated_at() from §3)
CREATE TRIGGER tutor_chat_threads_set_updated_at
  BEFORE UPDATE ON tutor_chat_threads
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 21. RLS — tutor_chat_threads
--     Anonymous Auth 経由でも role=authenticated として届くので policy 対象は
--     authenticated。すべての行操作は auth.uid() = user_id で閉じる。
ALTER TABLE tutor_chat_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tutor_chat_threads owner select"
  ON tutor_chat_threads
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "tutor_chat_threads owner insert"
  ON tutor_chat_threads
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "tutor_chat_threads owner update"
  ON tutor_chat_threads
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "tutor_chat_threads owner delete"
  ON tutor_chat_threads
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- 22. tutor_chat_messages
CREATE TABLE tutor_chat_messages (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id         uuid         NOT NULL REFERENCES public.tutor_chat_threads(id) ON DELETE CASCADE,
  user_id           uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role              text         NOT NULL,
  content           text         NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  local_message_id  text,
  metadata          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT tutor_chat_messages_role_check
    CHECK (role IN ('user', 'assistant', 'system')),
  CONSTRAINT tutor_chat_messages_local_unique
    UNIQUE (thread_id, local_message_id)
);

COMMENT ON TABLE tutor_chat_messages IS
  'STEP-CHAT-PERSISTENCE-01 Tutor chat message (auth-scoped). thread_id FKs '
  'tutor_chat_threads. user_id duplicates the owner key for direct RLS '
  'enforcement (no need to JOIN threads). local_message_id maps back to the '
  'localStorage TutorMessage.id for idempotent upsert.';

COMMENT ON COLUMN tutor_chat_messages.user_id IS
  'auth.users(id). Duplicated from thread for direct RLS without JOIN.';

COMMENT ON COLUMN tutor_chat_messages.role IS
  'CHECK constraint enforces user / assistant / system.';

COMMENT ON COLUMN tutor_chat_messages.local_message_id IS
  'localStorage の TutorMessage.id。NULL 許容。NULL 同士は SQL 標準で distinct '
  '扱いなので、(thread_id, NULL) の複数行は許容される（古い row との互換）。';


-- 23. RLS — tutor_chat_messages
ALTER TABLE tutor_chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tutor_chat_messages owner select"
  ON tutor_chat_messages
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "tutor_chat_messages owner insert"
  ON tutor_chat_messages
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "tutor_chat_messages owner update"
  ON tutor_chat_messages
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "tutor_chat_messages owner delete"
  ON tutor_chat_messages
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- ──────────────────────────────────────────────────────────────────────
-- STEP-BILLING-01: 課金導線 DB 基盤
--
-- 目的:
--   1. profiles.plan の課金回避リスクを解消する。
--      既存 "profiles owner update" policy (§18) は列単位制限がなく、
--      認証済み client が `update({ plan: 'premium' })` を直接呼べる状態
--      だった。これを trigger で塞ぐ。
--   2. Stripe サブスク状態の Single Source of Truth として
--      subscriptions テーブルを導入する。書き込みは service_role
--      (webhook) のみ。
--   3. webhook 冪等化のため stripe_events を導入する。
--   4. AI 利用量・原価分析の土台として usage_records を導入する（軽量版）。
--
-- 本 STEP は DB 基盤のみ。Stripe SDK / Checkout / Webhook 実装 / UI 変更は
-- 別 STEP (STEP-BILLING-02 以降)。
--
--   §24  profiles.plan 書き込み保護 (function + trigger)
--   §25  subscriptions table
--   §26  subscriptions trigger (set_updated_at)
--   §27  subscriptions RLS
--   §28  stripe_events table
--   §29  stripe_events RLS
--   §30  usage_records table
--   §31  usage_records RLS
--
-- 所有者契約:
--   - subscriptions.user_id / usage_records.user_id は auth.users(id)。
--   - stripe_events は user 紐付けを持たない（イベント単位の冪等化のみ）。
-- ──────────────────────────────────────────────────────────────────────


-- 24. profiles.plan 書き込み保護
--
--     §18 の "profiles owner update" は列単位制限がないため、認証済み
--     client が `update({ plan: 'premium' })` を直接送れる状態だった。
--     ここで以下を強制する:
--       - INSERT 時: anon/authenticated は plan を常に 'free' に矯正する。
--                    （client が plan='premium' を渡してきても無視する）
--       - UPDATE 時: anon/authenticated が plan を変更しようとしたら例外。
--       - service_role / postgres / supabase_admin はスルー。Stripe webhook
--         は service_role 経由で plan を書き換える前提。
--
--     trigger を採用する理由: 列単位 GRANT (`REVOKE UPDATE (plan)`) では
--     既存 lib/supabase/profile.ts:ensureProfile が `insert({ plan: 'free' })`
--     を明示送信しているため、INSERT 経路も列禁止にすると ensureProfile が
--     permission denied で落ちる。trigger なら "client は plan='free' しか
--     書けない" を表現できる。
CREATE OR REPLACE FUNCTION enforce_profile_plan_protection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      -- client が何を渡してきても plan は 'free' / is_qa_user は false に矯正する。
      NEW.plan := 'free';
      NEW.is_qa_user := false;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.plan IS DISTINCT FROM OLD.plan THEN
        RAISE EXCEPTION
          'profiles.plan can only be modified by service_role (attempted by %)',
          current_user
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NEW.is_qa_user IS DISTINCT FROM OLD.is_qa_user THEN
        RAISE EXCEPTION
          'profiles.is_qa_user can only be modified by service_role (attempted by %)',
          current_user
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_profile_plan_protection IS
  'STEP-BILLING-01. profiles.plan / is_qa_user を anon/authenticated から '
  '書き換え不能にする。INSERT は plan=free / is_qa_user=false に矯正し、'
  'UPDATE は両列の変更を拒否する。 '
  'service_role / postgres / supabase_admin はスルー。 '
  'plan は Stripe webhook、is_qa_user は運用 SQL が service_role 経由で書き換える前提。';

CREATE TRIGGER profiles_enforce_plan_protection
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION enforce_profile_plan_protection();


-- 25. subscriptions — Stripe サブスク状態の Single Source of Truth
--
--     設計方針:
--       - 1 user は時系列で複数 subscription を持ち得る（plan 変更 / 解約
--         → 再契約）。user_id は UNIQUE にしない。
--       - stripe_subscription_id を UNIQUE にして webhook 冪等化と
--         upsert conflict target に使う。
--       - "現在有効な plan" の判定は別 STEP のサーバヘルパで行う:
--           status='active' OR
--           (status='canceled' AND now() < current_period_end)
--       - profiles.plan は本テーブル由来の denormalized cache（webhook
--         で同時に更新する想定）。RLS 判定の高速パス用。
--
--     RLS:
--       - 書き込み: policy なし → anon/authenticated 全 deny。
--         service_role が BYPASSRLS で書く（webhook 経由）。
--       - 読み取り: 自分の行のみ SELECT 可（UI で現プラン表示用）。
CREATE TABLE subscriptions (
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
  CONSTRAINT subscriptions_plan_check
    CHECK (plan IN ('basic', 'premium')),
  CONSTRAINT subscriptions_status_check
    CHECK (status IN ('trialing', 'active', 'past_due', 'canceled',
                      'incomplete', 'incomplete_expired', 'unpaid', 'paused'))
);

COMMENT ON TABLE subscriptions IS
  'STEP-BILLING-01. Stripe サブスク状態の Single Source of Truth。 '
  '書き込みは service_role (webhook) のみ。SELECT は自分の行のみ。 '
  'profiles.plan は本テーブル由来の denormalized cache。 '
  '1 user が複数の subscription 行を持ち得る（plan 変更や再契約時）。';

COMMENT ON COLUMN subscriptions.user_id IS
  'auth.users(id). Owner key. RLS は auth.uid() = user_id で閉じる。';

COMMENT ON COLUMN subscriptions.stripe_customer_id IS
  'Stripe Customer ID (cus_...). user に対し 1:1 で再利用される。 '
  'Billing Portal セッション発行に必要。';

COMMENT ON COLUMN subscriptions.stripe_subscription_id IS
  'Stripe Subscription ID (sub_...). UNIQUE。webhook 冪等化と plan 切替時の '
  '同一行更新に使う upsert conflict target。';

COMMENT ON COLUMN subscriptions.plan IS
  'basic | premium。Stripe Price ID から webhook 側で導出して書く。 '
  '無料プランは存在しない（free は profiles.plan のデフォルト値で表現）。';

COMMENT ON COLUMN subscriptions.status IS
  'Stripe Subscription.status を sync。CHECK 制約で代表値を列挙。 '
  'Stripe が将来 status を追加した場合は CHECK 緩和を別 migration で。';

COMMENT ON COLUMN subscriptions.cancel_at_period_end IS
  '解約予約フラグ。true なら current_period_end まで権利維持、その後 canceled。';

CREATE INDEX subscriptions_user_id_idx ON subscriptions(user_id);
CREATE INDEX subscriptions_customer_idx ON subscriptions(stripe_customer_id);


-- 26. subscriptions trigger — keep updated_at fresh on every UPDATE
--     (set_updated_at() は §3 で定義済み、複数テーブルで共有)。
CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 27. subscriptions RLS
--     INSERT / UPDATE / DELETE policy なし → anon/authenticated 書き込み禁止。
--     service_role は BYPASSRLS。
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscriptions owner select"
  ON subscriptions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);


-- 28. stripe_events — webhook 冪等化ストア
--
--     Stripe は同じ event を retry で複数回送る前提。event_id を PK にし、
--     INSERT ... ON CONFLICT DO NOTHING で再送を安全に弾く。
--     payload は raw のまま保存（デバッグ・再処理用）。
--
--     RLS:
--       - policy 一切なし → anon/authenticated は SELECT/INSERT 含め全 deny。
--       - service_role のみが扱う（webhook handler）。
CREATE TABLE stripe_events (
  event_id      text         PRIMARY KEY,
  type          text         NOT NULL,
  payload       jsonb        NOT NULL,
  received_at   timestamptz  NOT NULL DEFAULT timezone('utc', now()),
  processed_at  timestamptz,
  error         text
);

COMMENT ON TABLE stripe_events IS
  'STEP-BILLING-01. Stripe webhook event の冪等化ストア。event_id PK で '
  'INSERT ... ON CONFLICT DO NOTHING により再送イベントを安全に弾く。 '
  '書き込み・読み取りともに service_role のみ。';

COMMENT ON COLUMN stripe_events.event_id IS
  'Stripe Event ID (evt_...). UNIQUE conflict target。';

COMMENT ON COLUMN stripe_events.type IS
  'Stripe event type (例: customer.subscription.created, '
  'checkout.session.completed)。';

COMMENT ON COLUMN stripe_events.payload IS
  'Stripe event body をそのまま保存。デバッグ・再処理用。 '
  'PII を含み得る（メール等）ので運用上の取扱注意。';

COMMENT ON COLUMN stripe_events.processed_at IS
  'NULL=受信したが未処理。値あり=処理成功。エラー時は error 列に詳細。';

CREATE INDEX stripe_events_type_idx ON stripe_events(type);
CREATE INDEX stripe_events_received_idx ON stripe_events(received_at DESC);


-- 29. stripe_events RLS
--     policy を一切作らない → anon/authenticated は SELECT 含め全アクセス不可。
--     service_role は BYPASSRLS でアクセス。
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;


-- 30. usage_records — AI 利用量・原価分析の土台（軽量版）
--
--     最低限のカラムのみ:
--       user_id / route / model / status / occurred_at
--     トークン数・原価カラムは将来 ALTER TABLE で後方互換に追加。
--     route は app/api/<name>/route.ts の <name> 識別子を入れる想定
--     （statement-review, tutor, essay-chat など）。
--
--     RLS:
--       - 書き込み: policy なし → service_role (API route 内) のみが書く。
--       - 読み取り: 自分の行のみ SELECT 可（マイページで「残り回数」を
--         表示するため）。
CREATE TABLE usage_records (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  route        text         NOT NULL,
  model        text         NOT NULL,
  status       text         NOT NULL,
  occurred_at  timestamptz  NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT usage_records_status_check
    CHECK (status IN ('ok', 'error', 'rate_limited'))
);

COMMENT ON TABLE usage_records IS
  'STEP-BILLING-01. AI API 利用記録の最小版。route 別・user 別の利用回数 '
  '集計と plan 別上限判定の基盤。トークン数 / 原価カラムは将来 ALTER TABLE '
  'で後方互換に追加。書き込みは service_role のみ。SELECT は自分の行のみ。';

COMMENT ON COLUMN usage_records.user_id IS
  'auth.users(id). Owner key.';

COMMENT ON COLUMN usage_records.route IS
  'AI を呼び出した API route の識別子。例: "statement-review", "tutor"。 '
  'app/api/<name>/route.ts の <name> 部分を使う。';

COMMENT ON COLUMN usage_records.model IS
  'Anthropic model ID。例: "claude-sonnet-4-6", "claude-opus-4-1"。';

COMMENT ON COLUMN usage_records.status IS
  'ok / error / rate_limited。CHECK 制約で固定。';

COMMENT ON COLUMN usage_records.occurred_at IS
  'AI call 実行時刻。INSERT 時のデフォルトで now() を入れる。 '
  '日次集計はこの列で行う。';

CREATE INDEX usage_records_user_occurred_idx
  ON usage_records(user_id, occurred_at DESC);
CREATE INDEX usage_records_route_occurred_idx
  ON usage_records(route, occurred_at DESC);


-- 31. usage_records RLS
--     INSERT / UPDATE / DELETE policy なし → service_role のみが書く。
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_records owner select"
  ON usage_records
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);


-- ──────────────────────────────────────────────────────────────────────
-- STEP-SUPABASE-COMPLETE-04: self_analysis_logs（自己分析ログの Supabase mirror）
--
-- 位置づけ:
--   tutor_chat_threads / tutor_chat_messages（§19〜§23）と同じ auth-scoped
--   mirror 系統。localStorage の selfAnalysisLogs（key='selfAnalysisLogs',
--   lib/selfAnalysisLogStorage.ts）を canonical とし、本 table はその "同期先 /
--   mirror 的扱い" として best-effort で後追い同期する。
--
--   N=4 mirror（mirror_events / 共有 source_hash, §5）系統とは別レイヤー。
--   こちらは user_id を持つ auth-scoped 永続層で、RLS は常に auth.uid()=user_id
--   で閉じる。read 経路は本 STEP では切り替えず、引き続き localStorage canonical
--   のまま（後続 STEP で hydrate / read-through を判断）。
--
--   §32  self_analysis_logs  table
--   §33  self_analysis_logs  trigger (set_updated_at)
--   §34  self_analysis_logs  RLS
--
-- 所有者契約:
--   user_id は auth.users(id) を参照する owner key。
--   display_user_id は本 table で扱わない（表示用の別 namespace）。
-- ──────────────────────────────────────────────────────────────────────


-- 32. self_analysis_logs
CREATE TABLE self_analysis_logs (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_log_id         text,
  summary_input_hash   text         NOT NULL,
  analysis             jsonb        NOT NULL,
  displayed_questions  jsonb        NOT NULL DEFAULT '[]'::jsonb,
  answers              jsonb        NOT NULL DEFAULT '[]'::jsonb,
  deep_answers         jsonb        NOT NULL DEFAULT '[]'::jsonb,
  free_memo            text         NOT NULL DEFAULT '',
  summary              jsonb        NOT NULL,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  metadata             jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT self_analysis_logs_dedup_unique UNIQUE (user_id, summary_input_hash)
);

COMMENT ON TABLE self_analysis_logs IS
  'STEP-SUPABASE-COMPLETE-04. localStorage selfAnalysisLogs (完了済み自己分析ログ) '
  'の auth-scoped Supabase mirror。localStorage canonical は維持し、本 table は '
  '同期先（best-effort）。user_id is the sole owner key (auth.users.id). '
  'mirror_events 系統ではなく、tutor_chat_* と同じ auth-scoped 永続層。';

COMMENT ON COLUMN self_analysis_logs.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id.';

COMMENT ON COLUMN self_analysis_logs.local_log_id IS
  'localStorage の SelfAnalysisLog.id（crypto.randomUUID 由来）をそのまま入れる。'
  '将来の UI selectedLogId 復元のための traceability 用。NULL 許容。';

COMMENT ON COLUMN self_analysis_logs.summary_input_hash IS
  'localStorage 側の dedup natural key（lib/selfAnalysisLogStorage.ts: '
  'persistSelfAnalysisLog が summaryInputHash 一致で in-place 上書きする）。'
  'legacy 救済の固定値 "legacy:v1" も入りうる。';

COMMENT ON CONSTRAINT self_analysis_logs_dedup_unique ON self_analysis_logs IS
  'UNIQUE(user_id, summary_input_hash)。localStorage の "同一 summaryInputHash は '
  '同一 entry を in-place update" という挙動を、onConflict 指定の upsert で再現する '
  'ための natural key。';


-- 33. trigger: keep updated_at fresh (re-uses set_updated_at() from §3)
CREATE TRIGGER self_analysis_logs_set_updated_at
  BEFORE UPDATE ON self_analysis_logs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 34. RLS — self_analysis_logs
--     Anonymous Auth 経由でも role=authenticated として届くので policy 対象は
--     authenticated。すべての行操作は auth.uid() = user_id で閉じる
--     （tutor_chat_threads §21 と同形）。
ALTER TABLE self_analysis_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "self_analysis_logs owner select"
  ON self_analysis_logs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "self_analysis_logs owner insert"
  ON self_analysis_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "self_analysis_logs owner update"
  ON self_analysis_logs
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "self_analysis_logs owner delete"
  ON self_analysis_logs
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- 35. self_prs
--     STEP-SUPABASE-COMPLETE-05A. localStorage key='selfPRs'（自己PR カード群）の
--     auth-scoped Supabase mirror。localStorage canonical は維持し、本 table は
--     同期先（best-effort durable mirror）。self_analysis_logs §32 / tutor_chat_*
--     と同じ auth-scoped 永続層であり、mirror_events 系統ではない。
--
--     natural key は (user_id, local_pr_id)。local_pr_id = SelfPR.id（UUID 文字列）
--     をそのまま使い、content hash では dedup しない（後述 docs 参照）。
--
--     delete を伴う feature である点に注意。本 STEP では down-sync / restore は
--     実装しない（delete resurrection リスクのため、tombstone 設計後の別 STEP）。
CREATE TABLE self_prs (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_pr_id      text         NOT NULL,
  pr_index         integer      NOT NULL DEFAULT 0,
  title            text         NOT NULL DEFAULT '',
  body             text         NOT NULL DEFAULT '',
  latest_result    text         NOT NULL DEFAULT '',
  seed_input_hash  text,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  metadata         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT self_prs_local_unique UNIQUE (user_id, local_pr_id)
);

COMMENT ON TABLE self_prs IS
  'STEP-SUPABASE-COMPLETE-05A. localStorage selfPRs（自己PR カード群）の auth-scoped '
  'Supabase durable mirror。localStorage canonical は維持し、本 table は同期先。'
  'natural key = (user_id, local_pr_id)。local_pr_id = SelfPR.id, body = SelfPR.text, '
  'pr_index = SelfPR.index。seed_input_hash は dedup key ではなく補助情報のみ。'
  'delete を伴う feature であり、restore は tombstone 設計後の別 STEP に分離する。';

COMMENT ON COLUMN self_prs.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id.';

COMMENT ON COLUMN self_prs.local_pr_id IS
  'localStorage の SelfPR.id（UUID 文字列）をそのまま入れる。natural key の一部で、'
  'upsert の onConflict 対象。content hash ではなく id を identity とする。';

COMMENT ON COLUMN self_prs.pr_index IS
  'SelfPR.index（カードの並び順）。表示順 traceability 用。';

COMMENT ON COLUMN self_prs.body IS
  'SelfPR.text（自己PR 本文）。';

COMMENT ON COLUMN self_prs.latest_result IS
  'SelfPR.latestResult（最新の生成結果）。';

COMMENT ON COLUMN self_prs.seed_input_hash IS
  'SelfPR.seedInputHash（buildSelfPRDraftSeed 由来 PR のみ持つ canonical 入力 hash）。'
  '補助情報のみで dedup key ではない。手動作成 / legacy PR では NULL。';

COMMENT ON CONSTRAINT self_prs_local_unique ON self_prs IS
  'UNIQUE(user_id, local_pr_id)。SelfPR.id を natural key とし、onConflict 指定の '
  'upsert を冪等化するための制約。content hash は使わない。';


-- 36. trigger: keep updated_at fresh (re-uses set_updated_at() from §3)
CREATE TRIGGER self_prs_set_updated_at
  BEFORE UPDATE ON self_prs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 37. RLS — self_prs
--     Anonymous Auth 経由でも role=authenticated として届くので policy 対象は
--     authenticated。すべての行操作は auth.uid() = user_id で閉じる
--     （self_analysis_logs §34 と同形）。delete policy も owner 限定。
ALTER TABLE self_prs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "self_prs owner select"
  ON self_prs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "self_prs owner insert"
  ON self_prs
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "self_prs owner update"
  ON self_prs
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "self_prs owner delete"
  ON self_prs
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- 38. statement_review_history
--     STEP-SUPABASE-COMPLETE-06A. localStorage key='statementReviewHistory'
--     （志望理由書 添削履歴）の auth-scoped Supabase mirror。localStorage canonical
--     は維持し、本 table は同期先（best-effort durable mirror）。self_prs §35 /
--     self_analysis_logs §32 / tutor_chat_* §19 と同じ auth-scoped 永続層であり、
--     mirror_events 系統ではない。
--
--     natural key は (user_id, local_review_id)。local_review_id = ReviewHistoryItem.id
--     （crypto.randomUUID() 由来の UUID 文字列）をそのまま使う。inputHash / contentHash
--     では dedup しない（同一 essay+大学の再添削も別個の正当な履歴であり、入力ハッシュ
--     で潰してはならない。入力ハッシュは別 localStorage key の cache 専用）。
--
--     ReviewHistoryItem は作成後 不変（本文編集・in-place update なし）。よって upsert は
--     冪等で、UPDATE 経路は同一内容の再書込（または将来の metadata 拡張）のみに使われ、
--     アプリは content を更新しない。
--
--     delete を伴う feature である点に注意。localStorage 側には id 指定の削除
--     （deleteReviewHistoryItem）と 10 件 cap による古い項目の自動 eviction がある。
--     どちらも本 STEP では DB に伝播しない（上り mirror は upsert-only / propagateDelete=false）。
--     down-sync / restore は delete resurrection リスクのため tombstone 設計後の別 STEP
--     （06E）に分離する。10 件超を DB が durable に保持できるのはむしろ利点。
CREATE TABLE statement_review_history (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_review_id  text         NOT NULL,
  university       text         NOT NULL DEFAULT '',
  faculty          text         NOT NULL DEFAULT '',
  department       text         NOT NULL DEFAULT '',
  essay            text         NOT NULL DEFAULT '',
  result           jsonb        NOT NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT statement_review_history_local_unique UNIQUE (user_id, local_review_id)
);

COMMENT ON TABLE statement_review_history IS
  'STEP-SUPABASE-COMPLETE-06A. localStorage statementReviewHistory（志望理由書 添削履歴）の '
  'auth-scoped Supabase durable mirror。localStorage canonical は維持し、本 table は同期先。'
  'natural key = (user_id, local_review_id)。local_review_id = ReviewHistoryItem.id, '
  'result = StatementResult 全体（jsonb）。ReviewHistoryItem は不変で、inputHash では dedup しない。'
  'delete を伴う feature であり、restore は tombstone 設計後の別 STEP に分離する。';

COMMENT ON COLUMN statement_review_history.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id.';

COMMENT ON COLUMN statement_review_history.local_review_id IS
  'localStorage の ReviewHistoryItem.id（crypto.randomUUID() 由来の UUID 文字列）をそのまま入れる。'
  'natural key の一部で upsert の onConflict 対象。inputHash / contentHash ではなく id を identity とする。';

COMMENT ON COLUMN statement_review_history.result IS
  'ReviewHistoryItem.result（StatementResult 全体）を jsonb 丸ごと保存。'
  'overallScore / evaluations / strengths / weaknesses / actions / partialRevision / checklist を含む。'
  '表示時の score 正規化は read 側（normalizeStatementScore）が担保し、本 mirror は raw を忠実保存する。';

COMMENT ON COLUMN statement_review_history.created_at IS
  'ReviewHistoryItem.createdAt を backfill 時に原値保持する（LS の作成時刻）。';

COMMENT ON CONSTRAINT statement_review_history_local_unique ON statement_review_history IS
  'UNIQUE(user_id, local_review_id)。ReviewHistoryItem.id を natural key とし、onConflict 指定の '
  'upsert を冪等化するための制約。inputHash / contentHash は使わない。';


-- 39. trigger: keep updated_at fresh (re-uses set_updated_at() from §3)
--     ReviewHistoryItem は不変のためアプリ起点の UPDATE は基本起きないが、upsert の
--     ON CONFLICT DO UPDATE 経路（同一内容の再書込）や将来の拡張に備えて自動更新を付与する。
CREATE TRIGGER statement_review_history_set_updated_at
  BEFORE UPDATE ON statement_review_history
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 40. RLS — statement_review_history
--     Anonymous Auth 経由でも role=authenticated として届くので policy 対象は
--     authenticated。すべての行操作は auth.uid() = user_id で閉じる
--     （self_prs §37 と同形）。
--
--     UPDATE policy について: ReviewHistoryItem は不変でアプリは content を更新しないが、
--     Supabase の .upsert(..., {onConflict}) は INSERT ... ON CONFLICT DO UPDATE を発行する。
--     UPDATE policy が無いと、冪等な再 upsert（backfill 再実行など）が DO UPDATE 経路で
--     RLS に弾かれ、mirror helper の devWarn に黙って失敗が出続ける。これを避けるため
--     self_prs と同形に owner update policy を置く。アプリが content を能動更新することはない。
ALTER TABLE statement_review_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "statement_review_history owner select"
  ON statement_review_history
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "statement_review_history owner insert"
  ON statement_review_history
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "statement_review_history owner update"
  ON statement_review_history
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "statement_review_history owner delete"
  ON statement_review_history
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- ──────────────────────────────────────────────────────────────────────
-- STEP-TUTOR-CONTEXT-PHASE2-SCHEMA-01: basic_info / diagnosis / activity の
-- auth-scoped durable table（Tutor context 読み取り用）
--
-- 目的:
--   Tutor が basic_info / diagnosis / activity を userId scope で server-side read
--   できるようにするための auth-scoped 永続層を新規追加する。これら 3 機能は
--   STEP-SUPABASE-COMPLETE で auth-scoped 化されず、Phase1 の anonymous write-only
--   mirror（basic_info_mirrors §7 / diagnosis_mirrors §10 / activity_mirrors §13）
--   止まりだった。anonymous mirror は user_id も SELECT policy も持たず read 不能の
--   ため、Tutor からは読めない（STEP-TUTOR-CONTEXT-PHASE2-DESIGN-01 案B）。
--
-- 位置づけ:
--   self_analysis_logs（§32〜§34）/ self_prs（§35〜§37）/ statement_review_history
--   （§38〜§40）/ tutor_chat_*（§19〜§23）と同じ auth-scoped 永続層。RLS は常に
--   auth.uid()=user_id で閉じ、localStorage canonical の "同期先 / durable mirror" と
--   して best-effort で後追い同期する想定（read 切替・hydrate は後続 STEP）。
--
--   既存 anonymous mirror（*_mirrors）とは別責務・別 table で、本 STEP では一切連動
--   しない（DDL 純追加。*_mirrors は無変更）。
--
-- snapshot 型の採用（natural key = UNIQUE(user_id) / 1 ユーザー 1 行）:
--   - basic_info_logs : basic_info は単一 snapshot のため 1 ユーザー 1 最新行。
--   - diagnosis_logs  : 受験タイプ診断も単一 snapshot のため 1 ユーザー 1 最新行。
--   - activity_logs   : Tutor 用途は件数集計のみ。活動配列を payload に丸ごと snapshot
--                       する 1 ユーザー 1 行型とし、活動ごとの行正規化・履歴管理は
--                       必要になった別 STEP に分離する。
--   → 既存 durable table（self_analysis_logs 等の UNIQUE(user_id, local_*) 履歴型）
--     とは異なり、本 3 table は UNIQUE(user_id) の latest-snapshot 型。upsert は
--     onConflict='user_id' で冪等（後続 repository STEP の契約）。
--
-- 列方針（3 table 共通・既存 durable table に整合）:
--   - source_hash は nullable な変更検知 / 冪等補助のヒントであり、conflict key では
--     ない（conflict key は user_id）。anonymous mirror の source_hash（= 必須・conflict
--     key）とは役割が異なる点に注意。
--   - schema_version は payload 契約のバージョン（text。既存 *_mirrors と揃える）。
--   - metadata は self_analysis_logs / self_prs に倣う前方互換用の補助 jsonb。
--
-- PII 観点:
--   - owner RLS で本人しか自分の行を read できないため、anonymous mirror より露出は
--     小さい。とはいえ Tutor 用途に直接 PII（basic_info の氏名等）は不要なので、
--     payload を書く app 側 writer（後続 STEP）が不要 PII を除外して書く契約とする。
--     本 table は jsonb の shape を強制しない（既存 durable table と同方針）。
--
--   §41  basic_info_logs  table
--   §42  basic_info_logs  trigger (set_updated_at)
--   §43  basic_info_logs  RLS
--   §44  diagnosis_logs   table
--   §45  diagnosis_logs   trigger (set_updated_at)
--   §46  diagnosis_logs   RLS
--   §47  activity_logs    table
--   §48  activity_logs    trigger (set_updated_at)
--   §49  activity_logs    RLS
--
-- 所有者契約:
--   user_id は auth.users(id) を参照する owner key。RLS gate は auth.uid()=user_id。
-- ──────────────────────────────────────────────────────────────────────


-- 41. basic_info_logs
--     localStorage basicInfo（key='basicInfo', lib/basicInfoStorage.ts）の auth-scoped
--     durable mirror。1 ユーザー 1 最新 snapshot（UNIQUE(user_id)）。anonymous
--     basic_info_mirrors（§7）とは別責務・別 table で連動しない。
CREATE TABLE basic_info_logs (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payload         jsonb        NOT NULL,
  schema_version  text         NOT NULL DEFAULT '1',
  source_hash     text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT basic_info_logs_user_unique UNIQUE (user_id)
);

COMMENT ON TABLE basic_info_logs IS
  'STEP-TUTOR-CONTEXT-PHASE2-SCHEMA-01. localStorage basicInfo の auth-scoped durable '
  'source（Tutor/context 用に owner RLS で read する）。1 ユーザー 1 最新 snapshot '
  '(UNIQUE(user_id))。anonymous basic_info_mirrors (§7) とは別責務で連動しない。'
  'payload は app 側 writer が不要 PII（氏名等）を除外して書く契約。';

COMMENT ON COLUMN basic_info_logs.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id. natural key でもある。';

COMMENT ON COLUMN basic_info_logs.payload IS
  'BasicInfo の最新 snapshot（jsonb 丸ごと）。shape は DB では強制しない。'
  'Tutor 用途に不要な直接 PII（氏名等）は app 側 writer が除外する契約。';

COMMENT ON COLUMN basic_info_logs.schema_version IS
  'payload 契約のバージョン（text）。既存 *_mirrors と揃える。';

COMMENT ON COLUMN basic_info_logs.source_hash IS
  'nullable な変更検知 / 冪等補助のヒント。conflict key ではない（conflict key は '
  'user_id）。anonymous mirror の必須 source_hash とは役割が異なる。';

COMMENT ON CONSTRAINT basic_info_logs_user_unique ON basic_info_logs IS
  'UNIQUE(user_id)。1 ユーザー 1 最新 snapshot。upsert は onConflict=''user_id'' で冪等。';


-- 42. trigger: keep updated_at fresh (re-uses set_updated_at() from §3)
CREATE TRIGGER basic_info_logs_set_updated_at
  BEFORE UPDATE ON basic_info_logs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 43. RLS — basic_info_logs
--     Anonymous Auth 経由でも role=authenticated として届くので policy 対象は
--     authenticated。すべての行操作は auth.uid() = user_id で閉じる
--     （self_analysis_logs §34 と同形）。
ALTER TABLE basic_info_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "basic_info_logs owner select"
  ON basic_info_logs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "basic_info_logs owner insert"
  ON basic_info_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "basic_info_logs owner update"
  ON basic_info_logs
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "basic_info_logs owner delete"
  ON basic_info_logs
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- 44. diagnosis_logs
--     localStorage diagnosis（受験タイプ診断, lib/diagnosisStorage.ts）の auth-scoped
--     durable mirror。1 ユーザー 1 最新 snapshot（UNIQUE(user_id)）。anonymous
--     diagnosis_mirrors（§10）とは別責務・別 table で連動しない。payload は no-PII
--     （answers は数値 index / resultType は固定 enum / title・description は app 製固定文）。
CREATE TABLE diagnosis_logs (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payload         jsonb        NOT NULL,
  schema_version  text         NOT NULL DEFAULT '1',
  source_hash     text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT diagnosis_logs_user_unique UNIQUE (user_id)
);

COMMENT ON TABLE diagnosis_logs IS
  'STEP-TUTOR-CONTEXT-PHASE2-SCHEMA-01. localStorage diagnosis（受験タイプ診断）の '
  'auth-scoped durable source（Tutor/context 用に owner RLS で read する）。'
  '1 ユーザー 1 最新 snapshot (UNIQUE(user_id))。anonymous diagnosis_mirrors (§10) '
  'とは別責務で連動しない。payload は no-PII（数値 index / 固定 enum / app 製固定文）。';

COMMENT ON COLUMN diagnosis_logs.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id. natural key でもある。';

COMMENT ON COLUMN diagnosis_logs.payload IS
  'DiagnosisResult の最新 snapshot（jsonb 丸ごと）。shape は DB では強制しない。';

COMMENT ON COLUMN diagnosis_logs.schema_version IS
  'payload 契約のバージョン（text）。既存 *_mirrors と揃える。';

COMMENT ON COLUMN diagnosis_logs.source_hash IS
  'nullable な変更検知 / 冪等補助のヒント。conflict key ではない（conflict key は '
  'user_id）。anonymous mirror の必須 source_hash とは役割が異なる。';

COMMENT ON CONSTRAINT diagnosis_logs_user_unique ON diagnosis_logs IS
  'UNIQUE(user_id)。1 ユーザー 1 最新 snapshot。upsert は onConflict=''user_id'' で冪等。';


-- 45. trigger: keep updated_at fresh (re-uses set_updated_at() from §3)
CREATE TRIGGER diagnosis_logs_set_updated_at
  BEFORE UPDATE ON diagnosis_logs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 46. RLS — diagnosis_logs
--     authenticated 対象。全行操作を auth.uid() = user_id で閉じる（§43 と同形）。
ALTER TABLE diagnosis_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "diagnosis_logs owner select"
  ON diagnosis_logs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "diagnosis_logs owner insert"
  ON diagnosis_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "diagnosis_logs owner update"
  ON diagnosis_logs
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "diagnosis_logs owner delete"
  ON diagnosis_logs
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- 47. activity_logs
--     localStorage activityData（活動整理, lib/activityStorage.ts）の auth-scoped
--     durable mirror。1 ユーザー 1 行に「活動配列を丸ごと snapshot」する型
--     （UNIQUE(user_id)）。anonymous activity_mirrors（§13）とは別責務・別 table で
--     連動しない。
--
--     正規化の判断:
--       Tutor 用途は件数集計（カテゴリ別件数）だけを読むため、活動ごとの行分割は
--       不要。まずは ActivityData 全体を payload に snapshot する 1 行型で十分。
--       活動ごとの履歴管理 / 行正規化が必要になったら別 STEP で activity_items 等へ
--       分離する（本 STEP では over-engineering を避ける）。
CREATE TABLE activity_logs (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payload         jsonb        NOT NULL,
  schema_version  text         NOT NULL DEFAULT '1',
  source_hash     text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT activity_logs_user_unique UNIQUE (user_id)
);

COMMENT ON TABLE activity_logs IS
  'STEP-TUTOR-CONTEXT-PHASE2-SCHEMA-01. localStorage activityData（活動整理）の '
  'auth-scoped durable source（Tutor/context 用に owner RLS で read する）。'
  '1 ユーザー 1 行に ActivityData 全体を snapshot（UNIQUE(user_id)）。anonymous '
  'activity_mirrors (§13) とは別責務で連動しない。活動ごとの行正規化は別 STEP。';

COMMENT ON COLUMN activity_logs.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id. natural key でもある。';

COMMENT ON COLUMN activity_logs.payload IS
  'ActivityData 全体の最新 snapshot（9 カテゴリ配列を含む jsonb 丸ごと）。'
  'shape は DB では強制しない。Tutor は主にカテゴリ別件数のみ参照する。';

COMMENT ON COLUMN activity_logs.schema_version IS
  'payload 契約のバージョン（text）。既存 *_mirrors と揃える。';

COMMENT ON COLUMN activity_logs.source_hash IS
  'nullable な変更検知 / 冪等補助のヒント。conflict key ではない（conflict key は '
  'user_id）。anonymous mirror の必須 source_hash とは役割が異なる。';

COMMENT ON CONSTRAINT activity_logs_user_unique ON activity_logs IS
  'UNIQUE(user_id)。1 ユーザー 1 最新 snapshot。upsert は onConflict=''user_id'' で冪等。';


-- 48. trigger: keep updated_at fresh (re-uses set_updated_at() from §3)
CREATE TRIGGER activity_logs_set_updated_at
  BEFORE UPDATE ON activity_logs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 49. RLS — activity_logs
--     authenticated 対象。全行操作を auth.uid() = user_id で閉じる（§43 と同形）。
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activity_logs owner select"
  ON activity_logs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "activity_logs owner insert"
  ON activity_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "activity_logs owner update"
  ON activity_logs
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "activity_logs owner delete"
  ON activity_logs
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- ════════════════════════════════════════════════════════════════════════
--   §50–§52  essay_workspaces — 小論文ワークスペースの durable mirror
-- ════════════════════════════════════════════════════════════════════════
--   §50  essay_workspaces  table
--   §51  essay_workspaces  trigger (set_updated_at)
--   §52  essay_workspaces  RLS
--
-- 50. essay_workspaces
--     localStorage key='essayWorkspaces'（小論文 EssayWorkspace[], lib/essayWorkspaceStorage.ts）
--     の auth-scoped Supabase durable mirror。localStorage canonical は維持し、本 table は
--     同期先（best-effort）。self_prs §35 / self_analysis_logs §32 / statement_review_history
--     §38 と同じ auth-scoped 永続層であり、anonymous *_mirrors 系統ではない。
--
--     【志望理由書(statement)とは別機能】statement_review_history（§38, 志望理由書添削履歴）
--     とは混同しない。本 table は小論文(essay)練習ワークスペース専用。
--
--     natural key は (user_id, local_workspace_id)。local_workspace_id = EssayWorkspace.id
--     （'ws-{timestamp}-{random4hex}' 形式）をそのまま使う。
--
--     statement_review_history（不変 item）と異なり、EssayWorkspace は可変である
--     （body の autosave / reviews の追記 / improvementInProgress の更新）。よって upsert は
--     workspace 全体を都度上書きする mirror として使う（onConflict で冪等）。activity_logs
--     §47 と同じ「ドキュメント全体を payload に snapshot」する型だが、1 ユーザー複数件
--     （localStorage 側は LRU 10 件）保持するため UNIQUE は (user_id, local_workspace_id)。
--
--     delete を伴う点に注意: localStorage 側に 10 件 cap eviction がある。本 STEP では
--     DB に伝播しない（上り mirror は upsert-only）。DB が 10 件超を durable 保持できるのは
--     むしろ利点。down-sync / restore は別 STEP。
CREATE TABLE essay_workspaces (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_workspace_id  text         NOT NULL,
  workspace           jsonb        NOT NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT essay_workspaces_local_unique UNIQUE (user_id, local_workspace_id)
);

COMMENT ON TABLE essay_workspaces IS
  '小論文(essay)ワークスペース（localStorage essayWorkspaces）の auth-scoped Supabase durable mirror。'
  'localStorage canonical は維持し、本 table は同期先。natural key = (user_id, local_workspace_id)。'
  'local_workspace_id = EssayWorkspace.id, workspace = EssayWorkspace 全体（jsonb・本文/テーマ/'
  '添削結果 reviews/改善 improvementInProgress を含む）。志望理由書 statement_review_history (§38) '
  'とは別機能で混同しない。EssayWorkspace は可変なので upsert で全体を都度上書きする。';

COMMENT ON COLUMN essay_workspaces.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id.';

COMMENT ON COLUMN essay_workspaces.local_workspace_id IS
  'localStorage の EssayWorkspace.id（''ws-{timestamp}-{random4hex}'' 形式）をそのまま入れる。'
  'natural key の一部で upsert の onConflict 対象。';

COMMENT ON COLUMN essay_workspaces.workspace IS
  'EssayWorkspace 全体を jsonb 丸ごと保存（types/essay.ts）。target / theme / mini / body / '
  'reviews（添削結果・スコア）/ improvementInProgress（改善 Q&A・AI 改善方針）/ sparring を含む。'
  'shape は DB では強制しない。表示時の normalize は read 側（lib/essayWorkspaceStorage.ts）が担保する。';

COMMENT ON COLUMN essay_workspaces.created_at IS
  'EssayWorkspace.createdAt を mirror 時に原値保持する（LS の作成時刻）。';

COMMENT ON CONSTRAINT essay_workspaces_local_unique ON essay_workspaces IS
  'UNIQUE(user_id, local_workspace_id)。EssayWorkspace.id を natural key とし、onConflict 指定の '
  'upsert を冪等化するための制約。';


-- 51. trigger: keep updated_at fresh (re-uses set_updated_at() from §3)
--     EssayWorkspace は可変なので、upsert の ON CONFLICT DO UPDATE 経路で updated_at を前進させる。
CREATE TRIGGER essay_workspaces_set_updated_at
  BEFORE UPDATE ON essay_workspaces
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 52. RLS — essay_workspaces
--     Anonymous Auth 経由でも role=authenticated として届くので policy 対象は authenticated。
--     すべての行操作を auth.uid() = user_id で閉じる（statement_review_history §40 と同形）。
--     UPDATE policy が必要な理由: .upsert(..., {onConflict}) は INSERT ... ON CONFLICT DO UPDATE
--     を発行する。EssayWorkspace は可変で実際に DO UPDATE 経路を頻繁に通るため、UPDATE policy が
--     無いと mirror が RLS に弾かれ devWarn に黙って失敗が出続ける。
ALTER TABLE essay_workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "essay_workspaces owner select"
  ON essay_workspaces
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "essay_workspaces owner insert"
  ON essay_workspaces
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "essay_workspaces owner update"
  ON essay_workspaces
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "essay_workspaces owner delete"
  ON essay_workspaces
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- 53. interview_practice_records
--     STEP-INTERVIEW-AI-PR1. localStorage key='interview_records'
--     （面接練習記録 / lib/interviewRecordStorage.ts の StoredInterviewRecord[]）の
--     auth-scoped Supabase durable mirror。localStorage canonical は維持し、本 table は
--     同期先（best-effort durable mirror）。self_prs §35 / statement_review_history §38 /
--     self_analysis_logs §32 / tutor_chat_* §19 と同じ auth-scoped 永続層であり、
--     mirror_events 系統ではない。
--
--     natural key は (user_id, local_record_id)。local_record_id = StoredInterviewRecord.id
--     （crypto.randomUUID() 由来の UUID 文字列）をそのまま使う。contentHash では dedup
--     しない（同一大学・同一日付の別練習も別個の正当な記録であり、id を identity とする）。
--
--     StoredInterviewRecord はアプリ上 in-place 編集経路を持たず、作成（addInterviewRecord）と
--     削除（deleteInterviewRecord）のみ。よって upsert は冪等で、UPDATE 経路は同一内容の
--     再書込（または将来の metadata 拡張）に使われる。
--
--     delete を伴う feature である点に注意。localStorage 側の id 指定削除は本 STEP では
--     DB に伝播しない（上り mirror は upsert-only / propagateDelete=false）。down-sync /
--     restore は delete resurrection リスクのため tombstone 設計後の別 STEP に分離する。
--
--     feedback_json は AI 面接フィードバック（InterviewFeedback）の構造化データ。
--     localStorage では JSON 文字列（StoredInterviewRecord.feedbackJson）で保持されるが、
--     本 table では jsonb として保存する（statement_review_history.result と同方針）。
--     旧記録は feedbackJson 欠落のため NULL になりうる。read 側の正規化（feedbackToText /
--     isInterviewFeedback）は restore STEP が担保し、本 mirror は raw を忠実保存する。
CREATE TABLE interview_practice_records (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_record_id     text         NOT NULL,
  practice_date       text         NOT NULL DEFAULT '',
  university_name     text         NOT NULL DEFAULT '',
  faculty_name        text         NOT NULL DEFAULT '',
  exam_type           text         NOT NULL DEFAULT '',
  partner             text         NOT NULL DEFAULT '',
  main_question       text         NOT NULL DEFAULT '',
  improvement_summary text         NOT NULL DEFAULT '',
  questions_asked     text         NOT NULL DEFAULT '',
  my_answers          text         NOT NULL DEFAULT '',
  what_went_wrong     text         NOT NULL DEFAULT '',
  feedback_received   text         NOT NULL DEFAULT '',
  self_noted          text         NOT NULL DEFAULT '',
  feedback_json       jsonb,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  metadata            jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT interview_practice_records_local_unique UNIQUE (user_id, local_record_id)
);

COMMENT ON TABLE interview_practice_records IS
  'STEP-INTERVIEW-AI-PR1. localStorage interview_records（面接練習記録）の auth-scoped '
  'Supabase durable mirror。localStorage canonical は維持し、本 table は同期先。'
  'natural key = (user_id, local_record_id)。local_record_id = StoredInterviewRecord.id。'
  'feedback_json = InterviewFeedback（jsonb）。記録は作成 + 削除のみで in-place 編集なし。'
  'delete を伴う feature であり、restore は tombstone 設計後の別 STEP に分離する。';

COMMENT ON COLUMN interview_practice_records.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id.';

COMMENT ON COLUMN interview_practice_records.local_record_id IS
  'localStorage の StoredInterviewRecord.id（crypto.randomUUID() 由来の UUID 文字列）を '
  'そのまま入れる。natural key の一部で upsert の onConflict 対象。contentHash ではなく '
  'id を identity とする。';

COMMENT ON COLUMN interview_practice_records.feedback_json IS
  'StoredInterviewRecord.feedbackJson（AI 面接フィードバックの構造化データ）を jsonb 化して '
  '保存。LS では JSON 文字列で持つ。旧記録は欠落のため NULL になりうる。表示時の正規化は '
  'read 側（feedbackToText / isInterviewFeedback）が担保し、本 mirror は raw を忠実保存する。';

COMMENT ON COLUMN interview_practice_records.created_at IS
  'StoredInterviewRecord.createdAt を backfill 時に原値保持する（LS の作成時刻）。';

COMMENT ON CONSTRAINT interview_practice_records_local_unique ON interview_practice_records IS
  'UNIQUE(user_id, local_record_id)。StoredInterviewRecord.id を natural key とし、'
  'onConflict 指定の upsert を冪等化するための制約。contentHash は使わない。';


-- 54. trigger: keep updated_at fresh (re-uses set_updated_at() from §3)
--     StoredInterviewRecord は in-place 編集を持たないためアプリ起点の UPDATE は基本
--     起きないが、upsert の ON CONFLICT DO UPDATE 経路（同一内容の再書込）や将来の拡張に
--     備えて自動更新を付与する（statement_review_history §39 と同形）。
CREATE TRIGGER interview_practice_records_set_updated_at
  BEFORE UPDATE ON interview_practice_records
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 55. RLS — interview_practice_records
--     Anonymous Auth 経由でも role=authenticated として届くので policy 対象は
--     authenticated。すべての行操作は auth.uid() = user_id で閉じる
--     （self_prs §37 / statement_review_history §40 と同形）。
--
--     UPDATE policy について: 記録は in-place 編集されないが、Supabase の
--     .upsert(..., {onConflict}) は INSERT ... ON CONFLICT DO UPDATE を発行する。
--     UPDATE policy が無いと、冪等な再 upsert（backfill 再実行など）が DO UPDATE 経路で
--     RLS に弾かれ、mirror helper の devWarn に黙って失敗が出続ける。これを避けるため
--     owner update policy を置く。アプリが content を能動更新することはない。
ALTER TABLE interview_practice_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "interview_practice_records owner select"
  ON interview_practice_records
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "interview_practice_records owner insert"
  ON interview_practice_records
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "interview_practice_records owner update"
  ON interview_practice_records
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "interview_practice_records owner delete"
  ON interview_practice_records
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- ──────────────────────────────────────────────────────────────────────
-- STEP-INTERVIEW-AI-PR3: Interview AI（リアルタイム面接セッション）の DB 基盤
--
-- 目的:
--   docs/interview_ai/pr0_design.md で確定した Interview AI 機能のスキーマを導入する。
--   本 PR は **schema + RLS のみ**（repository / route / 課金配線 / STT は後続 PR）。
--
-- 既存 interview_practice_records（§53）との区別:
--   §53 は既存の面接練習「記録」（手入力 + 一括 AI フィードバック）の localStorage mirror。
--   本系統（interview_ai_*）は対話型・逐次ターンの「リアルタイム面接 AI セッション」であり、
--   別 feature・別課金単位（1 セッション 1 quota）・別冪等化（usage_recorded）を持つ。
--
-- 課金との関係（pr0_design.md §2–§5）:
--   - quota feature は別キー 'interview-ai'（lib/billing/quotas.ts。本 PR では未追加 → 別 PR）。
--   - recordUsage は「voice の最初の STT 成功」「text の最初の回答保存」の 2 箇所のみ。
--   - 二重課金防止は interview_ai_sessions.usage_recorded の compare-and-set:
--       UPDATE interview_ai_sessions SET usage_recorded = true
--       WHERE id = :id AND usage_recorded = false RETURNING id;
--     行が返ったプロセスだけが recordUsage を呼ぶ。
--   - 本 PR は schema のみ。compare-and-set / recordUsage の実装は後続 PR。
--
--   §56  interview_ai_sessions table
--   §57  interview_ai_sessions trigger (set_updated_at) + in_progress 部分 unique index
--   §58  interview_ai_sessions RLS（owner 直接判定）
--   §59  interview_ai_results table
--   §60  interview_ai_results RLS（EXISTS 方式 — 親セッション所有を構造的に保証）
--
-- 所有者契約:
--   user_id は auth.users(id) を参照する owner key。RLS gate は auth.uid()=user_id
--   （results は親 interview_ai_sessions の所有を EXISTS で判定）。
--   課金計上（usage_recorded の compare-and-set / final feedback 保存）は service_role
--   （server-only）から行う想定で、RLS をバイパスする。owner policy は client 読み取り /
--   セッション状態遷移のための経路。
-- ──────────────────────────────────────────────────────────────────────


-- 56. interview_ai_sessions
--     リアルタイム面接 AI の 1 セッション。状態・課金冪等フラグ・対象参照を持つ。
--     pr0_design.md §6.1。
CREATE TABLE interview_ai_sessions (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source          text         NOT NULL,
  status          text         NOT NULL DEFAULT 'in_progress',
  usage_recorded  boolean      NOT NULL DEFAULT false,
  target_ref      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  -- STEP-INTERVIEW-AI-TYPE: 面接タイプ連動（どの機能データをもとに練習するか）。
  --   既存テーブルへは supabase/interview_ai_interview_type_migration.sql で後追い追加。
  --   source（voice/text の回答モダリティ）とは別概念なので混同しないこと。
  interview_type  text         NOT NULL DEFAULT 'free',
  source_type     text,
  source_id       text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  -- STEP-INTERVIEW-AI-REALTIME-PR1: 'realtime'（WebRTC リアルタイム音声面接モード）を追加。
  --   既存の voice/text（ターン制の回答モダリティ）とは別モード。session 単位で realtime か否かを表す。
  --   本番への後追いは supabase/interview_ai_realtime_source_migration.sql（DROP+ADD CONSTRAINT のみ）。
  CONSTRAINT interview_ai_sessions_source_check
    CHECK (source IN ('voice', 'text', 'realtime')),
  CONSTRAINT interview_ai_sessions_status_check
    CHECK (status IN ('in_progress', 'completed', 'abandoned'))
  -- 注: interview_type / source_type は CHECK 制約を付けない（additive 方針 / 値の妥当性は
  --     アプリ層の isInterviewType で担保）。本番への後追いは ADD COLUMN のみの migration を使う。
);

COMMENT ON TABLE interview_ai_sessions IS
  'STEP-INTERVIEW-AI-PR3. リアルタイム面接 AI の 1 セッション（auth-scoped）。'
  '1 セッション = interview-ai quota を正確に 1 回消費する課金単位。usage_recorded は '
  'voice/text 共通の二重課金防止フラグ（compare-and-set 対象）。pr0_design.md §6.1。';

COMMENT ON COLUMN interview_ai_sessions.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id.';

COMMENT ON COLUMN interview_ai_sessions.source IS
  'CHECK in (voice, text, realtime)。課金トリガが分岐する: voice=最初の STT 成功 / '
  'text=最初の回答保存 / realtime=最初の有効発話（pr0_design.md §2 / realtime pr1_token.md）。';

COMMENT ON COLUMN interview_ai_sessions.status IS
  'CHECK in (in_progress, completed, abandoned)。in_progress は user ごと 1 件まで '
  '（§57 の部分 unique index で強制）。pr0_design.md §7.3。';

COMMENT ON COLUMN interview_ai_sessions.usage_recorded IS
  '二重課金防止フラグ。compare-and-set（UPDATE ... WHERE usage_recorded=false '
  'RETURNING id）で行が返ったプロセスだけが recordUsage を呼ぶ。pr0_design.md §3。';

COMMENT ON COLUMN interview_ai_sessions.target_ref IS
  '面接対象（大学 / 学部 / 想定質問セット等）の参照。アプリ契約として version キーを '
  '含める（pr0_design.md §6.3）。DB は jsonb の shape を強制しない（既存 durable table と同方針）。';


-- 57. trigger + in_progress 部分 unique index
--     trigger: set_updated_at()（§3 共有）でセッション状態遷移時の updated_at を維持。
--     部分 unique index: status='in_progress' の行を user_id ごと 1 件に制限する。
--       これが deferred recordUsage（gate 通過後〜計上までの窓）の quota 回避を封じる要
--       （pr0_design.md §3.3 / §7.3）。completed / abandoned には制約がかからない。
CREATE TRIGGER interview_ai_sessions_set_updated_at
  BEFORE UPDATE ON interview_ai_sessions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX interview_ai_sessions_one_in_progress
  ON interview_ai_sessions (user_id)
  WHERE status = 'in_progress';


-- 58. RLS — interview_ai_sessions
--     Anonymous Auth 経由でも role=authenticated として届くので policy 対象は
--     authenticated。すべての行操作は auth.uid() = user_id で閉じる。
--     課金計上（usage_recorded の compare-and-set）は service_role（server-only）が
--     RLS をバイパスして行う想定。owner policy は client 読み取り / 状態遷移の経路。
ALTER TABLE interview_ai_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "interview_ai_sessions owner select"
  ON interview_ai_sessions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "interview_ai_sessions owner insert"
  ON interview_ai_sessions
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "interview_ai_sessions owner update"
  ON interview_ai_sessions
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "interview_ai_sessions owner delete"
  ON interview_ai_sessions
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- 59. interview_ai_results
--     セッション完了時の最終フィードバック（音声は保存しない / pr0_design.md §7.1）。
--     feedback は既存 InterviewFeedback（types/interview.ts）を jsonb 丸ごと保存し、
--     strengths / improvements / next_practice は結果サマリの正規化カラム
--     （履歴一覧 / 成長メモから JOIN なしで読めるようにする。pr0_design.md §6.2）。
--     1 セッション 1 結果（UNIQUE(session_id)）。完了時の upsert を冪等化する。
CREATE TABLE interview_ai_results (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid         NOT NULL REFERENCES public.interview_ai_sessions(id) ON DELETE CASCADE,
  user_id        uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feedback       jsonb        NOT NULL,
  strengths      text[]       NOT NULL DEFAULT '{}',
  improvements   text[]       NOT NULL DEFAULT '{}',
  next_practice  text[]       NOT NULL DEFAULT '{}',
  created_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT interview_ai_results_session_unique UNIQUE (session_id)
);

COMMENT ON TABLE interview_ai_results IS
  'STEP-INTERVIEW-AI-PR3. 面接 AI セッションの最終フィードバック（auth-scoped）。'
  'feedback = InterviewFeedback（jsonb）。strengths/improvements/next_practice は正規化カラム。'
  '音声は保存しない。1 セッション 1 結果（UNIQUE(session_id)）。pr0_design.md §6.2 / §7.1。';

COMMENT ON COLUMN interview_ai_results.session_id IS
  'interview_ai_sessions(id) を参照。ON DELETE CASCADE。UNIQUE で 1 セッション 1 結果。';

COMMENT ON COLUMN interview_ai_results.user_id IS
  'auth.users(id). owner key を複製（JOIN なしの直接参照用）。RLS は §60 の EXISTS 方式で '
  '親セッション所有を判定する（user_id 単独ではなく親 row の所有を構造的に保証）。';

COMMENT ON COLUMN interview_ai_results.feedback IS
  'InterviewFeedback（types/interview.ts）を jsonb 丸ごと保存。既存 feedbackToText / '
  'isInterviewFeedback を read 側で再利用する。pr0_design.md §8。';


-- 60. RLS — interview_ai_results（EXISTS 方式）
--     results の所有は「親 interview_ai_sessions が自分のものか」を EXISTS で判定する
--     （pr0_design.md §6.4）。user_id を複製しているため auth.uid()=user_id でも閉じるが、
--     親セッションの所有と結果の所有が必ず一致することを RLS で保証するため EXISTS を採る
--     （孤児・付け替えを構造的に排除）。final feedback の書き込みは service_role（server-only）が
--     RLS をバイパスして行う想定。owner policy は client 読み取り経路。
ALTER TABLE interview_ai_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "interview_ai_results owner select"
  ON interview_ai_results
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM interview_ai_sessions s
      WHERE s.id = interview_ai_results.session_id
        AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "interview_ai_results owner insert"
  ON interview_ai_results
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM interview_ai_sessions s
      WHERE s.id = interview_ai_results.session_id
        AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "interview_ai_results owner update"
  ON interview_ai_results
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM interview_ai_sessions s
      WHERE s.id = interview_ai_results.session_id
        AND s.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM interview_ai_sessions s
      WHERE s.id = interview_ai_results.session_id
        AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "interview_ai_results owner delete"
  ON interview_ai_results
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM interview_ai_sessions s
      WHERE s.id = interview_ai_results.session_id
        AND s.user_id = auth.uid()
    )
  );


-- 61. interview_ai_turns
--     STEP-INTERVIEW-AI-PR6. 面接 AI セッションの 1 ターン（質問 or 回答）の transcript。
--     音声は保存しない（content は transcript テキストのみ。pr0_design.md §7.1 / PR6 必須条件 §6）。
--     role='question'（AI 生成の質問）/ 'answer'（候補者の回答）。source は当該 content の入力
--     モダリティ（question は常に text、answer は voice=STT / text=直接入力）。
--     turn_index は session 内の 0 始まり連番（0=seed question, 1=answer, 2=followup, ...）。
--     ターン上限（MVP 3〜5）は role='answer' の件数で route 側が強制する（PR6 必須条件 §7）。
CREATE TABLE interview_ai_turns (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid         NOT NULL REFERENCES public.interview_ai_sessions(id) ON DELETE CASCADE,
  user_id     uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  turn_index  integer      NOT NULL,
  role        text         NOT NULL,
  source      text         NOT NULL,
  content     text         NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT interview_ai_turns_role_check
    CHECK (role IN ('question', 'answer')),
  CONSTRAINT interview_ai_turns_source_check
    CHECK (source IN ('voice', 'text')),
  CONSTRAINT interview_ai_turns_session_index_unique UNIQUE (session_id, turn_index)
);

COMMENT ON TABLE interview_ai_turns IS
  'STEP-INTERVIEW-AI-PR6. 面接 AI セッションの 1 ターンの transcript（auth-scoped）。'
  '音声は保存しない（content は transcript のみ）。role=question/answer。turn_index は '
  'session 内 0 始まり連番。ターン上限は role=answer 件数で route 側が強制。';

COMMENT ON COLUMN interview_ai_turns.user_id IS
  'auth.users(id). owner key を複製（JOIN なし参照用）。RLS は §62 の EXISTS 方式で '
  '親 interview_ai_sessions 所有を判定する。';

COMMENT ON COLUMN interview_ai_turns.role IS
  'CHECK in (question, answer)。question=AI 生成の質問 / answer=候補者の回答。';

COMMENT ON COLUMN interview_ai_turns.source IS
  'CHECK in (voice, text)。content の入力モダリティ。question は常に text、'
  'answer は voice(STT) / text(直接)。';

COMMENT ON COLUMN interview_ai_turns.content IS
  'transcript テキスト。音声ファイルは一切保存しない（PR6 必須条件 §6）。';

COMMENT ON CONSTRAINT interview_ai_turns_session_index_unique ON interview_ai_turns IS
  'UNIQUE(session_id, turn_index)。同一セッション内のターン順序を一意化し、'
  '二重 insert（リトライ）を弾く。';


-- 62. RLS — interview_ai_turns（EXISTS 方式 / interview_ai_results §60 と同形）
--     親 interview_ai_sessions が自分のものかを EXISTS で判定する。turn の書き込みは
--     service_role（server-only / turn route）が RLS をバイパスして行う想定。owner policy は
--     client 読み取り経路。
ALTER TABLE interview_ai_turns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "interview_ai_turns owner select"
  ON interview_ai_turns
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM interview_ai_sessions s
      WHERE s.id = interview_ai_turns.session_id
        AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "interview_ai_turns owner insert"
  ON interview_ai_turns
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM interview_ai_sessions s
      WHERE s.id = interview_ai_turns.session_id
        AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "interview_ai_turns owner update"
  ON interview_ai_turns
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM interview_ai_sessions s
      WHERE s.id = interview_ai_turns.session_id
        AND s.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM interview_ai_sessions s
      WHERE s.id = interview_ai_turns.session_id
        AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "interview_ai_turns owner delete"
  ON interview_ai_turns
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM interview_ai_sessions s
      WHERE s.id = interview_ai_turns.session_id
        AND s.user_id = auth.uid()
    )
  );


-- ──────────────────────────────────────────────────────────────────────
-- STEP-PRESENTATION-PR1: プレゼン機能（録画 → AI評価 → 発表後AI質問）の DB 基盤
--
-- 目的:
--   docs/presentation/pr0_design.md で確定したプレゼン機能のスキーマを導入する。
--   本 PR は **schema + RLS + Storage bucket/policy のみ**
--   （repository / route / 課金配線 / STT / Storage アップロード UI / AI プロンプトは後続 PR）。
--
-- 面接 AI（interview_ai_* §56-§62）との関係:
--   - 設計思想（1 セッション 1 課金 / usage_recorded compare-and-set / カテゴリ評価 /
--     ターン制 Q&A / owner RLS / set_updated_at 共有）を踏襲する。
--   - 最大の差分は「動画を Supabase Storage に永続保存する」点（面接 AI は音声非保存）。
--     文字起こしテキストのみ DB 保存する点は面接 AI と同じ（attempts.transcript）。
--
-- 課金との関係（pr0_design.md §8）:
--   - quota feature は別キー 'presentation'（lib/billing/quotas.ts。本 PR では未追加 → 別 PR）。
--     basic=0（Basic 利用不可 = Premium 限定）/ premium=20（暫定。動画 Storage 原価込みで要調整）。
--   - recordUsage は「初回 AI 評価成功時」の 1 箇所のみ。アップロード・文字起こしでは消費しない。
--   - 二重課金防止は presentation_sessions.usage_recorded の compare-and-set（§63）:
--       UPDATE presentation_sessions SET usage_recorded = true
--       WHERE id = :id AND usage_recorded = false RETURNING id;
--     行が返ったプロセスだけが recordUsage を呼ぶ。
--   - 録り直しは追加消費しない（usage_recorded を attempt ではなく session に持たせるため）。
--   - 本 PR は schema のみ。compare-and-set / recordUsage / ensurePlanQuota 配線は後続 PR。
--
--   §63 presentation_sessions table
--   §64 presentation_sessions trigger (set_updated_at) + in_progress 部分 unique index
--   §65 presentation_sessions RLS（owner 直接判定 / DELETE policy は付与しない＝server-only）
--   §66 presentation_attempts table
--   §67 presentation_attempts trigger (set_updated_at)
--   §68 presentation_attempts RLS（owner SELECT のみ / 書込は service_role）
--   §69 presentation_results table
--   §70 presentation_results RLS（owner SELECT のみ / 書込は service_role）
--   §71 presentation_qa_turns table
--   §72 presentation_qa_turns RLS（owner SELECT のみ / 書込は service_role）
--   §73 presentation_practice_records table
--   §74 presentation_practice_records trigger (set_updated_at)
--   §75 presentation_practice_records RLS（owner 直接判定 / 全 CRUD）
--   §76 Storage bucket: presentation-recordings（private）
--   §77 Storage RLS — storage.objects（path 第1階層 = auth.uid() の本人 SELECT/INSERT のみ）
--
-- 所有者契約 / RLS 方針（pr0_design.md §9）:
--   - user_id は auth.users(id) を参照する owner key。
--   - 親（sessions / practice_records）: owner 直接判定（auth.uid()=user_id）。
--   - 子（attempts/results/qa_turns）: user_id を非正規化で持ち、SELECT は auth.uid()=user_id で
--     閉じる。INSERT/UPDATE/DELETE policy は **付与しない** ＝ authenticated からの書込を DB
--     レベルで禁じ、サーバルート（service_role / RLS バイパス）に限定する（評価・課金・文字起こし
--     の改ざん防止）。
--   - session / attempt の削除は Storage オブジェクトの明示削除（storage.remove）を伴うため
--     サーバルート専用とし、authenticated の DELETE policy を付与しない（孤児動画防止 / 要対応B）。
--     practice_records は Storage 非関与のため owner DELETE を許可する（interview_practice_records 同方針）。
-- ──────────────────────────────────────────────────────────────────────


-- 63. presentation_sessions
--     プレゼン練習の 1 セッション。テーマ設定 ＋ 課金冪等フラグ（usage_recorded）を持つ
--     課金単位。1 セッション = presentation quota を正確に 1 回消費する。pr0_design.md §4.2。
CREATE TABLE presentation_sessions (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status          text         NOT NULL DEFAULT 'in_progress',
  university_name text         NOT NULL DEFAULT '',
  faculty_name    text         NOT NULL DEFAULT '',
  -- 大学選択画面（STEP-PRESENTATION-UNIVERSITY）の任意項目。手入力。NULL 許容（後方互換）。
  department_name        text,
  admission_type         text,
  presentation_format    text,
  presentation_limit_sec integer,
  university_notes       text,
  theme           text         NOT NULL DEFAULT '',
  time_limit_sec  integer      NOT NULL DEFAULT 0,
  script          text         NOT NULL DEFAULT '',
  -- テーマ設定モード（STEP-PRESENTATION-THEME-MODE）。'manual' | 'generated'。NULL 許容（既存=manual 相当）。
  theme_mode             text,
  generated_conditions   jsonb,   -- generated 時の発表条件（string[]）
  generated_questions    jsonb,   -- generated 時の想定質問（string[]）
  -- 発表資料（任意 / Premium 限定機能の拡張。STEP-PRESENTATION-MATERIAL）。
  --   1 セッション 1 資料（presentation-materials bucket の userId/sessionId/material.ext を指す）。
  --   未アップロードなら全て NULL（後方互換: 既存セッションは NULL）。
  material_path       text,
  material_mime_type  text,
  material_file_name  text,
  material_size_bytes integer,
  -- 発表資料の TTL 自動削除（90 日）。Storage 上のファイルを消した時刻。NULL=未削除（後方互換）。
  --   material_path 自体は残し、履歴では「資料保存期限切れ」と表示する。
  --   後追いは supabase/presentation_ttl_migration.sql（ADD COLUMN IF NOT EXISTS）。
  material_deleted_at timestamptz,
  usage_recorded  boolean      NOT NULL DEFAULT false,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT presentation_sessions_status_check
    CHECK (status IN ('in_progress', 'completed', 'abandoned'))
);

COMMENT ON TABLE presentation_sessions IS
  'STEP-PRESENTATION-PR1. プレゼン練習の 1 セッション（auth-scoped）。テーマ設定（志望校 / '
  '学部学科 / テーマ / 制限時間 / 原稿）と課金単位を兼ねる。1 セッション = presentation quota を '
  '正確に 1 回消費。usage_recorded は二重課金防止フラグ（compare-and-set 対象）。pr0_design.md §4.2 / §8。';

COMMENT ON COLUMN presentation_sessions.user_id IS
  'auth.users(id). Owner key. RLS gate uses auth.uid() = user_id.';

COMMENT ON COLUMN presentation_sessions.status IS
  'CHECK in (in_progress, completed, abandoned)。in_progress は user ごと 1 件まで '
  '（§64 の部分 unique index で強制）。pr0_design.md §4.2。';

COMMENT ON COLUMN presentation_sessions.usage_recorded IS
  '二重課金防止フラグ。初回 AI 評価成功時に compare-and-set（UPDATE ... WHERE usage_recorded=false '
  'RETURNING id）で行が返ったプロセスだけが recordUsage を呼ぶ。録り直しは session 単位のため '
  '追加消費しない。pr0_design.md §8。';

COMMENT ON COLUMN presentation_sessions.time_limit_sec IS
  '制限時間（秒）。AI 評価の timeManagement 軸で attempts.duration_sec との差を判定する入力。';

COMMENT ON COLUMN presentation_sessions.admission_type IS
  '大学選択画面の任意項目（学科名 / 入試方式 / プレゼン形式 / 想定制限時間 / 備考）の一つ。'
  '手入力・NULL 許容。AI 評価プロンプトの想定大学・入試方式の文脈に使う。'
  '後追い列追加は supabase/presentation_university_migration.sql。';

COMMENT ON COLUMN presentation_sessions.material_path IS
  '発表資料の Storage オブジェクトキー（presentation-materials）。形式 userId/sessionId/material.ext。'
  'サーバが (userId, sessionId, ext) から正準生成する。未アップロードなら NULL。'
  '後追い列追加は supabase/presentation_materials_migration.sql。';

COMMENT ON COLUMN presentation_sessions.material_deleted_at IS
  '発表資料（presentation-materials の material_path）を TTL（90 日）で削除した時刻。NULL=未削除。'
  'material_path 自体は残し、履歴では「資料保存期限切れ」と表示する。'
  '削除処理は app/api/cron/presentation-cleanup（service_role / CRON_SECRET）。'
  '後追い列追加は supabase/presentation_ttl_migration.sql。';


-- 64. trigger + in_progress 部分 unique index（interview_ai_sessions §57 と同形）
--     部分 unique index: status='in_progress' の行を user_id ごと 1 件に制限する。
--       同時多重セッションを封じ、deferred recordUsage（評価成功までの窓）の quota 回避を防ぐ。
--       completed / abandoned には制約がかからない。pr0_design.md §4.2。
CREATE TRIGGER presentation_sessions_set_updated_at
  BEFORE UPDATE ON presentation_sessions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX presentation_sessions_one_in_progress
  ON presentation_sessions (user_id)
  WHERE status = 'in_progress';

CREATE INDEX presentation_sessions_user_created_idx
  ON presentation_sessions (user_id, created_at DESC);


-- 65. RLS — presentation_sessions
--     owner 直接判定（auth.uid()=user_id）。SELECT/INSERT/UPDATE のみ付与する。
--     DELETE policy は **付与しない**: セッション削除は子 attempt の Storage オブジェクト削除
--     （storage.remove）を伴うため、サーバルート（service_role / RLS バイパス）専用とする
--     （要対応B / 孤児動画防止）。課金計上（usage_recorded の compare-and-set）も service_role。
ALTER TABLE presentation_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "presentation_sessions owner select"
  ON presentation_sessions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "presentation_sessions owner insert"
  ON presentation_sessions
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "presentation_sessions owner update"
  ON presentation_sessions
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- 66. presentation_attempts
--     1 録画 = 1 動画（Storage）+ 1 文字起こし。録り直しで session ごとに複数行になる。
--     attempt_id は Storage パス確定のためクライアントが crypto.randomUUID() で先に採番し、
--     サーバ route がその id を明示指定して INSERT する想定（DEFAULT は fallback）。
--     storage_path はサーバが (userId, sessionId, attemptId, ext) から **正準生成** する
--     （クライアント送信値を信用しない / 要対応A / pr0_design.md §5.2）。
--     録り直し上限（最大 3）は DB では UNIQUE(session_id, attempt_index) までで、
--     attempt_index>3 の拒否（409）はサーバ route が count して強制する（要対応・pr0_design.md §6）。
CREATE TABLE presentation_attempts (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid         NOT NULL REFERENCES public.presentation_sessions(id) ON DELETE CASCADE,
  user_id        uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempt_index  integer      NOT NULL DEFAULT 1,
  storage_path   text         NOT NULL DEFAULT '',
  transcript     text         NOT NULL DEFAULT '',
  duration_sec   integer      NOT NULL DEFAULT 0,
  status         text         NOT NULL DEFAULT 'uploaded',
  -- 録画動画の TTL 自動削除（90 日）。Storage 上の動画を消した時刻。NULL=未削除（後方互換）。
  --   transcript は残すため、status は 'evaluated' のまま。後追いは
  --   supabase/presentation_ttl_migration.sql（ADD COLUMN IF NOT EXISTS）。
  video_deleted_at timestamptz,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  metadata       jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT presentation_attempts_status_check
    CHECK (status IN ('uploaded', 'transcribed', 'evaluated', 'failed')),
  CONSTRAINT presentation_attempts_session_index_unique UNIQUE (session_id, attempt_index)
);

COMMENT ON TABLE presentation_attempts IS
  'STEP-PRESENTATION-PR1. プレゼンの 1 録画 = 1 動画 + 1 文字起こし（auth-scoped）。'
  '録り直しで session ごとに複数行。動画は Storage（presentation-recordings）に保存し、'
  '本テーブルには storage_path（参照）と transcript（文字起こし）のみ持つ。pr0_design.md §4.3。';

COMMENT ON COLUMN presentation_attempts.user_id IS
  'auth.users(id). owner key を複製（JOIN なし参照用）。RLS（§68）は auth.uid()=user_id の '
  'SELECT のみ。書込は service_role。';

COMMENT ON COLUMN presentation_attempts.attempt_index IS
  '同一 session 内の録り直し番号（1 始まり）。最大 3。DB は UNIQUE(session_id, attempt_index) '
  'までを保証し、4 本目以降（attempt_index>3）の 409 拒否はサーバ route が count で強制する。';

COMMENT ON COLUMN presentation_attempts.storage_path IS
  'Storage オブジェクトキー。形式 user_id/session_id/attempt_id.ext。サーバが (userId, '
  'sessionId, attemptId, ext) から正準生成して保存する。クライアント送信値はそのまま保存しない '
  '（要対応A / pr0_design.md §5.2）。';

COMMENT ON COLUMN presentation_attempts.transcript IS
  '文字起こしテキストのみ。音声ファイルは保存しない（音声は録画直後にクライアントが '
  'multipart で transcribe に送り、Whisper で文字起こし。サーバ ffmpeg 不採用 / pr0_design.md §11）。';

COMMENT ON COLUMN presentation_attempts.duration_sec IS
  '実測発表時間（秒）。AI 評価の timeManagement 軸で session.time_limit_sec との差を判定する入力。';

COMMENT ON COLUMN presentation_attempts.status IS
  'CHECK in (uploaded, transcribed, evaluated, failed)。uploaded(動画保存済) → transcribed(STT済) '
  '→ evaluated(評価済) / failed。pr0_design.md §4.3。';

COMMENT ON COLUMN presentation_attempts.metadata IS
  '動画ファイルの付帯情報（video_mime_type / video_size_bytes 等）を attempt route が記録する。'
  'DB は shape を強制しない（sessions / practice_records の metadata と同方針）。'
  '本番への後追いは supabase/presentation_attempts_metadata_migration.sql（ADD COLUMN IF NOT EXISTS）。';

COMMENT ON COLUMN presentation_attempts.video_deleted_at IS
  '録画動画（presentation-recordings の storage_path）を TTL（90 日）で削除した時刻。NULL=未削除。'
  '非 NULL なら result 画面は「録画動画の保存期間が終了しました」を表示し signed URL を発行しない。'
  'transcript / AI 評価は削除しない（status は evaluated のまま / 履歴・成長可視化は継続）。'
  '削除処理は app/api/cron/presentation-cleanup（service_role / CRON_SECRET）。'
  '後追い列追加は supabase/presentation_ttl_migration.sql。';


-- 67. trigger（set_updated_at / §3 共有）
CREATE TRIGGER presentation_attempts_set_updated_at
  BEFORE UPDATE ON presentation_attempts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 68. RLS — presentation_attempts（owner SELECT のみ / 書込は service_role）
--     user_id を非正規化で持つため SELECT は auth.uid()=user_id で直接判定する
--     （履歴のクライアント直読み経路）。INSERT/UPDATE/DELETE policy は付与しない＝
--     authenticated からの書込を DB レベルで禁じ、サーバルート（service_role）に限定する。
ALTER TABLE presentation_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "presentation_attempts owner select"
  ON presentation_attempts
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);


-- 69. presentation_results
--     attempt への AI カテゴリ評価（1:1）。feedback は PresentationFeedback を jsonb 丸ごと、
--     categories は {composition:'strong',...} の投影（履歴一覧の高速表示用）。
--     1 attempt 1 結果（UNIQUE(attempt_id)）で評価の二重 INSERT を弾く。再評価は新 attempt。
--     セッション代表 result は「attempt_index 最大の evaluated attempt」とする（pr0_design.md §4.4）。
CREATE TABLE presentation_results (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id  uuid         NOT NULL REFERENCES public.presentation_attempts(id) ON DELETE CASCADE,
  user_id     uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feedback    jsonb        NOT NULL,
  categories  jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT presentation_results_attempt_unique UNIQUE (attempt_id)
);

COMMENT ON TABLE presentation_results IS
  'STEP-PRESENTATION-PR1. プレゼン attempt の AI カテゴリ評価（auth-scoped / 1:1）。'
  'feedback = PresentationFeedback（jsonb / categories は weak|normal|strong の 6 軸）。'
  '数値評価はしない。1 attempt 1 結果（UNIQUE(attempt_id)）。pr0_design.md §4.4 / §10.2。';

COMMENT ON COLUMN presentation_results.user_id IS
  'auth.users(id). owner key を複製。RLS（§70）は auth.uid()=user_id の SELECT のみ。書込は service_role。';

COMMENT ON COLUMN presentation_results.categories IS
  'feedback.categories の投影（{composition, persuasion, concreteness, clarity, timeManagement, '
  'completeness} ∈ weak|normal|strong）。履歴一覧で feedback 全文を読まずに表示するための非正規化。';


-- 70. RLS — presentation_results（owner SELECT のみ / 書込は service_role）
ALTER TABLE presentation_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "presentation_results owner select"
  ON presentation_results
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);


-- 71. presentation_qa_turns（interview_ai_turns §61 と同型）
--     発表後 AI 質問の 1 ターン（質問 or 回答）の transcript。音声は保存しない。
--     代表 attempt（評価済み）に紐づく。turn_index は attempt 内 0 始まり連番
--     （0=AI 質問, 1=回答, 2=深掘り, ...）。pr0_design.md §4.5。
CREATE TABLE presentation_qa_turns (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id  uuid         NOT NULL REFERENCES public.presentation_attempts(id) ON DELETE CASCADE,
  user_id     uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  turn_index  integer      NOT NULL,
  role        text         NOT NULL,
  source      text         NOT NULL,
  content     text         NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT presentation_qa_turns_role_check
    CHECK (role IN ('question', 'answer')),
  CONSTRAINT presentation_qa_turns_source_check
    CHECK (source IN ('voice', 'text')),
  CONSTRAINT presentation_qa_turns_attempt_index_unique UNIQUE (attempt_id, turn_index)
);

COMMENT ON TABLE presentation_qa_turns IS
  'STEP-PRESENTATION-PR1. 発表後 AI 質問の 1 ターンの transcript（auth-scoped）。音声は保存しない '
  '（content は transcript のみ）。role=question/answer。turn_index は attempt 内 0 始まり連番。'
  '面接 AI の interview_ai_turns と同型・ターン制 Q&A ロジックを流用。pr0_design.md §4.5 / §10。';

COMMENT ON COLUMN presentation_qa_turns.user_id IS
  'auth.users(id). owner key を複製。RLS（§72）は auth.uid()=user_id の SELECT のみ。書込は service_role。';

COMMENT ON COLUMN presentation_qa_turns.role IS
  'CHECK in (question, answer)。question=AI 生成の深掘り質問 / answer=受験生の回答。';

COMMENT ON COLUMN presentation_qa_turns.source IS
  'CHECK in (voice, text)。content の入力モダリティ。question は常に text、answer は voice(STT)/text(直接)。';


-- 72. RLS — presentation_qa_turns（owner SELECT のみ / 書込は service_role）
ALTER TABLE presentation_qa_turns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "presentation_qa_turns owner select"
  ON presentation_qa_turns
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);


-- 72b. presentation_qa_reviews（result 画面の stateless Q&A の永続化）
--     1 行 = 1 Q&A 交換（質問 + 回答 + AI レビュー review(jsonb)）。学習資産化が目的。
--     §71 presentation_qa_turns（1 行 = 1 ターンの transcript）とは行モデルが異なるため
--     別テーブルにする（既存ターン制フローを壊さない）。書込は service_role（qa route の
--     review 成功時）。usage/quota 非影響。後追いは supabase/presentation_qa_reviews_migration.sql。
CREATE TABLE presentation_qa_reviews (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id  uuid         NOT NULL REFERENCES public.presentation_attempts(id) ON DELETE CASCADE,
  user_id     uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  turn_index  integer      NOT NULL,
  question    text         NOT NULL,
  answer_text text         NOT NULL,
  review      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT presentation_qa_reviews_attempt_index_unique UNIQUE (attempt_id, turn_index)
);

COMMENT ON TABLE presentation_qa_reviews IS
  '発表後 Q&A（result 画面の stateless generate/review）の永続化。1 行 = 1 交換（質問 + 回答 + '
  'AI レビュー review(jsonb)）。書込は service_role。閲覧は RLS owner SELECT。usage/quota 非影響。';

COMMENT ON COLUMN presentation_qa_reviews.user_id IS
  'auth.users(id). owner key を複製（RLS は auth.uid()=user_id の SELECT のみ。書込は service_role）。';

COMMENT ON COLUMN presentation_qa_reviews.review IS
  'AI レビューの jsonb スナップショット（goodPoints / improvements / modelAnswerDirection）。'
  'AI 評価ロジックは変更しない（保存のみ追加）。';

CREATE INDEX presentation_qa_reviews_user_idx
  ON presentation_qa_reviews (user_id);

CREATE INDEX presentation_qa_reviews_attempt_created_idx
  ON presentation_qa_reviews (attempt_id, created_at DESC);

ALTER TABLE presentation_qa_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "presentation_qa_reviews owner select"
  ON presentation_qa_reviews
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);


-- 73. presentation_practice_records（対人プレゼン記録 / interview_practice_records §53 と同思想）
--     友達・先生・親との対人プレゼンを手動記録する。AI 不使用・課金なし・録画なし。
--     localStorage canonical の auth-scoped durable mirror。natural key = (user_id, local_record_id)。
--     local_record_id はクライアント側 id（crypto.randomUUID() 由来）をそのまま使う。
--     評価項目は全て自由記述（数値化しない）。pr0_design.md §4.6。
CREATE TABLE presentation_practice_records (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_record_id text         NOT NULL,
  practice_date   text         NOT NULL DEFAULT '',
  university_name text         NOT NULL DEFAULT '',
  faculty_name    text         NOT NULL DEFAULT '',
  theme           text         NOT NULL DEFAULT '',
  time_limit_sec  integer      NOT NULL DEFAULT 0,
  partner         text         NOT NULL DEFAULT '',
  composition     text         NOT NULL DEFAULT '',
  persuasion      text         NOT NULL DEFAULT '',
  concreteness    text         NOT NULL DEFAULT '',
  delivery        text         NOT NULL DEFAULT '',
  qa_note         text         NOT NULL DEFAULT '',
  good_points     text         NOT NULL DEFAULT '',
  improvements    text         NOT NULL DEFAULT '',
  next_task       text         NOT NULL DEFAULT '',
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT presentation_practice_records_local_unique UNIQUE (user_id, local_record_id)
);

COMMENT ON TABLE presentation_practice_records IS
  'STEP-PRESENTATION-PR1. 対人プレゼン記録（友達・先生・親）の auth-scoped durable mirror。'
  'AI 不使用・課金なし・録画なし。natural key = (user_id, local_record_id)。'
  'interview_practice_records §53 と同思想（localStorage canonical + upsert mirror）。pr0_design.md §4.6。';

COMMENT ON COLUMN presentation_practice_records.local_record_id IS
  'クライアント側 id（crypto.randomUUID() 由来）をそのまま入れる。natural key の一部で '
  'onConflict 指定 upsert の対象。';

COMMENT ON COLUMN presentation_practice_records.partner IS
  '対人相手（友達 / 先生 / 親 など）。自由記述。';

COMMENT ON CONSTRAINT presentation_practice_records_local_unique ON presentation_practice_records IS
  'UNIQUE(user_id, local_record_id)。upsert を冪等化するための制約。';


-- 74. trigger（set_updated_at / §3 共有）
CREATE TRIGGER presentation_practice_records_set_updated_at
  BEFORE UPDATE ON presentation_practice_records
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();


-- 75. RLS — presentation_practice_records（owner 直接判定 / 全 CRUD）
--     Storage 非関与のため、interview_practice_records §55 と同形で owner に全 CRUD を許可する
--     （upsert の DO UPDATE 経路のため UPDATE policy も必要 / delete を伴う feature）。
ALTER TABLE presentation_practice_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "presentation_practice_records owner select"
  ON presentation_practice_records
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "presentation_practice_records owner insert"
  ON presentation_practice_records
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "presentation_practice_records owner update"
  ON presentation_practice_records
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "presentation_practice_records owner delete"
  ON presentation_practice_records
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- 76. Storage bucket: presentation-recordings（private）
--     プロジェクト初の Storage 利用。public=false（signed URL のみで再生 / pr0_design.md §5）。
--     オブジェクトキー形式: user_id/session_id/attempt_id.ext（第1階層 user_id が RLS の所有判定キー）。
--     冪等のため ON CONFLICT DO NOTHING（既存環境への再適用を許容）。
INSERT INTO storage.buckets (id, name, public)
VALUES ('presentation-recordings', 'presentation-recordings', false)
ON CONFLICT (id) DO NOTHING;


-- 77. Storage RLS — storage.objects（presentation-recordings 本人のみ）
--     storage.objects は Supabase が既定で RLS 有効。本 bucket に対する policy のみ追加する。
--     path 第1階層（storage.foldername(name)[1]）が auth.uid() と一致する本人だけが対象。
--     SELECT（signed URL 発行に必要）と INSERT（クライアント直 upload）のみ authenticated に許可。
--     UPDATE/DELETE policy は付与しない: 動画削除は DB 行削除と整合させるためサーバルート
--     （service_role / RLS バイパス）で storage.remove する（要対応B / 孤児動画防止 / pr0_design.md §5.4）。
--     録り直しは新 attempt_id = 新パス（upsert:false）のため、クライアントの UPDATE は不要。
CREATE POLICY "presentation-recordings owner select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'presentation-recordings'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "presentation-recordings owner insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'presentation-recordings'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );


-- 78. Storage bucket: presentation-materials（private）
--     発表資料（PDF / PNG / JPG / JPEG）の保存先。public=false（signed URL のみで閲覧）。
--     オブジェクトキー: user_id/session_id/material.ext（1 セッション 1 資料 / upsert で上書き）。
INSERT INTO storage.buckets (id, name, public)
VALUES ('presentation-materials', 'presentation-materials', false)
ON CONFLICT (id) DO NOTHING;


-- 79. Storage RLS — storage.objects（presentation-materials 本人のみ）
--     path 第1階層が auth.uid() の本人だけが対象。SELECT（signed URL 発行 / 表示）・
--     INSERT・UPDATE（upsert:true の上書き）を authenticated に許可。DELETE policy は付与せず、
--     資料削除はサーバルート（service_role）で DB と整合させて行う（孤児ファイル防止）。
CREATE POLICY "presentation-materials owner select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'presentation-materials'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "presentation-materials owner insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'presentation-materials'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "presentation-materials owner update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'presentation-materials'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'presentation-materials'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );


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

-- ============================================================
-- 81–91. career_* feature mirrors（STEP-CAREER-SUPABASE-01）
--
--   就活版（PASSAI CAREER）の既存機能を localStorage canonical のまま、ログイン済み
--   （member）ユーザーの durable mirror として Supabase に永続化する table 群。
--   career_values §80 / self_prs §35 / interview_practice_records §53 と同じ auth-scoped
--   永続層（mirror_events 系統ではない）。受験版データには一切関与しない。
--
--   単一レコード系（profiles / activities）は UNIQUE(user_id) で 1 ユーザー 1 行・upsert。
--   履歴系は natural key UNIQUE(user_id, client_id)（client_id=localStorage のレコード id）で
--   再保存・login 時 backfill を冪等にする。AI 出力は jsonb（schema_boundary_policy §10）。
--   検索/状態だけ通常カラムに昇格する。
--
--   trigger（set_updated_at / §3 共有）と RLS（owner 4 policy / authenticated）は本節末尾の
--   DO ブロックでまとめて張る（career_values §81 と同形）。
--   idempotent apply の正写しは supabase/career_features_apply.sql。
-- ============================================================

-- 81. career_profiles — 基本情報/プロフィール（/career/profile）。LS key=careerBasicFormData。
CREATE TABLE career_profiles (
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

-- 82. career_activities — 活動整理/ガクチカ素材（/career/activity）。LS key=careerActivityData。
CREATE TABLE career_activities (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_activities_user_unique UNIQUE (user_id)
);

-- 83. career_self_analysis_results — 自己分析の結果履歴。LS key=careerSelfAnalysisLogs。
CREATE TABLE career_self_analysis_results (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   text        NOT NULL,
  user_input  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_self_analysis_results_natural_key UNIQUE (user_id, client_id)
);
CREATE INDEX career_self_analysis_results_user_created_idx
  ON career_self_analysis_results (user_id, created_at DESC);

-- 84. career_self_prs — 自己 PR カード。LS key=careerSelfPRs（共有型 SelfPR）。受験版 self_prs §35 と別。
CREATE TABLE career_self_prs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   text        NOT NULL,
  data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_self_prs_natural_key UNIQUE (user_id, client_id)
);
CREATE INDEX career_self_prs_user_created_idx
  ON career_self_prs (user_id, created_at DESC);

-- 85. career_matching_results — 企業マッチング結果履歴。LS key=careerMatchingResults。
CREATE TABLE career_matching_results (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   text        NOT NULL,
  user_input  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_matching_results_natural_key UNIQUE (user_id, client_id)
);
CREATE INDEX career_matching_results_user_created_idx
  ON career_matching_results (user_id, created_at DESC);

-- 86. career_es_logs — ES 生成/添削ログ。LS key=careerEsLogs。favorite/submitted を昇格。
CREATE TABLE career_es_logs (
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
CREATE INDEX career_es_logs_user_created_idx
  ON career_es_logs (user_id, created_at DESC);

-- 87. career_interview_sessions — 面接セッション（進行中 upsert）。LS key=careerInterviewSessions。
CREATE TABLE career_interview_sessions (
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
CREATE INDEX career_interview_sessions_user_updated_idx
  ON career_interview_sessions (user_id, updated_at DESC);

-- 88. career_interview_results — 面接の最終評価履歴。LS key=careerInterviewResults。
CREATE TABLE career_interview_results (
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
CREATE INDEX career_interview_results_user_created_idx
  ON career_interview_results (user_id, created_at DESC);

-- 89. career_presentation_sessions — プレゼンセッション（upsert）。LS key=careerPresentationSessions。
--     受験版 presentation_sessions §63 と別（録画/Storage/課金は未移植）。
CREATE TABLE career_presentation_sessions (
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
CREATE INDEX career_presentation_sessions_user_updated_idx
  ON career_presentation_sessions (user_id, updated_at DESC);

-- 90. career_presentation_results — プレゼン評価履歴。LS key=careerPresentationResults。
CREATE TABLE career_presentation_results (
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
CREATE INDEX career_presentation_results_user_created_idx
  ON career_presentation_results (user_id, created_at DESC);

-- 91. career_consultation_threads — 就活相談 AI のスレッド（upsert）。LS key=careerConsultationLogs。
CREATE TABLE career_consultation_threads (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   text        NOT NULL,
  title       text        NOT NULL DEFAULT '',
  messages    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_consultation_threads_natural_key UNIQUE (user_id, client_id)
);
CREATE INDEX career_consultation_threads_user_updated_idx
  ON career_consultation_threads (user_id, updated_at DESC);

-- 81–91 共通: updated_at trigger（set_updated_at / §3）を全 career_* feature table に張る。
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'career_profiles','career_activities','career_self_analysis_results','career_self_prs',
    'career_matching_results','career_es_logs','career_interview_sessions','career_interview_results',
    'career_presentation_sessions','career_presentation_results','career_consultation_threads'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = t || '_set_updated_at' AND tgrelid = ('public.' || t)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        t || '_set_updated_at', t
      );
    END IF;
  END LOOP;
END $$;

-- 81–91 共通: RLS（owner 直接判定 / 全 CRUD / authenticated）。career_values §81 と同形。
--   public / anon から直接全件読み書きできる policy は作らない。
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'career_profiles','career_activities','career_self_analysis_results','career_self_prs',
    'career_matching_results','career_es_logs','career_interview_sessions','career_interview_results',
    'career_presentation_sessions','career_presentation_results','career_consultation_threads'
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

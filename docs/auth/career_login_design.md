# PASSAI CAREER ログイン設計メモ

就活版（`/career` 配下）のログイン機能の設計・実装方針。受験版のログイン設計
（`app/components/AuthProvider.tsx` / `lib/supabase/*` / `app/login` / `supabase/schema.sql`
§16–18 profiles）を手本にしつつ、**データ・テーブル・env・導線を分離**して実装する。

## 原則

- 認証の正IDは Supabase Auth の `auth.users.id`（= `auth.uid()`）。**owner 判定は必ず `auth.uid()`**。
- `display_user_id` は**表示用ID**でありログインIDではない。RLS / FK / 認証に使わない。
- 通常のユーザーデータ保存に **service_role を使わない**（RLS 配下の user-scoped client で書く）。
- service_role は server-only（`import 'server-only'` + browser runtime guard、`NEXT_PUBLIC_` 禁止）。
- URL / anon key / service_role key の実値は**絶対にログ出力しない**。
- 未ログイン時は **localStorage canonical** で既存通り全機能動作。member のみ Supabase mirror。
- 受験版の `lib/supabase/*` / `app/login` / `app/account` / `app/auth/callback` / `AuthProvider` /
  `PlanGate` / `profiles` / 課金テーブル / env 名には**一切触れない**。

## 認証方式

- Supabase Auth の **email OTP**。
  - 送信: `signInWithOtp({ email, options: { shouldCreateUser: true } })`。
  - 検証: `verifyOtp({ email, token, type: 'email' })`。
  - 匿名認証は発行しない。残存 anonymous session は破棄して guest 扱い。
- verify 成功後は `window.location.assign()` で**フル遷移**し、`CareerAuthProvider` を再マウントして
  新セッションを読み直す（router.push だけだと Provider state が古いまま残るため）。
- マジックリンク（`/career/auth/callback`）は MVP では未実装。使うならメールテンプレに
  `{{ .Token }}`（コード）を含める運用にするか、career 専用 callback を別途用意する
  （受験版 `/auth/callback` には相乗りしない）。

## ファイル構成

```
lib/careerSupabase/
  env.ts                ← CAREER 専用 env。本番 shared fallback 禁止（下記）
  browserClient.ts      ← createBrowserClient（env 未設定で null）
  serverClient.ts       ← createServerClient（per-request, cookie 束縛）
  serviceRoleClient.ts  ← server-only, admin。ログイン/保存経路では未使用
  auth.ts               ← resolve/sendOtp/verifyOtp/signOut
  account.ts            ← ensureCareerAccount / loadCareerAccount / saveCareerDisplayUserId
app/career/
  components/CareerAuthProvider.tsx    ← status/user/account/refresh/signOut
  components/CareerLoginStatusCard.tsx ← guest/member のログイン状態 UI
  login/page.tsx                       ← email→OTP
  onboarding/profile/page.tsx          ← display_user_id 初回設定
  layout.tsx                           ← CareerAuthProvider で children を包む
supabase/career_accounts_apply.sql     ← identity テーブル DDL + RLS
```

## env fallback 仕様

CAREER 専用 env（`NEXT_PUBLIC_CAREER_SUPABASE_URL` / `NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY` /
`CAREER_SUPABASE_SERVICE_ROLE_KEY`）を読む。

- **development / test**（`NODE_ENV !== 'production'`）: CAREER 専用が未設定なら shared
  （`NEXT_PUBLIC_SUPABASE_*` / `SUPABASE_SERVICE_ROLE_KEY`）へ **read-only・一方向**で fallback 可。
- **production**: fallback 一切禁止。CAREER 専用未設定なら `null` を返し career client を無効化
  （auth 無効 / mirror no-op）。受験版 / shared プロジェクトへは**絶対に接続しない**。
- いずれも throw しない（build を落とさない）。

## DB / RLS 設計（`career_accounts`）

```sql
id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
display_user_id  text UNIQUE            -- nullable。login 時 null で行作成、onboarding で設定
email            text                   -- 表示・復帰補助。ログイン識別に使わない
created_at / updated_at
```

RLS: `ENABLE ROW LEVEL SECURITY` + **owner-only**（select / insert / update / delete すべて
`auth.uid() = id`）。

- **`SELECT USING (true)` は使わない**。受験版 profiles は email カラムが無いため全読み許可でも
  安全だが、`career_accounts` は **email（PII）を持つ**ため owner-only を死守する。
- そのため他ユーザーの `display_user_id` は SELECT できず、重複の live 事前チェックはできない。
  重複判定は **UNIQUE 制約 → 23505 → `duplicate`** に翻訳（`saveCareerDisplayUserId`）。
  将来 live チェックが必要なら、行を露出しない `SECURITY DEFINER` 関数
  `career_display_id_available(text) returns boolean` を追加する（email を漏らさない）。
- 既存の `career_profiles`（`supabase/career_features_apply.sql`）は基本情報 mirror（key=user_id）で
  **責務が別**。identity と混ぜない。

## ログイン導線

- `/career/home` / 各練習機能: **guest 可**（localStorage のみ）。
- `/career/login`: email→OTP。`?redirect=` は**同一オリジン相対パスのみ**（open-redirect 防止）。
  verify 成功後、`display_user_id` 未設定→onboarding、設定済→redirect or `/career/home`。
- `/career/onboarding/profile`: 初回のみ display_user_id 設定（DB は nullable、UX は初回必須）。
  設定済 member は redirect / `/career/home` へ、guest は `/career/login` へ。
- `/career/mypage`: guest 可。guest には「ログインでクラウド保存・履歴復元」導線、member には
  display_user_id / email / logout、member かつ display 未設定なら設定導線。
- 2 回目以降: `resolveCareerSession()` が残存 session を読み自動 member。
- logout: `signOut()` → guest に戻る。

## ログイン必須範囲（MVP）

全ページ必須にはしない。middleware で全体保護しない。ログインは
**クラウド保存・別端末同期・履歴復元・GD マルチ・将来課金**の土台として扱う。
将来の課金ゲートは受験版 `PlanGate` に触れず `CareerPlanGate` 等の別実装にする。

## ⚠️ split-brain リスクと物理分離の前提（TODO）

現状、既存の career 機能 mirror（`lib/supabase/career*.ts`）と GD の `roomAuth`
（`app/api/career/gd/room/roomAuth.ts`）は **shared client**（`lib/supabase/*`）を使い、
shared の `auth.uid()` で書いている。一方 identity（`career_accounts`）は career client
（`lib/careerSupabase/*`）を使う。

- **CAREER_* env を shared と同一 Supabase プロジェクトに向けている間は `auth.uid()` が一致**し安全。
- **CAREER_* を別プロジェクトに向けた瞬間、`auth.uid()` 空間が分裂**し、identity は career
  プロジェクト・mirror は shared プロジェクトに書かれてデータが割れる（split-brain）。

→ **物理的に別 Supabase プロジェクトへ分離するのは、`lib/supabase/career*.ts` と `roomAuth` を
career client へ移管した後**にする。本ログイン PR ではその移管は**行わない**。MVP は CAREER_* を
shared と同一物理プロジェクトへ向ける（または分離をまだ行わない）前提で進める。

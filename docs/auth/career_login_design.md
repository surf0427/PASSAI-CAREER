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

- **全環境で fallback 禁止**（Project B 完全分離以降）。旧「development / test に限り受験版 env へ
  fallback してよい」という DX 用の緩和は **削除済み**。
  - 理由: fallback があると CAREER env の設定漏れが受験版 Supabase への接続で「動いているように
    見えて」しまい、identity は Project B・data は Project A という split-brain をローカルで
    再現させてしまう。設定漏れは設定漏れとして落ちるのが正しい。
- CAREER 専用未設定なら `null` を返し career client を無効化（auth 無効 / mirror no-op）。
  受験版 / Project A へは**絶対に接続しない**。
- throw しない（build を落とさない）。
- この不変条件は `scripts/career-supabase-project-boundary-qa.ts` と
  `scripts/career-supabase-env-inline-qa.ts` が静的に固定する。

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

## ✅ split-brain 解消と Project B 完全分離（完了）

かつて career 機能 mirror（`lib/supabase/career*.ts`）と GD の `roomAuth` は **受験版 client**
（`lib/supabase/*`）を使い、受験版の `auth.uid()` で書いていた。一方 identity（`career_accounts`）は
career client（`lib/careerSupabase/*`）を使っていたため、CAREER_* を別プロジェクトへ向けた瞬間に
`auth.uid()` 空間が分裂する split-brain リスクがあった。

**現在は career runtime 全体が Project B に統一されており、このリスクは解消済み。**

| 層 | 使用する client | プロジェクト |
|---|---|---|
| identity（`CareerAuthProvider`） | `lib/careerSupabase/browserClient` | B |
| browser mirror（`lib/supabase/career*.ts` / `careerEvents` / `careerGd` / `careerSourceData`） | `lib/careerSupabase/browserClient` | B |
| server read（`serverReader` / `personalMemoryReadServer` / GD `roomAuth` / self-analysis） | `lib/careerSupabase/serverClient` | B |
| service role（GD room / cron gd-cleanup / Data Spine privileged port / Company Identity） | `lib/careerSupabase/serviceRoleClient` | B |
| join code pepper | `CAREER_GD_JOIN_CODE_PEPPER` ?? CAREER service-role key | B |

career 配下の identity hook は `@/app/career/components/CareerAuthProvider` から取る
（受験版互換 alias `useCurrentUserId` / `useAuthStatus` / `useIsMember` を提供）。

この不変条件は `scripts/career-supabase-project-boundary-qa.ts` が静的に固定する
（Project A の client / auth / env module を career runtime が import したら CI で落ちる）。

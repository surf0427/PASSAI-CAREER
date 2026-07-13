# Personal Memory `base` Runtime Write Canary Runbook（P16-F-1 / non-production only）

## 位置づけ

L2 Personal Memory の `base` section を、実機入力済みの **profile / activity / values** から
runtime write（shadow write）で実際に 1 row 立て、owner-scoped に確認するための **non-production 専用**
実行手順書。P16-F の read-only 監査（judgment: **CONDITIONAL GO**）を受けて、環境が確認され次第
安全・再現可能に実施できるよう手順を固定する。

- 対象コード（本 runbook はこれらの挙動を記述する。**変更しない**）:
  - flag: [lib/careerMemory/persistence/shadowWriteFlag.ts](../../lib/careerMemory/persistence/shadowWriteFlag.ts)
  - app wiring: [app/career/personalMemoryShadowWrite.ts](../../app/career/personalMemoryShadowWrite.ts)
  - coordinator: [lib/careerMemory/persistence/productionShadowWriter.ts](../../lib/careerMemory/persistence/productionShadowWriter.ts)
  - writer: [lib/careerMemory/persistence/shadowWriter.ts](../../lib/careerMemory/persistence/shadowWriter.ts)
  - repository: [lib/careerMemory/persistence/repository.ts](../../lib/careerMemory/persistence/repository.ts)
  - state / validate / rebuild: `state.ts` / `validate.ts` / `rebuild.ts`
  - DDL: [supabase/career_personal_memory_apply.sql](../../supabase/career_personal_memory_apply.sql)
  - callsite: profile [ProfileClient.tsx](../../app/career/profile/ProfileClient.tsx) / activity [activity/page.tsx](../../app/career/activity/page.tsx) / values [values/page.tsx](../../app/career/values/page.tsx)

## 絶対原則（この runbook 全体の前提）

- **Production を代替環境として使用しない。** production deployment / production CAREER Supabase では
  実施しない。non-production の実在が確認できなければ runtime write は **HOLD**（runbook 完成のみが成果）。
- **shadow-write flag は deployment 単位のグローバル boolean**。user 単位・section 単位の canary 制限は
  **存在しない**。flag ON の deployment にログイン中の任意 member が profile/activity/values を保存すると
  その member の row も write される。canary 中は担当者以外のアクセスを遮断できることが前提。
- **Interview 実機は base canary の前提ではない**（base は profile/activity/values のみで生成可能）。
  Interview runtime validation は本 canary と独立に HOLD のまま。
- **secret / URL / anon key / service role / token / 実 UUID / 実メール / payload 本文は文書・実行ログへ
  記録しない。** row 確認は authenticated owner session + RLS の範囲内でのみ行い、service role・RLS 回避・
  全 user row 取得・production 接続を用いない。
- 本 runbook 実施は SQL 適用・flag ON・deploy・実接続を伴う **運用作業**。ここに書かれた手順は
  「環境が確認された後に人間が実行する」ものであり、本 runbook 作成タスク自体はそれらを実行しない。

---

## Phase 0 — Execution Gate（1 つでも未達なら canary を開始しない）

- [ ] canary deployment が **Production ではない**
- [ ] deployment URL が **Preview または development 専用**である
- [ ] 接続先 CAREER Supabase が **Production ではない**
- [ ] 接続先 Supabase project の識別を運用者が確認済み（識別子は文書に**書かない**）
- [ ] `career_personal_memory` DDL の**適用先が確定**している（= その non-production project）
- [ ] flag を **Preview / development 専用 env** として設定できる
- [ ] **Production env には flag を設定しない**ことを確認
- [ ] canary 中に**他 member が保存操作を行わない**ことを保証できる（グローバル flag のため）
- [ ] **canary 担当者**が確定している
- [ ] **rollback 担当者**が確定している
- [ ] **owner session 内で row を確認する方法**が確定している（service role 非使用）
- [ ] **service role を使わない**
- [ ] **全ユーザー row を取得しない**
- [ ] **Interview 実機を前提にしていない**

> 上記いずれかが未達 → **canary を開始しない**。Phase 10 の `ENVIRONMENT NOT AVAILABLE` へ。

---

## Phase 1 — Baseline Capture（flag ON 前）

実値は文書へ固定記載せず、実行記録テンプレート（末尾）の記入欄／placeholder に控える。
**secret / URL / UUID / メールは記録しない。**

- [ ] deployment identifier（`<PREVIEW_DEPLOYMENT_ID>`）
- [ ] git commit（`<COMMIT_SHA>`。P16-E 以降を含むこと）
- [ ] branch（`<BRANCH>`）
- [ ] Personal Memory QA 5 本 PASS（Phase: QA、下記 §QA）
- [ ] shadow-write flag が**現在 OFF**（コード default = OFF。env 未設定を運用者が確認）
- [ ] 対象 owner に `base` row が**存在するか**（初回なら無し想定）
- [ ] profile / activity / values が**入力済み**か
- [ ] self_analysis / es / interview row の有無（base canary には不要・現状把握のみ）
- [ ] canary 前の row 状態（`<BASE_ROW_BEFORE = none | fresh(rev=…) >`）
- [ ] canary 前の Source Data 状態（profile/activity/values の有無のみ）

---

## Phase 2 — DDL Application Gate

- [ ] 適用先が **non-production project** であることを再確認（Phase 0 と二重確認）
- SQL ファイル: `supabase/career_personal_memory_apply.sql`
- [ ] SQL **全体をそのまま**適用する（**部分実行しない**・文言を書き換えない）
- [ ] 同一 project への**再適用はエラーになり得る**（DDL は `IF NOT EXISTS` 無し）。適用前に
      「その project に `career_personal_memory` が**未適用**であること」を確認する
- [ ] 既存 table を **DROP しない** / 既存 policy を独断で削除しない
- [ ] **service role 前提に変更しない** / **RLS を無効化しない**（SQL は RLS ENABLE + owner 4 policy を含む）
- 成功条件: `career_personal_memory` table・trigger `career_personal_memory_set_updated_at`・
  index `career_personal_memory_user_section_idx`・RLS 有効・owner SELECT/INSERT/UPDATE/DELETE の 4 policy が
  すべて作成された（`\d career_personal_memory` / Supabase Studio の Table + Policies で目視）。
- STOP 条件: 一部だけ作成された / 既存オブジェクトと衝突 / RLS が有効化されない / policy が 4 未満。
  → Phase 7 STOP → Phase 8 Rollback。

> 本 runbook 作成タスクでは SQL を**実行しない**。

DDL 静的事実（コードと一致・[career_personal_memory_apply.sql](../../supabase/career_personal_memory_apply.sql)）:
`PRIMARY KEY id uuid` / `UNIQUE(user_id, section_key)` / `user_id → auth.users(id) ON DELETE CASCADE` /
`section_key CHECK IN (base,self_analysis,es,interview)` / `schema_version CHECK > 0` /
`status CHECK IN (fresh,stale,failed)` / `payload jsonb CHECK jsonb_typeof='object'`（DEFAULT なし）/
size 上限は **アプリ層 32KB**（SQL に無し）/ anon・public policy 無し / service role 前提無し。**追加のみ・非破壊。**

---

## Phase 3 — Flag Enablement

対象 env 変数: `NEXT_PUBLIC_CAREER_PERSONAL_MEMORY_SHADOW_WRITE_ENABLED`

- [ ] **Preview / development 限定**で設定（**Production へは設定しない**）
- ON 値: **`true`** を標準（コードは `true` / `1` / `yes` を ON 判定・`trim` + 小文字化。それ以外は OFF）
- [ ] **build 時埋め込み**（`NEXT_PUBLIC_` prefix）。設定後に**再 build / 再 deploy が必要**
- [ ] これは **deployment 単位のグローバル flag**（特定 user 限定でも特定 section 限定でもない）
- [ ] flag ON 中に**他 member が保存すると write 対象**になる。canary 担当者以外のアクセスを可能な限り遮断
- [ ] アクセス遮断を保証できない → **STOP**
- [ ] 設定後の deployment が**本当に non-production か再確認**
- env の**値そのものは確認・出力しない**（設定有無と対象環境のみ確認）

---

## Phase 4 — Canary Execution（base row を発火させる）

Preview / development 環境で、以下を順に実施する。

1. OTP ログイン（member session を確立）
2. `/career/profile` を開く
3. 既存値を確認（画面表示のみ）
4. profile を **1 回保存**（送信）
5. `/career/home` への画面遷移が正常完了することを確認（保存・遷移は shadow write の成否に依存しない）
6. **Phase 5** の owner session row 確認で `base` row を確認（初回 = Case A）
7. 同じ profile を**再保存**（内容変更なし）
8. idempotency を確認（Case B: `source_revision` 不変・`updated_at` 不変）
9. profile の**非 PII 項目を 1 つだけ変更**（例: 志望業界の 1 項目。氏名/メール/電話は変更対象にしない）
10. 再保存
11. `source_revision` の変化を確認（Case C）
12. 必要に応じて `/career/activity` で保存を 1 回実施（Case D）
13. 必要に応じて `/career/values` で保存を 1 回実施（Case E）
14. 各保存後、`base` section **のみ**が更新され、他 section row が変わらないことを確認

### callsite 発火挙動（コードと一致・重要）

- **profile**（[ProfileClient.tsx](../../app/career/profile/ProfileClient.tsx)）: `saveBasicInfo` 直後・`router.push('/career/home')` の前に
  `void shadowWriteBaseMemory()` を**無条件呼び出し**（内部で flag/member gate）。fire-and-forget。
- **values**（[values/page.tsx](../../app/career/values/page.tsx)）: 保存 status='saved' 後、`if (currentUserId)` の時に `void shadowWriteBaseMemory()`。
- **activity**（[activity/page.tsx](../../app/career/activity/page.tsx)）: `activity` 変更時に canonical 保存し、member なら
  **1500ms の debounce**（`setTimeout(…, 1500)`）後に mirror + `void shadowWriteBaseMemory()` を発火する。
  - ⚠️ **注意（推測秒数を使わない）**: debounce の**確定値は現行コードで 1500ms**。activity 変更後に **1500ms 経過する前に画面を離脱（unmount）すると、unmount flush 経路は Supabase mirror を flush するが `shadowWriteBaseMemory()` を呼ばない**（unmount cleanup は `saveCareerActivityToSupabase` のみ）。
    → activity の base write を確認したい場合は、**保存後 1.5 秒以上その画面に留まってから** row 確認に進む。
- 共通: すべて `void` / never-throw。flag OFF なら `shadowWriteBaseMemory` 冒頭で即 return（localStorage load も
  coordinator 呼び出しも無し）。member 以外は coordinator が `guest` / `no-env` で write せず、browser client 未生成は `no_client`。

---

## Phase 5 — Row Observation Contract（owner-scoped session）

authenticated owner session（anon key + owner JWT）で、自分の row のみを確認する。
**service role / RLS 回避 / 全 row 取得 / production 接続を用いない。**

必須期待値:

- `section_key = 'base'`
- `schema_version = 1`
- `status = 'fresh'`
- `source_revision` が非空（`v1:content:` prefix）
- `payload` が JSON object
- `payload` に `profile` / `activity` / `values` が存在
- payload size < **32KB**
- PII 非混入 / forbidden key 非混入 / raw turns 非混入 / raw transcript 非混入
- 他 section row を変更しない
- 他 user row を取得できない（RLS）

PII / forbidden key 候補（この key が payload に**現れてはならない**。`validate.ts` の deep scan と一致）:
`name` / `email` / `phone` / `turns` / `transcript` / `prompt` / `eventSignals` / raw interview text。

### 確認用 SQL（parameterized template・authenticated owner session 前提）

> `:owner` は運用者自身の session UUID を bind（= `auth.uid()`）。**実 UUID / 実メールを文書へ書かない。**
> service role 非使用・RLS が他 user 行を遮断する前提。全 row 取得しない。

```sql
-- (1) base row の contract 確認（自分の行のみ RLS で返る）
select section_key, schema_version, status, source_revision,
       source_updated_at, generated_at,
       jsonb_typeof(payload)                     as payload_type,
       pg_column_size(payload)                   as payload_bytes,
       (payload ? 'profile')
         and (payload ? 'activity')
         and (payload ? 'values')                as base_shape_ok,
       not (payload::text ~* '"(name|email|phone|turns|transcript|prompt|eventSignals)"')
                                                  as forbidden_key_absent
from career_personal_memory
where user_id = :owner and section_key = 'base';
-- 期待: 1 row / status='fresh' / schema_version=1 / payload_type='object'
--       / payload_bytes < 32768 / base_shape_ok=true / forbidden_key_absent=true

-- (2) base write が他 section を作っていない/変えていないことの確認
select section_key, status, source_revision, updated_at
from career_personal_memory
where user_id = :owner
order by section_key;
-- 期待: base 以外の section が本 canary で新規作成/更新されていない

-- (3) cross-user 遮断の確認（RLS で 0 行になること。他 user UUID は使わない）
--     ※ 別 owner UUID を bind しないこと。RLS が自分以外を返さない事実は (1)(2) が自 owner のみを
--        返すことで確認する（他 user 行の明示 SELECT はしない）。
```

---

## Phase 6 — Required Canary Cases

| Case | 条件 | 期待 |
|---|---|---|
| **A 初回 write** | 対象 owner に base row 無し → profile 保存 | base row 1 件作成 / `status='fresh'` / Source 保存成功 / 画面遷移成功 / 他 section 変更なし |
| **B 同一 Source 再保存** | Source 内容を変えず再保存 | `source_revision` 不変 / 不要な upsert なし（`decideWrite`→`unchanged` skip）/ `updated_at` 不要変化なし / row 重複なし（UNIQUE(user_id,section_key)） |
| **C Source 変更** | 非 PII の profile 項目を 1 つ変更 | `source_revision` 変化 / base row 更新 / `status='fresh'` / 他 section 変更なし |
| **D activity 保存** | activity を 1 回保存（1.5s 留まる） | base 全体が再構築 / activity projection（presentSections/highlights）反映 / profile・values が失われない |
| **E values 保存** | values を 1 回保存 | base 全体が再構築 / values projection（priorities 等）反映 / profile・activity が失われない |
| **F flag OFF** | flag OFF に戻し再 deploy 後に保存 | Personal Memory write なし（`shadowWriteBaseMemory` 即 return）/ Source 保存は正常 / 既存 row は残る |

> D/E は「base 全体再構築」= `shadowWriteBaseMemory` が profile/activity/values の 3 Source を毎回再 load して
> base section を作り直す挙動（[personalMemoryShadowWrite.ts](../../app/career/personalMemoryShadowWrite.ts)）と一致。どの Source を保存しても base 全体が対象。

---

## Phase 7 — Failure / STOP Conditions（即時 STOP → Phase 8 Rollback）

- deployment が Production だった / 接続先 Supabase が Production だった
- Production env へ flag を設定した
- 他 member が canary 環境で保存している可能性がある
- DDL 適用先が不明 / DDL が既に部分適用されている
- RLS が無効 / owner 以外の row が見える
- service role が必要になった
- Source 保存が失敗した / profile 画面の遷移が失敗した / runtime exception が UI へ影響した
- PII が payload に入った / forbidden key が入った / payload が 32KB 以上
- 同一 Source で `source_revision` が変化する / 重複 row が作成される
- base 保存で他 section が変更される
- flag OFF へ戻せない / rollback 担当者が不在
- 実行ログに secret や個人情報が出た

> STOP 後は**追加操作をせず**、直ちに Phase 8 Rollback へ移る。

---

## Phase 8 — Rollback

1. canary 環境の flag を **OFF または削除**
2. Preview / development を**再 build / 再 deploy**
3. flag OFF をコード上の挙動で確認（`shadowWriteFlag` が OFF → `shadowWriteBaseMemory` 即 return）
4. owner session で保存操作（profile 等）
5. **新規 Personal Memory write が発生しないこと**を確認（row の `updated_at` 不変）
6. canary owner の `base` row を **owner DELETE policy** で削除（自分の row のみ・下記 template）
7. **他 section row を削除しない**
8. **他 user row を削除しない**
9. **Source Data（localStorage / mirror）を削除しない**
10. profile / activity / values が正常に残ることを確認
11. QA 5 本を再実行（§QA）
12. rollback 結果を記録（テンプレート）

```sql
-- owner-scoped: 自分の base row のみ削除（RLS DELETE policy 内。service role 不使用）
delete from career_personal_memory
where user_id = :owner and section_key = 'base';
-- 他 section / 他 user は対象にしない
```

> **table 全体の DROP は通常 rollback として使用しない。** DDL そのものを取り消す必要がある場合のみ、
> 別途明示的な運用判断（適用先が non-production であること・他機能非依存の再確認）を経て `DROP TABLE` を検討する。

---

## Phase 9 — Success Criteria（すべて満たした場合のみ PASS）

- non-production のみで実施 / Production へ接続していない
- owner-scoped RLS 維持
- base row が正しく作成 / `status='fresh'` / `schema_version=1` / payload shape 正常
- PII 非混入 / forbidden key 非混入 / 32KB 未満
- idempotency 確認（Case B）
- Source 変更による revision 変化確認（Case C）
- activity / values 保存後も base 全体が欠落しない（Case D/E）
- 他 section 非改変 / 他 user row 非参照
- Source 保存・UI へ影響なし
- flag OFF rollback 確認（Case F / Phase 8）
- QA 5 本 PASS

> **一部だけ確認した状態を canary 完了扱いしない**（PARTIAL PASS は Phase 10 へ）。

---

## Phase 10 — Post-Canary Decision

- **PASS** → 次候補（**prompt へ接続しない**）:
  base actual-row read contract 確認 / base runtime read parity / shadow read observation /
  self_analysis・es runtime write 準備。
- **PARTIAL PASS** → 不足項目を HOLD として残し、**rollout へ進まない**。
- **FAIL** → flag OFF → 再 deploy → owner row 削除 → 原因分析。**production rollout 禁止**。
- **ENVIRONMENT NOT AVAILABLE** → runtime canary は HOLD。**runbook 完成のみを成果**とし、
  **Production で代替しない**。

---

## 運用記録テンプレート（実行時に控える。secret / URL / UUID / メール / payload 本文は記録しない）

```
# Personal Memory base canary — 実行記録
実施日:                <YYYY-MM-DD>
担当者(canary):        <NAME/HANDLE>
担当者(rollback):      <NAME/HANDLE>
deployment 種別:       [ ] Preview  [ ] development   （Production は不可）
commit:                <COMMIT_SHA>
branch:                <BRANCH>
non-production 確認:    [ ] deployment  [ ] Supabase project  [ ] flag は Production 未設定
DDL 適用結果:          [ ] 成功(table/trigger/index/RLS/4 policy)  [ ] 失敗→STOP
flag ON deployment:    [ ] Preview/dev 限定で ON・再 deploy 済
Case A(初回):          [ ] PASS  [ ] FAIL   base_row=created status=____
Case B(再保存):        [ ] PASS  [ ] FAIL   revision 不変=____ updated_at 不変=____
Case C(変更):          [ ] PASS  [ ] FAIL   revision 変化=____
Case D(activity):      [ ] PASS  [ ] FAIL   projection 反映=____（1.5s 留まり確認）
Case E(values):        [ ] PASS  [ ] FAIL   projection 反映=____
Case F(flag OFF):      [ ] PASS  [ ] FAIL   write なし=____
PII guard:             [ ] forbidden_key_absent=true
payload size:          [ ] < 32768 bytes（実 byte 数のみ・本文は書かない）
他 section 非改変:      [ ] 確認   他 user 非参照: [ ] 確認
rollback 結果:         [ ] flag OFF  [ ] 再 deploy  [ ] owner base row 削除  [ ] Source 残存確認
QA 結果:               [ ] Schema  [ ] Repository  [ ] Writer  [ ] Wiring  [ ] ReadContract
最終判定:              [ ] PASS  [ ] PARTIAL  [ ] FAIL  [ ] ENV NOT AVAILABLE
未完了項目:            <...>
```

---

## QA（オフライン・本 runbook 実施の前後で実行）

```
npm run qa:careerPersonalMemorySchema
npm run qa:careerPersonalMemoryRepository
npm run qa:careerPersonalMemoryWriter
npm run qa:careerPersonalMemoryWiring
npm run qa:careerPersonalMemoryReadContract
```

いずれも fake deps / 静的検査でオフライン（外部 AI / 実 Supabase / production 非接続）。5 本 PASS が
Phase 1 / Phase 8 / Phase 9 の必須条件。

---

## コード整合の根拠（本 runbook が記述する挙動の出所）

| runbook 記述 | 出所 |
|---|---|
| flag ON 値 `true`/`1`/`yes`・未設定/invalid は OFF・build 固定 | `shadowWriteFlag.ts` |
| flag OFF → 即 return（load も coordinator も無し）/ fire-and-forget / base 全体再構築 | `personalMemoryShadowWrite.ts` |
| member 以外 guest / no-env、client 未生成 no_client、compare-and-set 用 read のみ | `productionShadowWriter.ts` |
| unchanged skip / stale_write / never-throw / section 独立 | `shadowWriter.ts` / `state.ts` |
| owner-scoped upsert・RLS 権威・never-throw read | `repository.ts` |
| 32KB cap / forbidden key deep scan / base shape | `validate.ts` |
| base projection（profile/activity/values・PII strip・cap）/ 決定的 revision | `rebuild.ts` |
| UNIQUE(user_id,section_key) / RLS 4 policy / 追加のみ非破壊 / IF NOT EXISTS 無し | `career_personal_memory_apply.sql` |
| profile 無条件呼び出し / values は currentUserId gate / activity 1500ms debounce・unmount flush は shadow write を呼ばない | 各 callsite |

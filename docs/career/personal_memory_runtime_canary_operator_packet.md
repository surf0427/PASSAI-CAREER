# Personal Memory Runtime Canary — Human Operator Packet（P16-I-OP）

> **本 packet は runtime 操作を含まない。** repo を read-only 調査して、人間オペレータが P16-I Phase A〜G を
> 安全に実行するための「正確な env 変数名 / 値の形式 / SQL / ブラウザ・Vercel・Supabase 操作 / rollback /
> 証拠テンプレート / STOP 条件」をまとめたもの。**値・secret・実 UUID・実メール・token は一切含めない。**
> 変数名・SQL の column 名はすべて repo の実コードから特定している（推測しない）。

Packet 作成時点: branch `feature/career-mvp` / HEAD `9423ebb` / working tree clean / origin ahead 4・behind 0 /
P16-E `464cf08`・P16-F-1 `932d0a9`・P16-G `e0b44e5`・P16-H `9423ebb` 存在（全 local・未 push）/
production read 未配線（read adapter は QA のみ import）/ prompt・Context Orchestrator 未接続 /
master flag code default OFF。

---

## 1. 対象コード（read-only 参照。canary は既存挙動を変えない）

| 関心 | 実装 |
|---|---|
| master flag | [shadowWriteFlag.ts](../../lib/careerMemory/persistence/shadowWriteFlag.ts) |
| user/section allowlist parse | [canaryGate.ts](../../lib/careerMemory/persistence/canaryGate.ts) |
| server-only config 読取 | [canaryConfig.server.ts](../../lib/careerMemory/persistence/canaryConfig.server.ts) |
| eligibility 検証（server core） | [canaryEligibility.ts](../../lib/careerMemory/persistence/canaryEligibility.ts) |
| eligibility API | [route.ts](../../app/api/career/personal-memory/canary-eligibility/route.ts) |
| client resolver | [canaryEligibilityClient.ts](../../lib/careerMemory/persistence/canaryEligibilityClient.ts) |
| gated write pipeline | [personalMemoryShadowWrite.ts](../../app/career/personalMemoryShadowWrite.ts) |
| coordinator / writer / repository / validate / rebuild / state | `lib/careerMemory/persistence/*` |
| DDL | [career_personal_memory_apply.sql](../../supabase/career_personal_memory_apply.sql) |
| base 発火 callsite | [ProfileClient.tsx](../../app/career/profile/ProfileClient.tsx)（`handleSubmit`→L195 `saveBasicInfo`→L199 `shadowWriteBaseMemory`→L200 `router.push`） |

**base の最も確実な発火操作**: `/career/profile`（基本情報入力）フォームの**送信ボタン**を 1 回押す。
Source 保存（`saveBasicInfo`）後に `void shadowWriteBaseMemory()` が fire-and-forget で走り、`/career/home` へ遷移する。
（activity 画面は 1500ms debounce・unmount flush では shadow write を呼ばないため、canary 発火の確実性は profile 送信が最良。）

---

## 2. Exact environment-variable inventory

| 変数名 | scope | timing | 値形式 | 未設定/空 | `false` | trim/dedupe | invalid | 設定先 | 再deploy | rollback |
|---|---|---|---|---|---|---|---|---|---|---|
| `NEXT_PUBLIC_CAREER_PERSONAL_MEMORY_SHADOW_WRITE_ENABLED` | **public** | **build-time inline** | `true`/`1`/`yes`（trim+小文字化）で `<ON>`、他は OFF | OFF | OFF | 単一トークンを trim+lower | OFF | **Preview のみ** | **必要**（build 埋め込み） | `<OFF>`（削除 or 空/false）+ 再deploy |
| `CAREER_PERSONAL_MEMORY_CANARY_USER_IDS` | **server-only** | server 実行時読取（route）| comma-separated UUID | 空 allowlist=deny | — | 各要素 trim・重複除去 | **不正 UUID 1件で設定全体 deny** / 上限 **50** 超で deny | **Preview のみ** | 必要（Vercel env 反映） | 削除 or 空 + 再deploy |
| `CAREER_PERSONAL_MEMORY_CANARY_SECTIONS` | **server-only** | server 実行時読取（route）| comma-separated | 空 allowlist=deny | — | 各要素 trim・重複除去 | `base/self_analysis/es/interview` 以外・`*`・`all` は**設定全体 deny** | **Preview のみ** | 必要 | 削除 or 空 + 再deploy |
| `NEXT_PUBLIC_CAREER_SUPABASE_URL` | public | build-time inline | CAREER 専用 project URL | client null=mirror無効 | — | — | — | 対象 deployment | 必要 | （canary で変更しない） |
| `NEXT_PUBLIC_CAREER_SUPABASE_ANON_KEY` | public | build-time inline | CAREER 専用 anon key | client null=mirror無効 | — | — | — | 対象 deployment | 必要 | （canary で変更しない） |
| `CAREER_SUPABASE_SERVICE_ROLE_KEY` | server-only | server | service role | — | — | — | — | — | — | **canary 経路では使用しない（browser は anon のみ）** |

canary 有効化に設定するのは上 **3 変数**（master flag ＋ USER_IDS ＋ SECTIONS）。`<CANARY_USER_UUID>` は本人テストアカウント 1 名の UUID、`<BASE_SECTION>` = `base`。
**書き込みは browser anon client（`getCareerBrowserSupabaseClient`）+ RLS**、認証検証は server anon+cookie（`getCareerServerSupabaseClient().auth.getUser`）。**service role は canary 経路で不使用**。

> ★ **重要**: master flag は `NEXT_PUBLIC_`＝build-time inline のため ON/OFF いずれも **再 build/再 deploy 必須**。
> server-only の 2 変数も Vercel では env 変更後の **再 deploy** で反映する運用が安全。
> 3 変数は**同一 Preview deployment に対して**設定し、**Production には設定しない**。

---

## 3. DDL application-status preflight（read-only SQL・metadata のみ）

DDL ファイル: `supabase/career_personal_memory_apply.sql`（未適用だった場合も**このファイルを丸ごと**適用。新規 DDL を作らない・部分実行しない）。

```sql
-- (P1) table 存在
select to_regclass('public.career_personal_memory') as table_regclass;      -- 期待: public.career_personal_memory

-- (P2) column 一覧と型
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='career_personal_memory'
order by ordinal_position;

-- (P3) primary key / (P4) UNIQUE(user_id, section_key) / その他 constraint
select conname, contype, pg_get_constraintdef(oid) as def
from pg_constraint
where conrelid = 'public.career_personal_memory'::regclass
order by contype;

-- (P5) index
select indexname, indexdef
from pg_indexes
where schemaname='public' and tablename='career_personal_memory';

-- (P6) RLS enabled
select relname, relrowsecurity, relforcerowsecurity
from pg_class where oid='public.career_personal_memory'::regclass;          -- 期待: relrowsecurity=true

-- (P7)-(P12) policy 一覧（owner 4 種のみ・anon/public policy が無いこと）
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname='public' and tablename='career_personal_memory'
order by cmd;
```

### DDL ↔ 実 DB metadata 対応表（operator 確認用）

| 確認項目 | DDL の定義（apply.sql） | 期待 metadata（上記 SQL） |
|---|---|---|
| table | `CREATE TABLE career_personal_memory` | P1 = `public.career_personal_memory` |
| columns | id/user_id/section_key/schema_version/source_revision/source_updated_at/generated_at/status/payload/created_at/updated_at | P2 に 11 列 |
| PK | `id uuid PRIMARY KEY` | P3 に `contype=p`（id） |
| UNIQUE | `CONSTRAINT career_personal_memory_user_section_unique UNIQUE (user_id, section_key)` | P3/P4 に該当 unique |
| section CHECK | `career_personal_memory_section_key_check CHECK (section_key IN ('base','self_analysis','es','interview'))` | P3 に該当 |
| version CHECK | `career_personal_memory_schema_version_check CHECK (schema_version > 0)` | P3 に該当 |
| status CHECK | `career_personal_memory_status_check CHECK (status IN ('fresh','stale','failed'))` | P3 に該当 |
| payload CHECK | `career_personal_memory_payload_object_check CHECK (jsonb_typeof(payload)='object')` | P3 に該当 |
| index | `CREATE INDEX career_personal_memory_user_section_idx ON (user_id, section_key)` | P5 に該当 |
| trigger | `CREATE TRIGGER career_personal_memory_set_updated_at BEFORE UPDATE` | （任意）`select tgname from pg_trigger where tgrelid='public.career_personal_memory'::regclass and not tgisinternal;` |
| RLS | `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` | P6 = true |
| owner policies | `"career_personal_memory owner select/insert/update/delete"`（各 `auth.uid()=user_id`, role `authenticated`） | P7 に 4 policy・roles=`{authenticated}` |
| anon/public policy | （存在しない） | P7 に anon/public 行が**無い**こと |

DDL が想定 schema と一致しない / RLS disabled / owner policy 不足 / anon-public policy 存在 → **STOP**（§8）。

---

## 4. Canary target & data guard

- 対象 = **ログイン済み本人テストアカウント 1 名**・section = **`base` のみ**。
- 禁止: self_analysis / es / interview / 他ユーザー / guest / global rollout / wildcard / 空 allowlist を全許可扱い /
  service role / payload logging / Source payload の SQL Editor 転記。
- 対象 UUID の取得方法（**値を本 packet や報告に貼らない**）: Supabase Studio → Authentication → Users で本人テスト
  アカウント行を特定するか、対象 deployment に本人でログイン後、owner session の `auth.uid()` を使う。UUID は
  `CAREER_PERSONAL_MEMORY_CANARY_USER_IDS`（Preview env）へ直接貼るのみとし、**docs/報告/log には残さない**。

---

## 5. Exact row-verification queries（owner session・metadata のみ・`<CANARY_USER_UUID>` placeholder）

repository / DDL の実 column 名（`section_key,schema_version,source_revision,source_updated_at,generated_at,status,payload`、
upsert conflict key `user_id,section_key`）に一致。**payload 本文・UUID 全文・raw Source・PII を返さない。**

```sql
-- Query A — pre-canary row existence（対象 user・base の metadata のみ）
select section_key, schema_version, status,
       left(source_revision, 20) as source_rev_short,     -- 短縮表示（秘匿ではないが全文は残さない）
       pg_column_size(payload)   as payload_bytes,
       created_at, updated_at
from career_personal_memory
where user_id = '<CANARY_USER_UUID>' and section_key = 'base';
-- 期待（Phase 0）: 0 行、または既存 1 行の metadata

-- Query B — duplicate check（section 毎 row 数が 1 を超えない）
select section_key, count(*) as row_count
from career_personal_memory
where user_id = '<CANARY_USER_UUID>'
group by section_key
order by section_key;
-- 期待: base の row_count = 1（初回書込後）/ 重複なし

-- Query C — post-write parity metadata
select schema_version, status,
       left(source_revision, 20) as source_rev_short,
       pg_column_size(payload)   as payload_bytes,
       (pg_column_size(payload) < 32768) as size_ok,
       (payload ? 'profile') and (payload ? 'activity') and (payload ? 'values') as base_shape_ok,
       created_at, updated_at
from career_personal_memory
where user_id = '<CANARY_USER_UUID>' and section_key = 'base';
-- 期待: schema_version=1 / status='fresh' / source_rev_short 非空 / size_ok=true / base_shape_ok=true

-- Query D — unrelated-section guard（base 以外が作られていない）
select section_key, count(*)
from career_personal_memory
where user_id = '<CANARY_USER_UUID>' and section_key <> 'base'
group by section_key;
-- 期待: 0 行
```

### revision の一致確認について（正直な限界）

- 保存 payload の `source_revision` は app が**決定的**に算出する（[revision.ts](../../lib/careerMemory/persistence/revision.ts) `computeContentRevision` = `v1:content:` + FNV-1a(stableStringify(projected payload))）。
- **live の Source から expected revision を算出する operator 向け既存ツールは無い**（読取 runner を新設しない方針）。
  よって「実 row の revision が期待値と**数値一致**」の直接確認は **RUNTIME HOLD**。
- 実行可能な proxy: **不変（Phase D で source_rev_short 不変）/ 変化（Phase E で変化）** の観測（Query C の前後比較）。
  これで「同一 Source→同一 revision・変更→revision 変化」の contract は確認できる。数値一致 parity は HOLD。
- オフライン等価（builder 決定性・write→read round-trip）は P16-H shadow-pipeline QA で PASS 済（`npm run qa:careerPersonalMemoryShadowPipeline`）。

---

## 6. Human runtime procedure

### Phase 0 — preflight（Supabase / Vercel）
1. 対象 deployment を **Preview** に確定（Production ではない）。
2. その deployment の CAREER Supabase が **CAREER 専用 project** であること（`NEXT_PUBLIC_CAREER_SUPABASE_URL` が exam/shared と別）を運用者が確認（値は残さない）。
3. §3 preflight SQL で DDL 適用状況を確認（未適用なら apply.sql を丸ごと適用）。
4. 対象 user（本人テストアカウント）を確定。
5. master flag が現在 **`<OFF>`** を確認、user/section allowlist が未設定（deny）を確認。
6. Query A/B で pre-canary row metadata を記録（証拠テンプレートへ）。
7. **canary と無関係な変更を同時に deploy しない。**

### Phase A — master OFF baseline（ブラウザ）
- master `<OFF>` の Preview deployment に本人でログイン。
- `/career/profile` の**基本情報フォームを 1 回送信**（`/career/home` へ遷移）。
- 確認: Source 保存成功・`/career/home` 遷移・UI に Personal Memory 関連表示や error が無い。
- Query A/B: base row が**新規作成・更新されない**こと（Phase 0 と同じ）。

### Phase B — narrow enable（Vercel・Preview のみ）
以下**だけ**を Preview env に設定し、**再 deploy**（master flag は build-time inline のため必須）:
- `NEXT_PUBLIC_CAREER_PERSONAL_MEMORY_SHADOW_WRITE_ENABLED = <ON>`（`true`）
- `CAREER_PERSONAL_MEMORY_CANARY_USER_IDS = <CANARY_USER_UUID>`（本人 1 名）
- `CAREER_PERSONAL_MEMORY_CANARY_SECTIONS = base`
Production には設定しない。他 user・他 section は deny を維持。**コード default を ON に変えない。**

### Phase C — initial write（ブラウザ→Supabase）
- 再 deploy 済み Preview に本人でログイン → Phase A と**同じ profile 送信**を 1 回。
- 確認: Source 保存成功 / UI error なし。
- Query C: row 1 件・`section_key='base'`・`schema_version=1`・`status='fresh'`・`source_rev_short` 非空・`size_ok=true`・`base_shape_ok=true`。
- Query B: base の row_count=1（duplicate なし）。 Query D: 他 section 0 行。

### Phase D — unchanged replay（ブラウザ→Supabase）
- Source を変更せず、同じ profile 送信を再実行。
- 確認: Query B row_count=1・Query C の `source_rev_short` **不変**・`payload_bytes` 不変・duplicate なし・UI error なし。
- `updated_at`: unchanged なら upsert が走らない設計（`decideWrite`→`unchanged` skip）のため **`updated_at` は変化しない想定**。ただし **repository の upsert 実回数は Supabase Studio から直接観測不可 → `NOT OBSERVABLE`**（`updated_at` 不変で間接確認）。

### Phase E — non-sensitive change（ブラウザ→Supabase）
- base projection に確実に含まれ、かつ**非機微**なフィールドを 1 つだけ変更する。
  推奨: **志望業界（`targetIndustries`）に業界を 1 つ追加**（[rebuild.ts](../../lib/careerMemory/persistence/rebuild.ts) `projectProfile` が projection・PII でない）。
  代替候補（同 projection・非 PII）: 志望職種 `targetJobs` / 就活状況 `jobHuntingStatus` / 学年 `grade`。
  **禁止**: 氏名・メール・電話・住所・自由記述の個人情報・raw conversation。
- 変更して送信 → 確認: Query C の `source_rev_short` **変化**・row_count 1・`updated_at` 変化・`base_shape_ok=true`（他 projection 欠落なし）・Query D 0 行・UI/Source 正常。

### Phase F — read-back compatibility
- **production prompt へ接続しない。** 実 row を read adapter に通す**既存の安全な operator runner は存在しない**
  （read adapter は QA のみが import。payload logger を新設しない方針）。
- よって実 row の read adapter 通過確認は **`RUNTIME HOLD`**。代替の安全確認 = **Query C の metadata parity**
  （schema_version=1 / status=fresh / base_shape_ok / size_ok）で読取可能性を担保する。
- read adapter の fresh/stale/failed/unsupported・payload round-trip のオフライン等価は
  `npm run qa:careerPersonalMemoryReadContract` / `qa:careerPersonalMemoryShadowPipeline` で PASS 済（**shadow read parity 完了とは呼ばない**）。

### Phase G — immediate shutdown（Vercel）
1. `NEXT_PUBLIC_CAREER_PERSONAL_MEMORY_SHADOW_WRITE_ENABLED` を **`<OFF>`**（削除 or 空/false）。
2. `CAREER_PERSONAL_MEMORY_CANARY_USER_IDS` を削除。
3. `CAREER_PERSONAL_MEMORY_CANARY_SECTIONS` を削除。
4. **再 deploy**。
5. 新 deployment で master OFF を確認 → profile 送信 1 回 → Query B/C で row が**追加更新されない**こと。
6. production read 未配線・prompt/Orchestrator 未接続を再確認（コード無変更）。

---

## 7. Rollback Card（画面横に置く短縮版）

```
[ Personal Memory Canary — ROLLBACK ]
1. master flag → <OFF>（Preview env を削除 or false）
2. CANARY_USER_IDS を削除
3. CANARY_SECTIONS を削除
4. Preview を 再 deploy（flag ON deployment へ戻さない）
5. deployment 完了を確認
6. 追加の保存操作を止める
7. sanitized metadata だけ記録（UUID/payload/token は残さない）
8. row を勝手に削除しない / SQL・RLS を変更しない
9. 想定外事象は incident として STOP（独断で再試行・修正しない）
```

---

## 8. STOP conditions（直ちに中止・独断修正/再試行/SQL 変更をしない）

CAREER 専用 project か確認できない / DDL が想定 schema と不一致 / RLS disabled / owner policy 不足 /
anon・public policy 存在 / user allowlist を 1 名に限定できない / section を `base` だけに限定できない /
master OFF baseline で write 発生 / guest で write 発生 / row が 2 件以上 / revision 欠損 / schema version 不一致 /
validation 失敗 / UI error / Source 保存失敗 / 他 section 作成 / payload・UUID・email・token 露出 /
rollback 不能 / 原因不明の Supabase error / `23505`（UNIQUE 競合）/ retry storm。

---

## 9. Evidence template（値を伏せて記入。UUID/email/payload/token の列は作らない）

| Phase | deployment | master flag | user gate | section gate | Source save | UI | row count | revision changed | schema version | status | payload size pass | other section count | timestamp | result | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 preflight | Preview | `<OFF>` | unset | unset | — | — | | — | | | | | | | |
| A baseline | Preview | `<OFF>` | unset | unset | ok? | ok? | | no | | | | | | | |
| B enable | Preview | `<ON>` | 1名 | base | — | — | | — | | | | | | | 再deploy済 |
| C initial | Preview | `<ON>` | 1名 | base | ok? | ok? | 1 | yes | 1 | fresh | pass? | 0 | | | |
| D replay | Preview | `<ON>` | 1名 | base | ok? | ok? | 1 | no | 1 | fresh | pass? | 0 | unchanged? | | upsert回数=NOT OBSERVABLE |
| E change | Preview | `<ON>` | 1名 | base | ok? | ok? | 1 | yes | 1 | fresh | pass? | 0 | changed? | | 変更=志望業界等 非PII |
| F read-back | — | — | — | — | — | — | | — | 1 | fresh | pass? | 0 | | 実row adapter=RUNTIME HOLD |
| G shutdown | Preview | `<OFF>` | unset | unset | ok? | ok? | 1(不変) | no | 1 | fresh | | 0 | | | flag OFF復帰 |

---

## 10. HOLD 項目（本 packet では実行/証明しない）

- 実 Supabase runtime write（Phase A〜G の実行そのもの）— **人間オペレータが実施**
- revision 数値一致 parity（operator 向け算出ツール無し）— proxy 観測のみ
- Phase F 実 row の read adapter 通過（safe runner 無し・payload logger 追加しない）
- non-owner RLS runtime denial（他アカウント作成・他 row アクセスをしない）→ §3 policy read-only 確認に留め **RUNTIME HOLD**
- DB concurrency（simultaneous insert / `23505` / same-revision concurrent / read-both-empty）→ **RUNTIME HOLD**（安全な隔離環境が確認できない限り production で意図的に起こさない）
- 非 production CAREER Supabase 環境の実在確認（repo/docs からは未確認）

---

## 11. 判定

本 packet は §2〜§9 の env 変数名・値形式・DDL preflight/対応表・row 検証 SQL・ブラウザ/Vercel/Supabase 手順・
rollback card・evidence template・STOP 条件・HOLD 項目を、すべて **repo の実コードから特定**して提示した。
不足する runtime 情報（安全な非 production 環境の実在・実 revision 算出ツール・実 row read runner・DB concurrency）は
推測で補わず **RUNTIME HOLD** として明記した。

**OPERATOR PACKET READY**（P16-I runtime canary は未実行のまま。COMPLETED 扱いにしない。実行は人間オペレータが
本 packet と [canary runbook](./personal_memory_base_runtime_canary_runbook.md) に従って行う。）

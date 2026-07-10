# Consent Persistence — Local Schema / RLS Prototype（P14-E 設計記録）

P14-D でGO判定された同意永続化設計を、**local Supabase / synthetic 限定**で検証した prototype の記録。
**production migration ではない。** local prototype の成功を production approval と解釈しない。

関連: P14-D 監査（Schema Option 2 / advisory-lock seq / owner RLS / service_role-gated RPC）/
[consent_ledger_foundation.md](./consent_ledger_foundation.md)（P14-C domain）。

## ⚠ 環境上の重要な限定

本 repo には **Supabase CLI / psql / docker / `supabase/config.toml` が無く**、live Postgres を
起動できない。production 接続は禁止。したがって DB 制約（RLS / RPC / UNIQUE / append-only /
advisory lock）は次の 2 層で検証している:

1. **prototype SQL の静的構造検査**（`scripts/career-consent-proto-schema-qa.ts`）
2. **忠実な TypeScript reference model**（`lib/careerConsent/prototype/localLedgerModel.ts`）で
   意味論（seq 採番の直列化・UNIQUE 強制・冪等・RLS access・withdrawal outbox の atomicity）を実行検証

→ **live Postgres 上での実 RLS/RPC/並行 transaction は staging で別途必須**（本 phase では未実施）。

## 成果物（すべて local-only・production 非接続）

| path | 区分 | 役割 |
|---|---|---|
| `supabase/prototype/consent_local_prototype.sql` | prototype SQL（**DO NOT APPLY**） | schema + RLS + receipt view + append RPC |
| `lib/careerConsent/prototype/localLedgerModel.ts` | pure model | SQL 意味論の忠実な in-memory 再現 |
| `lib/careerConsent/prototype/localRepositoryAdapter.ts` | server-only adapter | P14-C interface を model へ接続 |
| `scripts/career-consent-proto-*-qa.ts`（6本） | dev-only QA | schema/model/sequence/rls/withdrawal/static-guard |

## Schema（P14-D Option 2）

- `career_consent_policies`（policy manifest の SoT）: scope+consent_version PK・active 部分 unique index・
  version/notice/digest 非空 check・legal_review_status。
- `career_consent_events`（append-only 同意 ledger の SoT）: `UNIQUE(subject_user_id, server_sequence)`・
  `UNIQUE(subject_user_id, idempotency_key)`・server_sequence>=1・idempotency_key/payload_digest 非空・
  scope/action/actor_type CHECK。**禁止列（ip/user_agent/device_fingerprint/reason/raw policy text）は存在しない**。
- `career_consent_withdrawal_outbox`: withdrawal と同一 txn で追記（open bucket recompute / eligibility /
  cache invalidation flag）。
- **current state table は作らない**（derived / reducer が SoT）。

## Append-only / Write path

- ledger に UPDATE/DELETE policy を張らず、authenticated の直接 INSERT policy も張らない
  → **書き込みは RPC 経由のみ**。correction は UPDATE せず新 event（correction_target_event_id 参照）。
- `career_consent_append_prototype`: `SECURITY DEFINER` + `SET search_path=public,pg_temp` +
  `REVOKE ALL FROM PUBLIC`（anon/authenticated へ EXECUTE 付与なし）。client の recorded_at/server_sequence を
  信頼しない。冪等事前 SELECT → `pg_advisory_xact_lock(subject)` → `MAX(server_sequence)+1` → INSERT →
  `unique_violation` 時は既存行返却（career_gd_post_message 準拠）。

## Sequence / Concurrency（実証済み）

- subject-scoped monotonic。model の並行 50 append で **seq が全て unique・1..N 網羅・collision 0**。
- 対照実験: **naked MAX+1（lock なし）は unique_violation を起こす** → advisory lock 直列化が必須と実証。
- duplicate/conflict retry は seq を消費しない。

## Idempotency

- `UNIQUE(subject_user_id, idempotency_key)` + payload_digest。same key/same payload=duplicate（既存返却）・
  same key/diff payload=conflict・diff key/same payload=new・subject 間で同一 key 独立・missing key=rejected。
- P14-B の `client_event_id` は流用しない（consent 専用 key）。

## RLS / Access（model で検証・DB は staging 必須）

- ledger SELECT: owner のみ（other=0件・anon=denied・batch=raw 不可）。
- manifest: authenticated は active のみ・anon denied。
- receipt: owner のみ・internal 列（subject/seq/idempotency/digest/recorded_at）非漏洩。
- aggregate projection: **batch executor のみ**・fixed columns・raw history 非公開・要求 subject のみ。

## Receipt / Withdrawal

- receipt は P14-C reducer/buildConsentReceipt を SoT に導出（never_granted→active→withdrawn→reconsent）。
  normalFeaturesUnaffected=true。ledger から rebuild 可能。
- withdrawal event と outbox は同一 critical section（atomic）。duplicate withdrawal は outbox 二重化なし。
  closed aggregate 寄与除去は `LEGAL_REVIEW`、反映 SLA は `PROVISIONAL`（技術アクションのみ発行）。

## Account deletion / Retention（未確定・固定しない）

- 本 prototype の subject_user_id は **FK なし uuid（PROVISIONAL）**。`auth.users ON DELETE CASCADE` を
  production 最終方針として確定していない。
- CASCADE は同意証跡消失、tombstone は再特定リスク残存 → raw events / ledger / idempotency / aggregate /
  cache / backup を **個別判断**すべき。production migration 前に **LEGAL_REVIEW** が必須（blocker）。
- retention: ledger=`LEGAL_REVIEW` / manifest=long-term / idempotency=`PROVISIONAL` / state=不要 /
  receipt=derived / outbox=`PROVISIONAL` / logs=`PROVISIONAL` / backup=`LEGAL_REVIEW`。永久保存を既定にしない。

## Production 隔離（§9）

- `supabase/prototype/`（`*_apply.sql` 命名でない）に隔離・DO NOT APPLY 明記。
- CI/deploy から自動実行されない（Supabase CLI/config.toml/auto-migration 無し）。
- adapter は `import 'server-only'`。app/api/matching/AI route から prototype を import しない（static guard）。
- prototype は `process.env` 実値参照・Supabase client 生成をしない。

## 未実装 / 次段

production migration・production Supabase 適用・consent UI・privacy notice 本文・production route・
service-role 接続・aggregate/AI/matching 接続・account deletion 実処理・legal 断定は **未実装**。
production 実装前に account deletion/retention の LEGAL_REVIEW と live Postgres 上の RLS/RPC/並行 test が必要。

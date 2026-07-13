# Personal Memory Canary Gate（P16-G / user-scoped × section-scoped）

## 目的

Personal Memory shadow write を **allowlisted authenticated user × allowed section** に限定するための
二重 gate。P16-F で「master flag が deployment 単位の global boolean で user/section 限定 canary ができない」
という運用上の問題があったため、その上に **server-only の canary allowlist** を重ねる。

## Write 条件（AND）

shadow write が実際に走るのは、以下が **すべて** 成立するときのみ（1 つでも欠ければ write しない）:

1. public master flag `NEXT_PUBLIC_CAREER_PERSONAL_MEMORY_SHADOW_WRITE_ENABLED` が ON
2. authenticated CAREER member（非 anonymous）である
3. server 側で **canary 対象 user** として許可（`CAREER_PERSONAL_MEMORY_CANARY_USER_IDS`）
4. server 側で **対象 section** が許可（`CAREER_PERSONAL_MEMORY_CANARY_SECTIONS`）
5. browser Supabase client が利用可能
6. Source Data が validation を通る
7. compare-and-set が write を許可

master flag は既存のまま（default OFF / fail-closed / build-time inline）。canary gate は master flag を
**置き換えない**（`master flag ON AND allowlisted user AND allowed section`）。master flag OFF なら
eligibility API を呼ばない。

## 構成（責務分離）

| モジュール | 責務 | 層 |
|---|---|---|
| [canaryGate.ts](../../lib/careerMemory/persistence/canaryGate.ts) | allowlist parse（UUID/section）+ pure evaluator。default deny・exact match・cap。env/I/O なし | pure（client 可） |
| [canaryConfig.server.ts](../../lib/careerMemory/persistence/canaryConfig.server.ts) | server-only env 読取 → CanaryConfig。`import 'server-only'` | server-only |
| [canaryEligibility.ts](../../lib/careerMemory/persistence/canaryEligibility.ts) | DI で verifyUser + config を受け eligible を導く純ロジック（never-throw） | pure（DI） |
| [route.ts](../../app/api/career/personal-memory/canary-eligibility/route.ts) | token/cookie から member を server 検証 → `{ eligible }` のみ返す | server route |
| [canaryEligibilityClient.ts](../../lib/careerMemory/persistence/canaryEligibilityClient.ts) | member session の access token を送り eligible を解決。timeout/失敗は false | client |
| [personalMemoryShadowWrite.ts](../../app/career/personalMemoryShadowWrite.ts) | master flag → eligibility → Source load → build → coordinate の gated pipeline | app（client） |

## セキュリティ境界

- **user 検証は server 側のみ**（`getCareerServerSupabaseClient().auth.getUser(token?)`）。cookie session か
  Bearer access token から確定する。**client 申告 userId を信用しない**（body は section のみ利用）。
- allowlist は **server-only env**（`NEXT_PUBLIC_` を付けない＝client bundle 非混入）。値を log / response に出さない。
- **service role を使わない**（anon client + user 検証。RLS が最終権威）。
- API response は **`{ eligible: boolean }` のみ**（userId / allowlist / token / env / deny 理由を返さない）。
- **default deny / fail-closed**: env 未設定・空・不正形式混入・cap 超過・unknown section・wildcard・`all` は
  設定全体を deny。unauthenticated / auth error / network / timeout / malformed / server config 欠如も deny。
- 全経路 **never-throw / fire-and-forget**。Source Data 保存・UI・画面遷移に影響しない。

## Section scope（source of truth）

各 shadow write 呼び出しは明示的 section key を eligibility へ渡す（route/画面名から推測しない・既存 schema の
section discriminator が source of truth）:
`base` callsite→`base` / self-analysis→`self_analysis` / ES→`es` / interview→`interview`。
allowlist に `base` のみ設定なら base write は許可可能・他 3 section は deny。

## QA / 状態

- offline QA: `npm run qa:careerPersonalMemoryCanaryGate`（parser / pure gate / auth boundary(DI) /
  client resolver(DI) / write wiring(DI) / 静的 bundle 安全性）。
- master flag は OFF のまま・runtime write 未実施。read adapter は production 未配線・prompt/Orchestrator 未接続。
- Production rollout・実 row 確認・Interview runtime validation は引き続き HOLD（[canary runbook](./personal_memory_base_runtime_canary_runbook.md) 参照）。

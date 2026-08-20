# Personal Memory READ Pilot — Operator Packet + Decisions（P17-M1 / Data Spine Layer 2 read）

**手順のみ。Claude Code は migration / env 設定 / Supabase 接続 / 実アプリ操作を自動実行しない。**
本パケットの実機作業（env 設定・canary 設定・実アプリ実行・evidence 保存・rollback）はすべて **operator の手動操作**。

対象: L2 Personal Memory の **server read → prompt injection** を、single-user canary で **company_research（企業研究添削）** の
1 purpose に限り通電する。他 purpose（consultation / interview）は本 series では配線しない。

**共通の secret 非出力**: ログ・evidence に user UUID / email / project ref / anon key / service-role key / Memory 本文を
貼らない。記録は「変数名」「成否」「件数 bucket」のみ。

---

## 0. 位置づけと write 側との関係

- write 側（P16-A〜, `NEXT_PUBLIC_CAREER_PERSONAL_MEMORY_SHADOW_WRITE_ENABLED`）が row を書く。read はそれを prompt へ使う **別系統**。
- read gate は write の canary gate と **独立**（read だけ ON / write だけ ON でも安全に成立する）。
- read は **service-role を使わない**。career server client（anon + cookie/token）で RLS（`auth.uid()=user_id`）を最終権威とする。
- **fail-open**: read のどの失敗（flag OFF / gate deny / 未認証 / table 不在 / network / invalid row）でも throw せず、
  Memory 無しで **従来 prompt を維持**する。fail-closed（default OFF）と fail-open（失敗時は従来動作）は両立する。

## 1. READ pilot 決定事項（本 series で確定した pilot 前提。rollout の前提ではない）

### D-R1 — freshness 権威 = DB 永続 `status='fresh'`（pilot 限定・要観測）
- **決定**: server は端末の Source 履歴を持たず expected revision を再算出できないため、read は DB 永続 `status='fresh'` の
  row のみ prompt に採用する（`personalMemoryReadServer.server.ts` / `SELECT ... status='fresh'`）。
- **契約との差**: `personal_memory_shadow_read_parity_contract.md` は freshness = live 再算出 revision == 保存 `source_revision`
  を要求する。server 側は revision 再算出ができないため **pilot では status flag に緩和**する。
- **リスク**: write 時 fresh でも現 Source に対して stale な row が prompt へ載る可能性（stale injection）。
- **緩和 / gate**: (a) read canary は 1 名のみ。(b) 本人が自分の直近データを見るため乖離は小さい。
  (c) **rollout（≥2 名 / 全 purpose）は、実 row の prompt parity（stale 検出率）を観測してからでないと行わない**。
- **prohibited assumption**: 「status='fresh' == 完全な最新性」と扱わない。rollout 判定の前提にしない。

### D-R2 — 通電範囲 = company_research 1 purpose・base/self_analysis のみ
- consultation / interview の wiring は本 series では行わない（renderer の `PURPOSE_SECTIONS` は将来配線先を宣言するのみ）。
- section 拡張・複数 purpose・複数 user は out-of-scope。

### D-R3 — anonymous / CAREER-OTP identity
- userId は **shared career server client の `auth.getUser()`**（`is_anonymous=false` の member のみ）。client 申告 userId は使わない。
- canary allowlist の UUID は上記 auth の `auth.uid()`。

---

## 通電順序（fail-closed 多重 gate）

```
purpose ∈ read allowlist(company_research_review)
  ─AND─ CAREER_PERSONAL_MEMORY_READ_ENABLED = true
  ─AND─ career server client 生成可（env 有）
  ─AND─ auth.getUser() が member（非 anonymous）
  ─AND─ read canary allowlist(1 UUID) に exact 一致
  ─AND─ owner-scoped SELECT status='fresh' が valid row を返す
    └ ここまで全通過して初めて → readAdapter validate → fresh section → renderer（injection 境界 + budget）→ prompt へ結合。
    └ どれか欠ければ **DB read も client 生成もしない**（対象外 purpose / flag OFF は追加 I/O ゼロ）。prompt は byte-identical。
```

**現状: 上記 gate は全て閉じている（env 未設定 = 未通電）。** read コードは追加済だが、operator が下記 Phase を進めるまで何も起きない。

---

## Phase 0 — 決定 gate 確認
- 実行者: PM
- 手順: D-R1〜D-R3 を確認。stale injection リスク（D-R1）を受容する pilot であることを合意
- 停止条件: freshness 緩和が未合意
- rollback: 何もしない

## Phase 1 — QA green 確認（review only）
- 実行者: 開発
- 手順: `npm run qa:careerPersonalMemoryReadPilot`（read-gate / prompt-context / read-server / company-research byte-parity）が green
- 期待結果: fail-closed 判定・empty→byte-identical・budget enforce・injection 境界が緑
- 停止条件: いずれか FAIL
- rollback: 適用しない

## Phase 2 — flag OFF baseline 確認
- 実行者: 運用
- 手順: `CAREER_PERSONAL_MEMORY_READ_ENABLED` 未設定・`CAREER_PERSONAL_MEMORY_READ_CANARY_USER_IDS` 空 を確認
- 期待結果: 企業研究添削の system prompt が **従来どおり**（Memory block 無し）。DB read 0
- 停止条件: flag OFF で Memory block が出る
- rollback: N/A

## Phase 3 — single-user canary 設定
- 実行者: 運用（Preview 環境。Production に設定しない）
- 手順: `CAREER_PERSONAL_MEMORY_READ_ENABLED=true` / `CAREER_PERSONAL_MEMORY_READ_CANARY_USER_IDS` に **1 名の UUID のみ**
  （wildcard/all/複数 禁止）。UUID は shared career server auth の `auth.uid()`（member）
- 停止条件: allowlist が空/複数/wildcard、client 申告 UUID を使用
- rollback: 変数を空へ

## Phase 4 — read pilot 実行（実アプリ 1 回）
- 実行者: 運用（canary user）
- 手順: 企業研究添削を 1 回実行。応答が壊れない（従来品質）・エラー増加が無いことを確認
- 期待結果: `<personal_memory>` を参考にした添削が返る（客観情報は歪めない）
- 停止条件: 応答エラー / 企業客観情報の断定化 / Memory 本文の逐語露出
- rollback: flag OFF

## Phase 5 — rollback
- 実行者: 運用
- 手順: canary allowlist を空 → `CAREER_PERSONAL_MEMORY_READ_ENABLED` を未設定 → redeploy
- 期待結果: 完全に未通電（**flag OFF のみで read が止まり、privileged read query が 0 になる**）
- 停止条件: flag OFF でも Memory block が出る（= gate 前に read している疑い → 即調査）
- 証拠: 全 flag OFF・Memory block が出ないこと

---

# Production rollout（2026-08-20 追加 / rollout scope 機構）

## なぜ master flag だけでは足りないか（実測）

`CAREER_PERSONAL_MEMORY_READ_ENABLED=true` にしても、
`CAREER_PERSONAL_MEMORY_READ_CANARY_USER_IDS` が空なら **誰にも届かない**
（`evaluatePersonalMemoryReadGate` は allowlist exact 一致を要求する）。
wildcard（`*` / `all` / `%`）は parser が **設定全体 invalid** にするため、
「全員を allowlist に列挙する」以外に全開放の手段が無かった（運用不能・cap 50）。

そこで rollout の意思を表す独立 env を追加した:

```text
CAREER_PERSONAL_MEMORY_READ_ENABLED   … master / kill switch（未設定=OFF）
CAREER_PERSONAL_MEMORY_READ_ROLLOUT   … 'all' で全 member 開放（未設定/未知値='canary'）
CAREER_PERSONAL_MEMORY_READ_DENY_USER_IDS … 緊急 deny（scope を問わず最優先）
```

判定順（安全側から）:

```text
master OFF / config invalid            → deny
userId 無し（guest / anonymous）        → deny
deny list に一致                        → deny
scope='all'                            → allow
scope='canary' → allowlist exact 一致   → allow / それ以外 deny
```

## Phase 7 — Production 全面開放

- 実行者: 運用
- 前提: `npm run qa:careerPersonalMemoryAll`（rollout QA を含む）が green
- 手順:
  1. Production env に `CAREER_PERSONAL_MEMORY_READ_ENABLED=true`
  2. Production env に `CAREER_PERSONAL_MEMORY_READ_ROLLOUT=all`
  3. `CAREER_PERSONAL_MEMORY_READ_CANARY_USER_IDS` は **そのままでよい**
     （scope='all' では参照されない。縮退先として残す）
  4. redeploy（server-only env のため runtime 反映には再デプロイが必要）
- 期待結果: 面接（start/turn/complete）と企業分析の prompt に `<personal_memory>` が載る。
  他 route は Layer 1 のみで従来どおり（purpose filter）。
- 停止条件: 5xx 増加 / 応答品質低下 / Memory 本文の逐語露出 / latency 悪化
- rollback: 下の kill switch

## Kill switch（コード deploy 不要）

| やりたいこと | 操作 |
|---|---|
| 全ユーザーで即時停止 | `CAREER_PERSONAL_MEMORY_READ_ENABLED` を未設定/false → redeploy |
| canary へ縮退 | `CAREER_PERSONAL_MEMORY_READ_ROLLOUT` を未設定（='canary'）→ redeploy |
| 特定ユーザーだけ停止 | `CAREER_PERSONAL_MEMORY_READ_DENY_USER_IDS` に UUID 追加 → redeploy |
| rebuild だけ止める | `CAREER_PERSONAL_MEMORY_SERVER_REBUILD_DISABLED=true` → redeploy |

★ いずれも「context を減らす」方向のみ。`D-R1`（検証なしで永続 Memory を使う）へ戻す経路は
`D-S2` により **コードにも env にも存在しない**。

## 観測（H-4 evidence）

`recordCanaryObservation` が enum のみの counter を積む:
`memory ∈ {persisted, rebuilt, stale, invalid, omitted}` /
`sync ∈ {verified, unclaimed, mismatch, unreadable, invalid}` / `memorySectionCount`。
`vetoed.mismatch` の増加は mirror 同期の遅れ、`unclaimed` は signal 未送信 route の残存を示す。

---

## Phase 6 — rollout 判定（本 series 範囲外）
- 実行者: PM
- 前提: D-R1 の stale injection 観測、実 row prompt parity の実測
- 判定: 未観測なら **rollout しない**（consultation / interview / ≥2 名は据え置き）

# Consultation Event Signal Pilot — Series Consolidation（P10 設計契約）

P10-B〜P10-F で構築した **Consultation-only Event Signal Pilot** の完成状態を、1 つの
end-to-end 契約としてまとめた設計文書。運用手順（停止・再開・rollback）は
[event_signal_consultation_pilot_guard.md](./event_signal_consultation_pilot_guard.md) が担い、
本書は **設計契約・境界・データ最小化・失敗隔離** を定義する（役割分担）。

## Scope

- **Consultation 専用**の最小 consumer。就活相談 AI の「次の準備提案の補助」にのみ使う参考情報。
- matching / ES / ES添削 / 面接 / プレゼン / GD / 自己分析 / 企業研究 へは **一切接続しない**。
- score 計算・評価系 prompt・shared snapshot・全 purpose orchestrator へは **昇格しない**。
- 補助情報限定（本人由来 Career Memory より下位・最下位補助ブロック）。

## Architecture

```text
career events (L3 career_user_events)
→ owner-scoped reader        （lib/careerEvents/readSignals.ts・最小4列・.eq(user_id)+RLS）
→ deterministic builder      （lib/careerMemory/eventSignals.ts・pure・now 注入）
→ soft-timeout loader        （lib/careerMemory/loadEventSignals.ts・1000ms・never throw）
→ compact renderer           （lib/careerMemory/renderEventSignals.ts・固定ラベル・byte cap）
→ guarded consultation consumer（app/api/career/consultation/route.ts・server-authoritative guard）
```

依存は **一方向**（逆流なし）:
- builder は DB / reader / loader を知らない（純関数）。
- reader は builder を **値 import しない**（入力型のみ type-only import）。
- renderer は raw rows / reader / loader を受け取らず、versioned summary のみ受ける。
- loader だけが reader + builder を薄く結合し、両方へ **同じ now** を渡す。

### End-to-End Contract（stage 別）

| Stage | Input | Output | Owner boundary | Failure behavior |
|---|---|---|---|---|
| Raw Event | feature result | career event row | writer user | never block feature |
| Builder | sanitized rows + now | summary / null | pure | null |
| Reader | auth userId + now | owner rows / undefined | `.eq(user_id)` + RLS + UUID guard | undefined |
| Loader | userId + now | summary / undefined | member only | timeout/error → undefined |
| Renderer | versioned summary | 固定 compact text / '' | known vocabulary | invalid → '' |
| Client guard | build flag + userId | load / no-load | client optimization | OFF → no read |
| Server guard | build flag + body | render / no-render | **authoritative** | OFF → ignore body |
| Prompt consumer | rendered block | consultation guidance | consultation only | '' は filter で除去 |
| Writer order | successful consultation | consultation event | post-response | writer failure 隔離 |

## Data minimization

Signal summary が持つのは bucket 化・語彙化した傾向のみ:
- **exact count なし**（usage は `1` / `2-3` / `4+` bucket）。
- **exact timestamp なし**（recency は `24h` / `7d` / `30d` bucket）。
- **raw text なし**（本文・title・company・user 入力・prompt・回答は入らない）。
- **PII なし**（userId / id / client_event_id / company_id / metadata は builder 入力にも出力にもない）。
- **known vocabulary のみ**（feature enum / score band S–D / usage bucket / recency bucket）。

Reader は **最小 4 列**（`feature, event_type, score_band, occurred_at`）だけを SELECT し、
`.eq('user_id', userId)` + RLS で owner に閉じる。service_role は使わない（browser anon client + session）。

### Data Contract（public summary v1）

- `version: 1` / `windowDays: 30`
- `recentFeatures`（直近利用順・dedup・最大5）／ `featureUsage`（bucket）／ `latestBands`（matching/presentation/gd のみ）
- `activeAreaCount` / `lastActivityRecency` は **schema 保持だが consultation renderer では未描画**
  （将来 consumer 用の型 field。dead ではなく「保持・非出力」。renderer は使用 field 以外を出力しない）。
- version 不一致・非 object・描画可能データなしは **空文字**（fail-closed）。

## Usage rules

相談 prompt では Signal は最下位補助。誤推論防止 note を **固定文言**で必ず付ける:

```text
※参考情報です。利用量・未利用・評価帯は能力・意欲・適性・合否・弱みを意味しません。評価帯は練習時点の目安で現在の実力ではありません。本人の入力を最優先し、次の準備提案の補助にのみ使ってください。
```

- **本人入力を最優先**（現在の user message > history > profile > activity > values >
  self-analysis 等の本人由来 Career Memory > Event Signal）。
- band は **練習時点の目安**であり現在の実力・能力・適性・合否・弱みを示さない。
- **未利用を否定評価しない**（サボり・準備不足と解釈しない）。
- 用途は準備提案の補助・重複提案の回避・次に試せる機能の選択肢の提示に限定。

## Failure isolation

- Signal failure と consultation failure を **混同しない**（Signal は user-facing error にしない）。
- **never block consultation**：reader/loader は never throw → undefined でそのまま相談続行。
- soft timeout **1000ms**（固定・request から変更不可）・**retry なし**・**reader 最大1回**・**guest reader 0回**。
- timeout 後に unhandled rejection を残さない（timer は race 解決後に必ず clearTimeout）。
- Event writer failure は別経路（fire-and-forget・応答保存を壊さない）。
- 成功した consultation 後の `consultation_asked` 記録順は不変（loader は request 前・record は応答後）。

## Operational guard

- **Deployment guard**（build-time env フラグ）。**Remote kill switch ではない。**
- **server authoritative**：guard OFF なら client が body に `eventSignals` を強制付与しても server が無視。
- **client load 停止**：guard OFF なら loader 非実行（reader 0回・1000ms 待ちなし・body 付与なし）。
- **default OFF**（fail-closed）：env `NEXT_PUBLIC_CAREER_EVENT_SIGNAL_PILOT_ENABLED` 未設定/invalid は無効。
- 切替には **env 変更 + 再 build / 再 deploy が必要**（`NEXT_PUBLIC_*` は build 時 inline）。
- code default は OFF。**deployment 上の現在値は本書では保証しない**（env 実値は未確認）。
- ON にする方法：env を `true` にして build/deploy。OFF にする方法：env 未設定 or false 相当で build/deploy。

## Rollback

- **env 変更 + 再 deploy** で全ユーザー停止（default fail-closed のため未設定デプロイは最初から OFF）。
- コード rollback は **wiring 最小 revert**（page の load 分岐 / route の block を切る）。
- **DB rollback 不要**（SQL / RLS / schema / Event writer は未変更）。
- builder（`6a6e15a`）/ reader（`f719dac`）scaffold は将来用に保持可能（consultation 未接続でも無害）。

## QA

- series command: `qa:careerEventSignalSeries`（P10-B〜F の 5 本を連続実行）。
- consolidation contract: `qa:careerEventSignalConsolidation`（本書の end-to-end 契約・byte 証跡）。
- 個別: `qa:careerEventSignals`（builder）/ `…Reader` / `…Consultation` / `…Aftercare` / `…OperationalGuard`。
- golden / budget / isolation: `qa:careerMemoryPromptGolden`（Signal OFF で golden 不変）/
  `career-context-budget-qa` / `qa:careerContextCore`。
- malicious input / latency は consolidation・aftercare・operational-guard QA でカバー。

## Known limitations（documented）

- Remote kill switch なし（Deployment guard のため停止・再開は再デプロイ必要）。
- deployment 上の flag 実状態は本書では未確認（env 実値を読まない方針）。
- 実 AI 応答の大規模品質評価は未実施（deterministic fixture + 手動サンプルまで）。
- external telemetry / analytics なし。
- Consultation-only（他 consumer へは未展開・意図的に非接続）。

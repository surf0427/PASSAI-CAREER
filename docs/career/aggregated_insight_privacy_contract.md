# Aggregated Insight (Layer 4) — Privacy / Consent / Cohort Contract Foundation（P14-B 設計記録）

P14-A read-only 監査（decision **C**：consent / cohort 基盤を先に作る）の Handoff Contract を
唯一の設計根拠として、**production 非接続**の型・pure function・policy・synthetic QA を先に固定した
記録。**本フェーズは Layer 4 の完成ではない**。完成範囲は「production runtime へ接続されない
privacy / consent / cohort contract と synthetic QA foundation」に限定される。

関連: P14-A 監査（会話ログ・Handoff Contract）／[event_signal_consultation_pilot.md](./event_signal_consultation_pilot.md)（L2 personal signal・別 domain）。

## 位置づけ / production 非接続

- 実装は `types/careerAggregate.ts` と `lib/careerAggregate/**`、QA は `scripts/career-aggregate-*-qa.ts`。
- **DB / SQL / migration / RLS / API / cron / service-role batch / 実データ / AI 接続 / matching 接続 /
  consultation・mypage 接続 / consent 永続化 は作らない**。
- `lib/careerAggregate/**` は production consumer から import されない（静的 guard で固定）。
- personal Event Signal（L2）とは **別 domain**。`CareerEventSignalSummary` を Layer 4 公開型に流用しない。

## First metric（PROVISIONAL）

- `feature_usage_prevalence` / 表示名「この時期の一般的な準備傾向」。
- 意味: cohort 内の eligible unique users のうち、対象 feature を月内に **1 回以上**利用した割合。
  利用回数ではない。能力・準備度・適性・合否を意味しない。個人比較に使わない。
- 入力 event_type: `feature_started` / `feature_completed`（実 enum に存在する値のみ）。
- 集計単位: **user-level boolean**（1 user × 1 month × 1 feature = 1）。
- numerator = 対象 feature を使った eligible unique users / denominator = cohort 内 eligible unique users（>0 必須）。

## Field allowlist / default deny

| 区分 | field |
|---|---|
| 直接許可 | `feature`, `event_type` |
| 変換後のみ | `occurred_at`→month bucket, `completion_status`→boolean（初期 metric では未使用） |
| 禁止 | `user_id`, hashed id, `client_event_id`, `id`, `created_at`, `company_id`, `score_band`, `weakness_category`, `next_action`, `metadata` 全体, `industry`, `job_type`, `selection_phase`, 自由記述/本文, matching score/ranking/readiness/success |

- projection は **default deny**（allowlist を明示コピー・raw spread なし・metadata 丸ごと不可・unknown key 破棄）。
- `user_id` は internal dedup 鍵、`client_event_id` は duplicate 判定にのみ使用し、**safe artifact へは残さない**。
- exact timestamp は artifact へ残さない（month のみ）。日・週も初期 pilot では不可。

## Consent scopes（Option C・段階的 opt-in）

`personal_service_processing` / `internal_aggregated_analytics` / `user_facing_aggregated_insight` /
`ai_context_aggregated_insight` / `externally_shared_insight` / `company_knowledge_contribution`（Layer 5・Layer 4 では常に非対象）。

- first insight の required scope = `user_facing_aggregated_insight`。AI context 用途は `ai_context_aggregated_insight`。
- eligibility は pure 判定（status / scope / version / grant・withdraw timestamp / account deletion / purpose 整合）。
- eligible 条件: required scope を明示 grant・version 一致・grant timestamp 存在・未撤回・未削除・
  event が grant 後かつ withdrawal 前・purpose 一致。
- personal processing / privacy notice 閲覧 / 利用規約包括同意 / opt-out / version mismatch /
  withdrawal 後 / account 削除 は ineligible。
- **通常機能は aggregate 同意なしで利用可能**（personal と aggregate を混同しない）。

## Cohort / suppression（全て PROVISIONAL）

- 閾値: absolute lower bound **10** / internal **20** / user-facing **50** / AI-context **100**（実データ・法務未確認）。
- first insight は user-facing = **50** を適用。判定は **unique-user 数**（event 数ではない）。
- 初期許可 dimension: `all` × month、`graduation_year`（単独）× month。
- 初期禁止 dimension: company / industry / job_type / selection_type / selection_stage / selection_phase /
  university / faculty / department / gender / score_band / 任意 metadata / 任意複合 dimension。
- suppression reason: below_absolute_minimum / below_audience_threshold / rare_category / prohibited_dimension /
  unsupported_dimension_intersection / unsafe_time_granularity / consent_ineligible / stale_source /
  incomplete_batch / invalid_calculation_version / quality_check_failed / complementary_suppression_required。
- fallback: 非表示 → 上位 cohort へ roll-up（graduation_year→all）→ 再判定 → なお不足なら数値を返さず一般文言のみ。
- **zero（eligible 0）と suppressed を型で区別**（zero variant / suppressed variant）。
- time bucket = month のみ。freshness delay 48h・週次 batch 想定。

## Contribution bounding

- 1 user × 1 month × 1 feature = 1 boolean。heavy user（100+ event）→ 1。
- duplicate / retry（同一 client_event_id）を二重計上しない。event count を user count にしない。
- bot / QA / internal account 除外を必須 policy 化。unknown event / unsupported feature 除外。sequence は未実装。

## Safe artifact / renderer

- 公開 field: metricKey / calculationVersion / feature / cohortType / coarse cohortValue / timeBucket(YYYY-MM) /
  numerator・denominator・prevalence・sampleSizeBucket（valid のみ）/ suppression / sourceWindow / generatedAt /
  expiresAt / consentScope / provenance / qualityStatus / disclaimerKey。
- **含めない**: user_id / hashed id / client_event_id / raw id / exact timestamp / raw metadata / company /
  score_band / raw row 逆参照 key。denominator 必須。suppressed は数値を持たない。
- sample size は生 count を出さず bucket（`50–99` / `100–199` / `200–499` / `500+`）。
- renderer: valid は一般傾向文 + 固定 disclaimer、suppressed / zero は neutral 文言、missing(null) は render しない。
  禁止表現（遅れ・不足・能力・合否・属性適性・比較・因果）を生成しない。

## Matching 完全非接続（恒久）

- aggregate ↔ matching の相互 import なし（静的 guard）。matching 変換 utility（score/ranking/readiness/
  success/candidate 等）を作らない。consumer capability で matching は `permanentlyProhibited=true`。

## Consumer capability boundary

- 将来条件付き許可: mypage / consultation / onboarding / notification / internal_analytics / ai_context。
- 初期禁止: es / interview / presentation / gd / company_research / self_analysis。
- 恒久禁止: matching。**P14-B では全 consumer `not_connected`**。

## 技術設計判断 と 法務確認事項の分離

- 上記は **技術設計判断**。以下は **法務確認事項（LEGAL_REVIEW_REQUIRED）**：明示 opt-in が必須となる範囲、
  匿名/仮名加工情報該当性、撤回前に作成済み aggregate の扱い、撤回後の寄与除去義務、account 削除後の再集計義務、
  retention 期間、未成年対応。**法令適合はコードで断定しない。**

## 今回未実装（明示）

consent DB / consent UI / privacy notice UI / aggregate DB / SQL / migration / RLS / cron / service-role batch /
production batch / aggregate API / fixed read model DB / consultation・mypage・onboarding・notification・AI・
matching 接続 / production monitor / account deletion 再集計 / withdrawal 再集計 / Layer 5 KB /
differential privacy / complementary suppression 自動適用。

## Synthetic QA（offline・実データ非使用）

`qa:careerAggregateSeries`（projection / consent / cohort / contribution / artifact / renderer /
privacy-attack / matching-guard）。privacy-attack QA は difference attack / multi-period comparison /
complementary inference を **KNOWN-GAP** として明示し、「防げている」と誤認させない。

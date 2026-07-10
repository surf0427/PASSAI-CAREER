# Consent Ledger / Withdrawal Foundation（P14-C 設計記録）

P14-A decision **C**（consent / cohort 基盤を先に作る）に基づき、P14-B（Aggregated Insight privacy
contract・commit `18978d9`）の後続として、**versioned append-only Consent Ledger** の domain model・
状態遷移・repository 契約・offline synthetic QA を **production 非接続**で固定した記録。

**P14-C の完了は同意取得機能の本番完成ではない。** 完成範囲は「scope・version・withdrawal・reconsent・
account deletion を安全に扱う production 非接続の Consent Ledger domain foundation」だけ。

関連: [aggregated_insight_privacy_contract.md](./aggregated_insight_privacy_contract.md)（P14-B）。

## 位置づけ / production 非接続

- 実装は `types/careerConsent.ts` と `lib/careerConsent/**`、QA は `scripts/career-consent-*-qa.ts`。
- **DB / SQL / migration / RLS / production repository / API / UI / privacy notice / settings /
  service-role / batch / aggregate DB / consultation・mypage・onboarding・notification・AI・matching 接続 /
  external sharing / Layer 5 / production monitor / 実データ backfill は作らない**。
- `lib/careerConsent/**` は production consumer から import されない（静的 guard で固定）。

## Append-only ledger（source of truth）

- mutable な現在値 boolean を唯一の真実にしない。**append-only event 列**が正、現在状態は reducer で導出。
- event の mutation / silent deletion / version 書換え / timestamp 書換えを禁止。訂正は将来 append-only
  correction event（repository 契約と docs 上の将来必須要件に留める）。
- event action: `consent_granted` / `consent_withdrawn` / `consent_reconfirmed` /
  `consent_policy_superseded` / `account_deletion_requested` / `account_deleted`。

## Scope independence / purpose limitation

各 scope（personal_service_processing / internal_aggregated_analytics / user_facing_aggregated_insight /
ai_context_aggregated_insight / externally_shared_insight / company_knowledge_contribution）は
**独立して grant / withdrawal** できる。user-facing 同意で AI-context を満たさない（別 version・別 scope）。
personal を aggregate consent に流用しない。**company_knowledge_contribution は Layer 5 境界**で
`usableInLayer4=false`（Layer 4 eligibility を決して満たさない）。

## Policy manifest / versioning

- scope 単位に `requiredVersion`（数値・P14-B の requiredVersion と整合）+ development 識別子
  （`p14c-dev-1` / AI は `p14c-dev-ai-1`）+ noticeVersion + purposeSummaryVersion + policyDigest +
  legalReview + optionality + supersededVersions を宣言。**全て PROVISIONAL / legalReview=REQUIRED**。
- current version のみ active。outdated / superseded 後 reconfirm なしは version_outdated（**自動昇格なし**）。
- UF と AI は別 version 系列で管理（混同しない）。

## Server-authoritative ordering / idempotency

- `serverSequence`（内部専用）が権威。client timestamp は権威にしない。同一 sequence・異なる payload は
  conflict → invalid_ledger。gap は許容。future effective timestamp は拒否。
- idempotency key = subject + scope + operation。same key/same payload=duplicate（二重化しない）、
  same key/different payload=conflict、key なし=conflict（server 検証前提）。P14-B の client_event_id とは別。

## State reducer

`never_granted` / `active` / `withdrawn` / `version_outdated` / `account_deletion_pending` /
`account_deleted` / `invalid_ledger`。active 条件: 有効 grant/reconfirm・required version 一致・
grant 後 withdrawal なし・account 正常・順序 valid・scope 一致・Layer 4 利用可。withdrawal 後の再同意で
active 復帰。account_deleted は terminal で削除後 grant を拒否、再登録は別 subject。

## Aggregate eligibility adapter

`Consent Ledger events → order validation → scope reducer → policy manifest 比較 → ledger-derived state
→ P14-B evaluateConsentEligibility`。**raw boolean を渡さない・default true なし**。missing/invalid/
version_outdated/withdrawn（event が withdrawal 後）/deleted/pending/scope mismatch/grant 前 event は
ineligible。P14-B の eligibility を置き換えず、ledger を入力 source にする明示 adapter。production
aggregate pipeline へは接続しない。

## Historical backfill（既定 prohibited）

grant 前 event を後から同意したことを理由に集計対象にしない（`granted_after_event`）。version mismatch
期間・withdrawal 期間中の event も ineligible。再同意後の event のみ再び eligible。implicit backfill 禁止。
明示的過去データ利用同意の法的可否は LEGAL REVIEW。

## Impact plans（技術 / 法務を分離）

- **Withdrawal**: 技術=future 停止・以降 event 除外・open bucket 再計算・cache 失効・(scope 別)AI/UF 停止。
  法務=closed aggregate からの寄与除去・過去表示・backup・匿名化済みへの撤回範囲。
- **Account deletion**: 技術=new grant 停止・全 scope inactive・future eligibility 停止・raw event 削除要求・
  open bucket 再計算・cache 失効・AI 停止・再登録は別 subject。法務=ledger retention・削除後の再集計義務・
  同意証跡保持・backup 削除・未成年。auth 削除 / source event 削除 / ledger 削除 / aggregate 再計算 /
  cache 失効 / backup / legal evidence 保持を混同しない。

## Consent receipt（本人向け）

public: scope / status / consentVersion / noticeVersion / grantedAt / withdrawnAt / lastUpdatedAt /
legalReviewStatus / currentPolicyVersion / reconsentRequired / normalFeaturesUnaffected(true)。
**含めない**: ledger event id / idempotency key / server sequence / raw user id / actor id / IP /
device fingerprint / raw policy text。

## Repository boundary

interface + in-memory（synthetic 専用）のみ。禁止: `setConsent(true/false)` を source of truth にする
mutable API / scope・version 省略 grant / client timestamp 権威 / history を消す API / public cross-user
read / aggregate から任意ユーザー ledger 直接閲覧。Supabase / browser / localStorage / service-role /
production adapter は **非実装**。

## Privacy / security rules

consent receipt は本人向け・cross-user 閲覧禁止 / consent を aggregate artifact へ含めない /
consent 有無を能力・準備度・利用不足として扱わない / 撤回を negative evidence にしない /
opt-out ユーザーを不利にしない / user id hash 化だけで匿名扱いしない / exact consent timestamp を
aggregate へ流さない / raw IP・device fingerprint を保存しない / consent copy は version/digest で管理 /
matching へ consent 状態を渡さない / Layer 4 consent と Layer 5 contribution を分離。

## 技術設計判断 と 法務確認事項の分離

- **技術確定**: scope 独立 / append-only ledger / version 管理 / withdrawal 後 future 停止 / grant 前
  event 非利用 / default-deny / missing=ineligible / deletion で future eligibility 停止 / 再計算可能な
  impact contract / source of truth=ledger / current state=derived。
- **法務確認（LEGAL_REVIEW_REQUIRED）**: 明示 opt-in 必須範囲 / 匿名・仮名加工情報該当性 / 必要な consent
  evidence 項目 / IP・user agent 保存要否 / withdrawal 前 aggregate からの寄与除去義務 / 削除後の再集計義務 /
  ledger retention / 削除後の同意証跡保持 / backup 削除 / 未成年 / policy 変更時の再同意 / internal と
  user-facing の法的差 / closed aggregate / external sharing / privacy notice・利用規約との整合。
  **法令適合はコードで断定しない。**

## 今回未実装（明示）

consent DB / Supabase table / SQL / migration / RLS / production repository / API / UI / consent banner /
settings / privacy notice / account deletion API / service role / batch / aggregate DB / aggregate API /
consultation・mypage・onboarding・notification・AI・matching 接続 / external sharing / Layer 5 /
production monitoring / production audit log / 実データ migration / 過去ユーザー backfill。

## Synthetic QA（offline・実データ非使用）

`qa:careerConsentSeries`（ledger / reducer / ordering / idempotency / eligibility-adapter / receipt /
impact / static-guard）。P14-B regression（`qa:careerAggregateSeries` / matching static guard /
Event Signal series / matching QA）は不変で通過。

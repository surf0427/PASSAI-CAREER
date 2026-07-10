# Consent / Aggregated Insight — Legal Decision Intake Package（P14-H）

> **状態: 回答待ち（BLANK）。** 本書は法務・プロダクト・セキュリティ責任者が記入・承認するための
> intake フォームである。AI・エンジニアは法的結論を代筆しない。空欄（`______` / `☐` / `UNANSWERED`）を
> 事前入力しない。未回答時に削除・保持・仮名化・`auth.users ON DELETE CASCADE` のいずれも既定採用しない。
>
> single source of truth。既存 consent docs（[consent_persistence_local_prototype.md](./consent_persistence_local_prototype.md) /
> [consent_ledger_foundation.md](./consent_ledger_foundation.md) / [aggregated_insight_privacy_contract.md](./aggregated_insight_privacy_contract.md)）を前提とする。

---

## 0. Executive Cover（非技術者向け）

- **対象システム**: PASSAI CAREER の同意台帳（Consent Ledger・未本番化）と匿名集計（Aggregated Insight / Layer 4・未接続）。
- **何を決める必要があるか**: 退会時の同意記録の扱い・証跡の最小項目と保持期間（起算点含む）・撤回後の確定済み集計の扱い・同意 scope ごとの opt-in・未成年対応・既に表示/共有済み集計出力の扱い。
- **なぜ production blocker か**: これらが同意台帳の subject 識別子（外部キー）と削除アーキテクチャ、schema を分岐させ、未確定では production schema を固定できず、本番の同意収集・集計を開始できない。
- **現在の No-Go 状態**: production schema=未確定 / production migration=No-Go / production consent collection=No-Go / aggregate 本番接続=No-Go / AI 接続=No-Go / **matching 接続=恒久 No-Go**。local prototype のみ維持・本番データ非収集。
- **回答方法**: 本書 §3 の Question ID 単位で「選択肢番号＋必須パラメータ」を記入し、§4 の承認欄に owner/approver/日付を記載する。選択肢番号だけ・「状況による」だけでは回答完了とみなさない。retention は**期間と起算点の両方**が必須。
- **未回答時の扱い**: default を採用しない。UNANSWERED を維持し production は No-Go のまま。

| 役割 | 氏名 | 承認日 |
|---|---|---|
| Legal owner | ______ | ______ |
| Product owner | ______ | ______ |
| Security owner | ______ | ______ |
| Engineering owner（受領確認のみ） | ______ | ______ |

- **回答期限**: ______
- **document version**: p14h-intake-v1（BLANK）
- **approval date**: ______
- **review date**: ______

---

## 1. 記入ルール（回答者向け）

- 選択肢番号だけでなく必須 parameter も記入する。
- 「状況による」のみは回答完了にならない。
- retention は**期間**と**起算点**の両方が必要。
- approval と review comment を区別する。provisional と final を区別する。
- 複数選択時は適用条件を記載する。
- legal / product / security の共同承認が必要な項目は全員分を記載する。
- 以前の回答を変更する場合は supersedes 対象を記載する。
- meeting note の場合は参加者と承認箇所、email/Slack 転記の場合は送信者・日時・文脈・承認表現を残す。
- engineering suggestion は decision owner が承認しない限り正式決定ではない。

---

## 2. Priority

**P0（production architecture を直接 block・全件回答必須）**: L01 / L03 / L05 / L10 / L12 / L16。
P1: L02 / L04 / L06 / L07 / L08 / L09 / L11 / product 主要 / security 権限分離。
P2–P3: L13–L20 / backup 値 / minor UX 詳細。

---

## 3. Required Decision Form

### 3-A. Legal Questions（L01–L20）

#### ★L01 — Ledger deletion（P0）
退会・アカウント削除時に consent ledger をどう扱うか。
- 選択肢: (a) delete all / (b) retain minimum evidence / (c) pseudonymize / (d) move-or-copy minimum evidence to separate store / (e) その他: ______
- 必須追加回答: legal hold 例外=______ / dispute 対応=______ / account recreation 時=______ / backup 上の扱い=______ / 最小保持 field=______ / 保持期間=______ / 起算点=______
- selected: ______ / owner(legal): ______ / approval ☐ / effective: ______

#### ★L03 — Retention（期間＋起算点）（P0）
下記 §3-D の retention 表（data type ごとに duration / start event / deletion method / legal hold / owner / approval）を全欄記入。
- selected: 表参照 / owner(legal): ______ / approval ☐

#### ★L05 — Closed aggregate（P0・ケース別・番号厳守）
撤回/削除後、既に closed の集計 bucket をどう扱うか。**選択肢番号（1=immutable historical / 2=contribution subtraction / 3=full rebuild / 4=suppress future display only / 5=legal hold exception / 6=DP・noise 適用後は変更不要 / 7=minimum cohort breach 時のみ invalidate）**。一括回答不可。

| ケース | 選択(1–7) | 条件 | owner | approval |
|---|---|---|---|---|
| internal aggregate | ______ | ______ | ______ | ☐ |
| user-facing aggregate | ______ | ______ | ______ | ☐ |
| already-displayed output | ______ | ______ | ______ | ☐ |
| cached output | ______ | ______ | ______ | ☐ |
| export 済み output | ______ | ______ | ______ | ☐ |
| third-party delivery 済み | ______ | ______ | ______ | ☐ |
| open bucket | ______ | ______ | ______ | ☐ |
| closed bucket | ______ | ______ | ______ | ☐ |
| minimum cohort を下回る場合 | ______ | ______ | ______ | ☐ |
| DP/noise 適用済み | ______ | ______ | ______ | ☐ |
| legal hold 中 | ______ | ______ | ______ | ☐ |

#### ★L10 — Consent scopes（P0・scope 別）
scope ごとに opt-in/default/bundled 等を記入。

| scope | separate opt-in 要 | default on/off | bundled 可 | withdrawal 単位 | reconsent trigger | normal feature 影響 | legal ☐ | product ☐ |
|---|---|---|---|---|---|---|---|---|
| anonymous aggregate contribution | ______ | ______ | ______ | ______ | ______ | ______ | ☐ | ☐ |
| aggregate-based user-facing insight | ______ | ______ | ______ | ______ | ______ | ______ | ☐ | ☐ |
| internal product analytics | ______ | ______ | ______ | ______ | ______ | ______ | ☐ | ☐ |
| future AI improvement | ______ | ______ | ______ | ______ | ______ | ______ | ☐ | ☐ |
| third-party sharing | ______ | ______ | ______ | ______ | ______ | ______ | ☐ | ☐ |
| research use | ______ | ______ | ______ | ______ | ______ | ______ | ☐ | ☐ |
| new purpose 追加時 | ______ | ______ | ______ | ______ | ______ | ______ | ☐ | ☐ |

> 未回答時は production consent collection = No-Go。

#### ★L12 — Minors（P0）
年齢を確定できない現行 profile（生年月日 field なし・`graduationYear` は不確実 proxy）で未成年をどう扱うか。
- 選択肢: M1 年齢取得なし・全ユーザー同一 consent / M2 age gate 追加 / M3 未成年を aggregate contribution から除外 / M4 guardian consent 導入 / M5 対象機能を未成年利用不可
- 必須追加回答: 対象年齢=______ / 年齢確認方法=______ / `graduationYear` を年齢証明に使ってよいか=______ / 年齢不明時=______ / guardian verification=______ / existing user への適用=______ / deletion・withdrawal=______ / UI 説明=______ / legal owner=______ / product owner=______
- selected: ______ / approval(legal) ☐ / approval(product) ☐
> **M1 を default 採用しない。** `graduationYear` を明示承認なしに年齢判定へ使用しない。

#### ★L16 — Already-displayed outputs（P0・対象別）
撤回/削除前に提示・export・共有済みの集計出力を後でどうするか。

| 対象 | 選択（変更しない/future停止/cache invalidate/再計算/export不可説明/third-party別workflow/legal hold/他） | owner | approval |
|---|---|---|---|
| current UI | ______ | ______ | ☐ |
| cached UI | ______ | ______ | ☐ |
| saved report | ______ | ______ | ☐ |
| downloaded export | ______ | ______ | ☐ |
| email delivery | ______ | ______ | ☐ |
| third-party delivery | ______ | ______ | ☐ |
| internal analytics | ______ | ______ | ☐ |
| support screenshot/record | ______ | ______ | ☐ |

#### L02 — 保持許可時の最小 evidence field（P1）
各 field を 必要/不要/optional で記入: action=__ / scope=__ / consent_version=__ / notice_version=__ / purpose_version=__ / policy_digest=__ / effective_at=__ / recorded_at=__ / actor_type=__ / source_surface=__ / correction_relation=__ / legal_review_marker=__ / subject_identifier=__ / server_sequence=__ / payload_digest=__ / idempotency_key=__。 owner(legal): ______ / approval ☐

#### L04 — pseudonymized evidence の可否（P1）: ______ / legal ☐
#### L06 — backups（削除反映時点/restore re-delete/tombstone list/crypto-shred/retention/legal hold/recovery test/user 説明）（P1）: ______ / legal ☐ / security ☐
#### L07 — logs の保持（server/audit/error/security、subject ID・idempotency・digest の可否、IP/UA 禁止維持、retention、access）（P1）: ______ / security ☐ / legal ☐
#### L08 — idempotency record の保持期間（P1）: ______ / 起算点 ______ / owner ______ / approval ☐
#### L09 — policy version 変更時の reconsent（変更タイプ別・下記 §3-E）（P1）
#### L11 — normal feature 利用と consent の分離の適法性（P1）: ______ / legal ☐
#### L13 — legal hold の適用範囲・手続（P2）: ______ / legal ☐ / security ☐
#### L14 — data access request で ledger を開示するか（P2）: ______ / legal ☐
#### L15 — receipt と raw ledger の開示差（P2）: ______ / legal ☐
#### L17 — account recreation 時に旧 ledger を関連付けるか（P2）: ______ / legal ☐
#### L18 — policy rollback semantics（active version 一意性との整合）（P2）: ______ / legal ☐
#### L19 — cross-border hosting/processing の有無と扱い（P2）: ______ / legal ☐
#### L20 — security incident 時の evidence 保持（P2）: ______ / legal ☐ / security ☐

### 3-B. Product Questions（P01–P15）
P01 consent 取得タイミング / P02 scope 別 toggle / P03 default off / P04 未付与でも normal features 維持 / P05 withdrawal UX / P06 account deletion UX / P07 receipt 表示 / P08 reconsent banner / P09 benefit 説明 / P10 deletion 完了通知 / P11 pending deletion 表示 / P12 support escalation / P13 minor user UX / P14 beta・research pilot 表示 / P15 historical aggregate 表示。
各: 回答=______ / product owner=______ / approval ☐。

### 3-C. Security Questions（S01–S15）
S01 consent writer role / S02 aggregate batch role / S03 deletion worker role / S04 policy publisher role / S05 legal hold role / S06 support role / S07 break-glass 手続 / S08 subject linkage store access / S09 encryption・key management / S10 crypto-shredding / S11 audit log / S12 log retention / S13 backup retention / S14 restore testing / S15 live RLS QA owner ＆ incident response owner。
各: 回答=______ / security owner=______ / approval ☐。「service_role を使う」だけでは不可（権限分離・access scope・audit が必要）。

### 3-D. Retention Table（L03）

| data | duration | start event | deletion method | legal hold | owner | approval |
|---|---|---|---|---|---|---|
| consent events | ______ | ______ | ______ | ______ | ______ | ☐ |
| policy manifest | ______ | ______ | ______ | ______ | ______ | ☐ |
| idempotency records | ______ | ______ | ______ | ______ | ______ | ☐ |
| withdrawal outbox | ______ | ______ | ______ | ______ | ______ | ☐ |
| deletion workflow records | ______ | ______ | ______ | ______ | ______ | ☐ |
| application logs | ______ | ______ | ______ | ______ | ______ | ☐ |
| security logs | ______ | ______ | ______ | ______ | ______ | ☐ |
| legal evidence | ______ | ______ | ______ | ______ | ______ | ☐ |
| linkage table | ______ | ______ | ______ | ______ | ______ | ☐ |
| encryption keys | ______ | ______ | ______ | ______ | ______ | ☐ |
| backups | ______ | ______ | ______ | ______ | ______ | ☐ |
| caches | ______ | ______ | ______ | ______ | ______ | ☐ |
| eligibility projection | ______ | ______ | ______ | ______ | ______ | ☐ |
| open aggregates | ______ | ______ | ______ | ______ | ______ | ☐ |
| closed aggregates | ______ | ______ | ______ | ______ | ______ | ☐ |
| generated outputs | ______ | ______ | ______ | ______ | ______ | ☐ |
| support records | ______ | ______ | ______ | ______ | ______ | ☐ |
| billing records | ______ | ______ | ______ | ______ | ______ | ☐ |

> 期間・起算点の空欄を推測で埋めない。policy manifest（非個人）以外は回答なしに確定不可。

### 3-E. Reconsent Table（L09）

| 変更タイプ | reconsent 要否 | 既存 consent 有効 | manifest 操作 | owner | approval |
|---|---|---|---|---|---|
| typo | ______ | ______ | ______ | ______ | ☐ |
| wording | ______ | ______ | ______ | ______ | ☐ |
| clarification | ______ | ______ | ______ | ______ | ☐ |
| purpose expansion | ______ | ______ | ______ | ______ | ☐ |
| new aggregate use | ______ | ______ | ______ | ______ | ☐ |
| new AI use | ______ | ______ | ______ | ______ | ☐ |
| new third-party sharing | ______ | ______ | ______ | ______ | ☐ |
| security wording | ______ | ______ | ______ | ______ | ☐ |
| rollback | ______ | ______ | ______ | ______ | ☐ |
| scope 追加 | ______ | ______ | ______ | ______ | ☐ |

---

## 4. Approval & Evidence Form（回答 1 件ごとに複製して使用）

Question ID: ______ / selected option: ______ / parameters: ______ / rationale: ______ / conditions: ______ / exclusions: ______ / applicable scope: ______ / decision owner name: ______ / decision owner role: ______ / approver name: ______ / approver role: ______ / approval status: ______ / approval date: ______ / effective date: ______ / expiry・review date: ______ / source document: ______ / source version: ______ / supersedes: ______ / legal approval: ______ / product approval: ______ / security approval: ______ / engineering acknowledgement: ______ / unresolved notes: ______。

> チェックボックス事前選択・owner 名・日付・承認状態を埋めない。

---

## 5. Decision Register（現状スナップショット）

| Question ID | Decision | Parameters | Owner | Approver | Approval | Effective | Evidence | Authenticity | Conflict | Final status |
|---|---|---|---|---|---|---|---|---|---|---|
| L01–L20 | — | — | — | — | — | — | — | ABSENT | — | **UNANSWERED** |
| P01–P15 | — | — | — | — | — | — | — | ABSENT | — | **UNANSWERED** |
| S01–S15 | — | — | — | — | — | — | — | ABSENT | — | **UNANSWERED** |

External input=0 / identified owner=0 / FINAL=0 / PROVISIONAL=0 / PARTIAL=0 / CONFLICTING=0 / UNAUTHENTICATED=0 / UNANSWERED=50。

## 6. P0 Completeness Matrix

| P0 | answer | option | params | owner | approval | effective | evidence | conflict | scope | co-approval | FINAL_COMPLETE |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L01 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | ✗ | ✗ | **NO** |
| L03 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | ✗ | ✗ | **NO** |
| L05 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | ✗ | ✗ | **NO** |
| L10 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | ✗ | ✗ | **NO** |
| L12 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | ✗ | ✗ | **NO** |
| L16 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | ✗ | ✗ | **NO** |

**P0 FINAL_COMPLETE = 0 / 6 → Architecture Resolution Gate = STOP。**

## 7. Contradiction Register

回答 0 件のため矛盾監査は未実行（N/A）。回答受領時に必ず突合する**潜在衝突ペア**（現時点で発生も解消もしていない）: ledger 削除⇔evidence 保持 / 即時削除表示⇔backup expiry / pseudonymize⇔support 再特定 / idempotency 削除⇔retry / closed immutable(1)⇔withdrawal 反映 / normal features unaffected⇔UI 実質強制 / default off⇔bundled / age 不要⇔guardian 必要 / purpose expansion⇔reconsent 不要 / rollback⇔active 一意性 / raw 非公開⇔access request 開示 / legal hold⇔完全削除 SLA / recreation unlink⇔receipt 復元 / IP 禁止⇔security log IP / direct ID 削除⇔「完全匿名化」/ crypto-shred⇔restore / linkage 短期削除⇔support 期間 / closed rebuild⇔reproducibility / export 不可⇔完全削除表示 / minor 除外⇔年齢非取得。

## 8. Targeted Follow-up（現状＝全 P0 未回答）

| Question ID | 現在の回答 | 不足情報 | 必要回答者 | 必要承認者 | production block 箇所 | 期限 |
|---|---|---|---|---|---|---|
| L01 | UNANSWERED | option + 最小 field + 期間 + 起算点 | legal | legal(+security for backup) | subject FK / deletion arch / schema | ______ |
| L03 | UNANSWERED | data 別 duration + 起算点 + 削除方式 | legal | legal | retention job / schema | ______ |
| L05 | UNANSWERED | ケース別 option(1–7) | legal | legal(+product for display) | outbox / aggregate handling | ______ |
| L10 | UNANSWERED | scope 別 opt-in/default/bundled | legal+product | legal+product | consent collection | ______ |
| L12 | UNANSWERED | M 選択 + 年齢方針 | legal+product | legal+product | consent collection | ______ |
| L16 | UNANSWERED | 対象別処理 | legal+product | legal+product | withdrawal/deletion 反映 | ______ |

→ 本書を decision owners（legal / product / security）へ送付し、§3 を記入・§4 で承認のうえ返送すること。

# Consent Decision — Owner Routing / P0 Collection Dispatch Readiness（P14-H3）

> **目的**: [consent_legal_decision_intake.md](./consent_legal_decision_intake.md)（single source of truth・全50問 UNANSWERED）を
> 実際の decision owner へ送付・回答依頼できる状態にする routing 文書。
> **本書は回答を生成・選択しない。** owner 名・contact・日付は捏造せず placeholder（`[...]`）を維持する。
> Question 本文・選択肢は複製せず Question ID で参照する。未回答 default（cascade / 保持 / 仮名化 / M1）は採用しない。
> L05 の option 番号は immutable=1（Intake §3-A L05 準拠）。retention は期間＋起算点の両方が必須。matching 接続は恒久 No-Go。

関連 commit: P14-H `d2b8c51` / P14-E `e2dd093`。

---

## 1. Existing Intake Assessment

- source of truth: `consent_legal_decision_intake.md`（重複作成しない）。
- Question coverage: Legal L01–L20 / Product P01–P15 / Security S01–S15 = 50。
- current response status: 全50問 **UNANSWERED**、P0 FINAL_COMPLETE = 0/6。
- duplication risk: 本 routing 文書は Question ID を参照するのみ（本文・選択肢を複製しない）。

---

## 2. Owner Routing Matrix（routing 案・正式承認ではない）

分類は「誰に依頼するかの提案」であり、承認そのものではない。Engineering acknowledgement は decision approval ではない。

### Legal（L01–L20・primary=Legal）

| Q | topic（ID参照のみ） | joint approval |
|---|---|---|
| L01 | ledger deletion | Legal + Security + Product |
| L02 | min evidence fields | Legal + Security |
| L03 | retention | Legal + Security (+Product: 表示SLA) |
| L04 | pseudonymized evidence | Legal + Security |
| L05 | closed aggregate | Legal + Product + Security |
| L06 | backups | Legal + Security |
| L07 | logs | Legal + Security |
| L08 | idempotency retention | Legal + Security |
| L09 | reconsent | Legal + Product |
| L10 | consent scopes | Legal + Product + Security |
| L11 | normal-feature 分離 | Legal + Product |
| L12 | minors | Legal + Product (+Security: guardian verify) |
| L13 | legal hold | Legal + Security |
| L14 | access request 開示 | Legal (+Product: UX) |
| L15 | receipt vs raw 開示差 | Legal (+Product) |
| L16 | already-displayed outputs | Legal + Product + Security |
| L17 | account recreation link | Legal (+Product) |
| L18 | policy rollback | Legal (+Engineering ack) |
| L19 | cross-border | Legal + Security |
| L20 | incident evidence | Legal + Security |

### Product（primary=Product）

全ID: P01 / P02 / P03 / P04 / P05 / P06 / P07 / P08 / P09 / P10 / P11 / P12 / P13 / P14 / P15（内容は Intake §3-B 参照）。
共同承認が要る主なもの: P09 / P13 / P15 → **Product + Legal**、P12 → **Product + Security**。他（P01/P02/P03/P04/P05/P06/P07/P08/P10/P11/P14）は Product only（Engineering は実装影響の input のみ）。

### Security（primary=Security）

全ID: S01 / S02 / S03 / S04 / S05 / S06 / S07 / S08 / S09 / S10 / S11 / S12 / S13 / S14 / S15（内容は Intake §3-C 参照）。
共同承認が要る主なもの: S05 / S09 / S10 / S12 / S13 → **Security + Legal**。他（S01/S02/S03/S04/S06/S07/S08/S11/S14/S15）は Security only。

### Joint approval 区分の凡例

Legal only / Product only / Security only / Legal+Product / Legal+Security / Product+Security / Legal+Product+Security / Engineering acknowledgement only（＝承認ではない）。

---

## 3. P0 Routing Matrix（最優先6問・回答/推奨 option は記入しない）

| Question ID | Decision topic | Primary owner role | Required co-approvers | Engineering input needed | Required parameters（Intake 参照） | Blocking target | Current status |
|---|---|---|---|---|---|---|---|
| L01 | ledger deletion | Legal | Security, Product | 実装可能性のみ | option(delete/retain/pseudonymize/store) + 最小field + 保持期間 + **起算点** + legal hold + dispute + recreation + backup | subject FK / deletion arch / schema | UNANSWERED |
| L03 | retention | Legal | Security (+Product SLA) | cleanup job 影響のみ | data 別 duration + **start event** + deletion method + legal hold + owner | retention job / schema | UNANSWERED |
| L05 | closed aggregate | Legal | Product, Security | open/closed bucket 実装影響のみ | ケース別 option 1–7（immutable=1） | outbox / aggregate handling | UNANSWERED |
| L10 | consent scopes | Legal | Product, Security | manifest/eligibility/UI 影響のみ | scope 別 opt-in/default/bundled/withdrawal unit/reconsent trigger/normal-feature 影響 | consent collection | UNANSWERED |
| L12 | minors | Legal | Product (+Security) | age field/eligibility 影響のみ | M1–M5 + 対象年齢 + 確認方法 + 年齢不明時 + guardian verify + existing user + UI | consent collection | UNANSWERED |
| L16 | already-displayed outputs | Legal | Product, Security | 再表示停止/再計算 実装影響のみ | 対象別（UI/cache/report/export/email/third-party/analytics/support）処理 | withdrawal/deletion 反映 | UNANSWERED |

> 役割分担は routing 案として記録し、正式承認とは扱わない。Engineering は「実装可能性・技術影響」の input のみで、decision approval ではない。

---

## 4. Owner Assignment Register

| Role | Assigned person | Organization / team | Authority confirmed | Confirmation source | Contact method | Status |
|---|---|---|---|---|---|---|
| Legal decision owner | `[未割当]` | `[未割当]` | No | — | — | UNASSIGNED |
| Product decision owner | `[未割当]` | `[未割当]` | No | — | — | UNASSIGNED |
| Security decision owner | `[未割当]` | `[未割当]` | No | — | — | UNASSIGNED |
| Engineering acknowledgement owner | `[未割当]` | `[未割当]` | No | — | — | UNASSIGNED |

> 名前を推測入力しない。git metadata / commit author / AI 指示者 / document 作成者を owner 認定しない。正式割当が未入力の間は UNASSIGNED を維持。

---

## 5. Role-specific Request Packages（要約・本文は Intake 参照）

- **Legal request**: primary=L01–L20。最優先=P0（L01/L03/L05/L10/L12/L16）。共同承認が要る項目は §2 表参照。回答は「選択肢番号＋必須 parameter」、retention は期間＋起算点、provisional/final を明示、approval status / approval date / effective date / source・rationale を記載。法的結論・推奨回答は本書に記載しない。
- **Product request**: P01–P15 + P0 のうち Product 共同承認（L05/L10/L12/L16）。normal-feature 影響 / default・toggle・bundled / withdrawal・deletion 表示 / minor UX / historical aggregate 表示。provisional/final 区別。owner を推測しない。
- **Security request**: S01–S15 + P0 のうち Security 共同承認（L01/L03/L05/L10/L16 等）。writer / deletion worker / aggregate batch / linkage access / key management / crypto-shred / audit logs / backup・restore / break-glass / RLS QA / incident response。「service_role を使う」だけでは回答完了にならない（権限分離・access scope・audit が必要）。

---

## 6. Dispatch Messages（貼付用・placeholder 維持）

### 6-A. Legal 向け

```
宛先: [Legal decision owner name]（役割: [Legal owner role]）
件名: 【要回答・法務判断依頼】PASSAI CAREER 同意台帳・匿名集計の意思決定（P0優先）

お世話になっております。PASSAI CAREER の同意台帳（Consent Ledger・未本番化）と匿名集計（Layer 4・未接続）の
production 化に必要な法務判断をお願いします。現在これらは全て No-Go（本番未接続）で、下記の意思決定が
確定するまで本番の同意収集・集計を開始しません。

参照文書: docs/career/consent_legal_decision_intake.md（Question ID 単位の記入フォーム）
最優先(P0): L01 台帳削除 / L03 保持期間 / L05 確定済み集計の撤回時扱い / L10 同意scope / L12 未成年 / L16 提示済み出力
その他: L02,L04,L06–L09,L11,L13–L15,L17–L20

回答方法:
- 各 Question ID について「選択肢番号＋必須パラメータ」を記入してください（選択肢番号だけ・「状況による」だけでは回答完了になりません）。
- 保持期間(L03)は「期間」と「起算イベント」の両方を記載してください。
- L05 の選択肢番号は immutable=1 を含む 1〜7 を使用し、ケース別に回答してください。
- L12 は M1〜M5 から選択してください（年齢取得なし=M1 を既定にはできません。graduationYear は年齢証明に使えません）。
- Product / Security との共同承認が必要な項目があります（文書内 routing 参照）。
- 暫定回答(provisional)は、その旨を明示いただければ受け付けます（最終=final と区別してください）。
- 回答者名・役割・承認状態・承認日/発効日・判断理由(rationale)・根拠文書を各回答に付してください。
- 未回答欄は空欄のまま返却して構いません。エンジニア側で内容を補完することはしません。

返却先: [返却先]
回答期限: [回答期限]
```

### 6-B. Product 向け

```
宛先: [Product decision owner name]（役割: [Product owner role]）
件名: 【要回答・プロダクト判断依頼】PASSAI CAREER 同意 UX / 表示方針

参照文書: docs/career/consent_legal_decision_intake.md
対象: P01–P15（取得タイミング / scope toggle / default off / normal features 維持 / withdrawal・deletion UX /
receipt 表示 / reconsent banner / benefit 説明 / pending 表示 / support escalation / minor UX / beta / historical aggregate 表示）
P0 共同承認: L05 / L10 / L12 / L16（法務主導・プロダクト共同承認）

回答方法:
- 各項目に方針を記載し、provisional / final を明示してください。
- 回答者名・役割・承認状態・承認日/発効日を付してください。
- 未回答欄は空欄で構いません。エンジニアは補完しません。

返却先: [返却先] ／ 回答期限: [回答期限]
```

### 6-C. Security 向け

```
宛先: [Security decision owner name]（役割: [Security owner role]）
件名: 【要回答・セキュリティ判断依頼】PASSAI CAREER 同意台帳 権限分離 / 鍵管理

参照文書: docs/career/consent_legal_decision_intake.md
対象: S01–S15（writer / aggregate batch / deletion worker / policy publisher / legal hold / support role /
break-glass / linkage store access / key management / crypto-shred / audit log / log retention /
backup retention / restore testing / RLS QA・incident response）
P0 共同承認: L01 / L03 / L05 / L10 / L16（法務主導・セキュリティ共同承認）

回答方法:
- 「service_role を使う」だけでは回答完了になりません。権限分離・access scope・audit を明記してください。
- provisional / final を区別し、回答者名・役割・承認状態・承認日/発効日を付してください。
- 未回答欄は空欄で構いません。エンジニアは補完しません。

返却先: [返却先] ／ 回答期限: [回答期限]
```

---

## 7. Dispatch Checklist（送付前・現状は owner 未割当のため未完）

| 項目 | 状態 |
|---|---|
| owner が割り当てられている | ✗（UNASSIGNED） |
| owner の承認権限を確認した | ✗ |
| 正しい role 別 request を使用 | ✓（§5/§6） |
| P0 6問が最優先として明示 | ✓ |
| Question ID が正しい | ✓（L01–L20/P01–P15/S01–S15） |
| L05 immutable=option 1 | ✓ |
| retention に期間＋起算点が必要と明記 | ✓ |
| M1 が default ではない | ✓ |
| graduationYear を年齢証明にしない | ✓ |
| provisional/final 欄がある | ✓ |
| approval date / effective date 欄 | ✓ |
| source / rationale 欄 | ✓ |
| confidentiality 確認欄 | ✓（§9/§10） |
| repo 保存可否欄 | ✓（§10） |
| 返却先が記載 | ✗（placeholder） |
| 回答期限が記載 | ✗（placeholder） |
| engineering が補完しない旨 | ✓ |

## 8. Response Intake Checklist（回答受領時・P14-H2 再監査の入力準備）

回答者名 / 回答者役割 / decision authority / Question ID / selected option / required parameters / conditions /
approval status / approver / approval date / effective date / source traceability / applicable scope /
co-approval / conflict / supersedes / confidentiality / storage permission / P0 completeness。

## 9. 回答返却形式・命名規則・機密取扱い

- 推奨返却形式: 記入済み `consent_legal_decision_intake.md` / Question ID 付き回答表 / 承認済み meeting notes / signed decision record / email・Slack 承認記録の保存文書。
- 機密を含まない回答を repo 保存する場合の命名: `consent_decision_response_{legal|product|security|joint}_YYYY-MM-DD.md`。
- **法務 privilege・個人情報を含む原文は repo へ保存しない。** その場合は secure source ID / title / version / received date / owner role / approval status / applicable Question IDs / storage location reference / redacted summary / `repo storage prohibited` のみを Decision Register へ記録。secure location を勝手に生成しない（未指定なら `source storage unresolved`）。

## 10. Collection Status（Question ID 単位）

現在、実際の送付証跡がないため **全50問 = NOT_SENT**（docs 作成のみでは SENT にしない・送付日/受領日を捏造しない）。
使用状態: NOT_SENT / SENT / RECEIVED / NEEDS_CLARIFICATION / PROVISIONAL / APPROVED / REJECTED / SUPERSEDED。

| 状態 | 件数 |
|---|---|
| NOT_SENT | 50 |
| SENT / RECEIVED / NEEDS_CLARIFICATION / PROVISIONAL / APPROVED / REJECTED / SUPERSEDED | 0 |

---

## 11. 次の実作業（Claude ではなく人間）

1. §4 の owner を正式に割当（承認権限を confirmation source 付きで確認）。
2. §6 の依頼文面の placeholder（owner 名 / 返却先 / 期限）を埋めて送付。
3. §8/§9 の形式で回答を回収。
4. 回答受領後にのみ `P14-H2: Consent External Decision Intake Review / Approval Completeness Gate` を再実行。

**owner 未割当でも本 phase は失敗ではない**（routing preparation=complete / owner assignment=pending / actual dispatch=not performed / external response=absent / P14-H2 re-audit=not ready / P14-I entry=STOP）。

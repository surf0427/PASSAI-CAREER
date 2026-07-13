# Data Spine — P17-B Decision Register / ADR draft

本ドキュメントは **production 接続前に確定が必要な未決定事項** を記録する。
コード内では一切仮決定しない（policy 値はすべて `PROVISIONAL` として型/policy に分離済み）。

Status 凡例:

- `OPEN` — 設計判断が未確定（Claude Code + ユーザーで詰められる）
- `USER_DECISION_REQUIRED` — プロダクト/事業判断（ユーザー確定が必要）
- `SUPABASE_DECISION_REQUIRED` — Supabase project / identity の確定が必要
- `BLOCKED_BY_LEGAL` — 法務確認が必要（コード/運用で断定しない）

各項目: id / topic / status / options / recommended default / risk / owner / required before phase / evidence needed / prohibited assumption。

---

## DEC-01 — Supabase project / identity 統合
- **status**: SUPABASE_DECISION_REQUIRED
- **options**: (a) 単一 shared project に統合 / (b) CAREER 専用 project へ分離 / (c) 現状維持（split-brain）
- **recommended default**: (a) 短期は shared 単一運用、(b) を将来目標として bridge を設計
- **risk**: L4 feedstock（`career_user_events`=shared）と L2 memory（CAREER project）が別 auth.uid() 空間。誤結合で identity 不整合
- **owner**: ユーザー + インフラ
- **required before phase**: H（限定 production 接続）
- **evidence needed**: 現行 env の実 project 対応、GD `roomAuth` 移行コスト
- **prohibited assumption**: 「cross-project user_id が安定 join 鍵」と仮定しない

## DEC-02 — Layer 4 aggregate table 配置先
- **status**: SUPABASE_DECISION_REQUIRED（DEC-01 従属）
- **options**: shared project / CAREER project / 別 analytics schema
- **recommended default**: feedstock と同一 project（現状 shared）
- **risk**: feedstock と別 project だと watermark / lineage が跨り整合困難
- **required before phase**: H
- **prohibited assumption**: 配置先未確定のまま migration を書かない

## DEC-03 — Layer 5 company knowledge table 配置先
- **status**: SUPABASE_DECISION_REQUIRED
- **options**: CAREER project / 専用 KB project
- **recommended default**: CAREER project（identity と moderation 運用を集約）
- **risk**: private research（shared 側）と混同する配置は禁止
- **required before phase**: H
- **prohibited assumption**: private research と同一 table に混ぜない

## DEC-04 — cross-project join 禁止 or identity bridge
- **status**: SUPABASE_DECISION_REQUIRED
- **options**: (a) cross-project join 全面禁止 / (b) opaque bridge id を発行
- **recommended default**: (a) 禁止。必要時のみ opaque bridge
- **risk**: 生 user_id の cross-project 露出は再識別リスク
- **required before phase**: H
- **prohibited assumption**: auth.uid() をそのまま bridge に使わない

## DEC-05 — cohort threshold（最小 cohort size）
- **status**: BLOCKED_BY_LEGAL
- **options**: absolute 10 / user-facing 50 / ai-context 100（現 PROVISIONAL）
- **recommended default**: 現 PROVISIONAL 値を実データ分布で検証後に確定
- **risk**: 小さすぎると再識別、大きすぎると常時 suppressed
- **owner**: 法務 + データ
- **required before phase**: H
- **evidence needed**: 実 cohort 分布、差分/complementary 攻撃シミュレーション
- **prohibited assumption**: PROVISIONAL 値を「安全確定値」と扱わない

## DEC-06 — retention（保持期間）
- **status**: BLOCKED_BY_LEGAL
- **options**: 選考年度+N年 / 無期限履歴 / 匿名化後のみ長期
- **risk**: 過長保持は privacy リスク、過短は履歴価値喪失
- **required before phase**: H
- **prohibited assumption**: retention をコードで固定しない（`AGGREGATE_TTL_HOURS` は cache 失効であって retention ではない）

## DEC-07 — revoke / delete propagation SLA
- **status**: BLOCKED_BY_LEGAL
- **options**: invalidate<24h / regenerate<72h（現 PROVISIONAL）
- **recommended default**: PROVISIONAL を法務要件に合わせて確定
- **required before phase**: H
- **prohibited assumption**: `PROPAGATION_SLA` を確定 SLA と扱わない

## DEC-08 — explicit-share consent text
- **status**: BLOCKED_BY_LEGAL
- **options**: 用途別 opt-in / 包括同意
- **recommended default**: 用途別 opt-in（`company_knowledge_contribution` scope）
- **risk**: 不十分な同意文言は共有の適法性を損なう
- **required before phase**: G/H
- **prohibited assumption**: consent 文言をコードで確定しない（`permittedUses`/`prohibitedUses` は PROVISIONAL）

## DEC-09 — commercial utilization scope
- **status**: USER_DECISION_REQUIRED + BLOCKED_BY_LEGAL
- **options**: 非商用のみ / 匿名集計の商用可 / 全面
- **recommended default**: 当面 `commercial_resale` は prohibited に固定（default deny）
- **required before phase**: G
- **prohibited assumption**: 明示同意なく商用利用しない

## DEC-10 — 未成年寄与者の扱い
- **status**: BLOCKED_BY_LEGAL
- **options**: 除外 / 保護者同意必須 / 匿名集計のみ
- **required before phase**: G/H
- **prohibited assumption**: 未成年判定・同意要件をコードで断定しない

## DEC-11 — confidentiality definition（秘密情報の定義）
- **status**: BLOCKED_BY_LEGAL
- **options**: NDA/社外秘/内部限定の明示表現に加え、業界別基準
- **recommended default**: 現 offline scanner（明示 marker + PII）を fail-closed の下限とし、法務で拡張
- **risk**: 定義不足で企業秘密が流出
- **required before phase**: G/H
- **prohibited assumption**: offline scanner を「完全な機密判定」と主張しない

## DEC-12 — 企業からの削除依頼 / takedown
- **status**: OPEN + BLOCKED_BY_LEGAL
- **options**: 即時 legal_hold / 審査後削除 / 反証併記
- **recommended default**: 申立 → legal_hold（read 除外）→ 審査
- **required before phase**: H/I
- **prohibited assumption**: takedown フローを自動確定しない

## DEC-13 — moderation owner（審査主体）
- **status**: USER_DECISION_REQUIRED
- **options**: 運営内部 / 外部委託 / 併用
- **recommended default**: 運営内部 + 明示 policy
- **required before phase**: H
- **prohibited assumption**: 自動 moderation のみで公開しない（PII scan は下限であって承認ではない）

## DEC-14 — appeal process（却下/削除への異議）
- **status**: OPEN
- **options**: 再審査キュー / 一次判断確定
- **recommended default**: 再審査キュー（lifecycle に `legal_hold`→`moderation_pending` 経路あり）
- **required before phase**: I

## DEC-15 — official source verification（公式情報の検証）
- **status**: OPEN
- **options**: 手動検証 / 企業アカウント連携 / 未検証併記
- **recommended default**: `evidenceKind: official` は検証済みのみ。未検証は user_experience 扱い
- **risk**: user 体験談を official と誤表示すると事実誤認
- **required before phase**: H/I
- **prohibited assumption**: 未検証情報を official として表示しない

---

## Gate 一覧（production 接続前の必須条件）

| Phase | 必須決定 |
|---|---|
| G（法務/consent/project 決定） | DEC-05,06,07,08,09,10,11 |
| H（限定 production 接続） | DEC-01,02,03,04,12,13,15 |
| I（AI 機能へ段階展開） | DEC-12,14,15 |

**現時点で production dataflow は未接続。** 上記 gate が満たされるまで、Layer 4/5 の loader は disabled のまま維持する。

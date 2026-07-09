# P9-B: mypage personal event timeline pilot

## なぜ mypage timeline が最小 pilot なのか

P9-A の read-only 監査で、Career Event Log は「安全に貯める配管（table / owner RLS /
append-only / body-free sanitize / index）は実装済みだが **write-only** で、読み戻し・還流・
供給の経路が一切ない」と判定された。read path を開通する最小の一手が本 pilot。

- **AI を経由しない**: prompt / context / body / CareerMemorySnapshot / BaseMemorySummary に
  event を一切載せない。よって context budget（P8-B の matching activity 圧縮を含む）も
  prompt golden も byte fixture も**不変**。
- **既存資産だけで成立**: 既存の owner-select RLS と `(user_id, occurred_at DESC)` index を
  そのまま消費する。**DDL 変更ゼロ / sanitize 仕様変更ゼロ**。
- **本人に本人の履歴を返すだけ**: 匿名化・集計・共有はしない（L4 ではない）。
- **rollback 容易**: mypage の 1 セクション追加＋純変換＋read helper のみ。単一 revert で復帰。

## P9-A との関係

P9-A の推奨 next step「選択肢2: mypage personal event timeline pilot」をそのまま実装したもの。
P9-A で整理した「表示する field / 表示しない field / raw text・PII 防御」をコード化している。

## Career Event Log が write-only から read path を持ったこと

本 STEP で `career_user_events` に対する **初の read path**（owner-scoped）が開通した。
経路は `lib/careerEvents/read.ts` → `lib/careerEvents/timeline.ts`（純変換）→ mypage 表示のみ。

## 接続しないもの（明示）

- **BaseMemorySummary 未接続**（CareerMemorySnapshot / selector / context body に event を混ぜない）。
- **AI prompt / context に渡さない**（表示専用）。
- **L4 匿名集計ではない**（本人専用 owner-scoped 表示。他者データ・集計・共有なし）。
- **Company Knowledge Base / 明示共有には進まない**。
- self-analysis / presentation / company-research / GD への **event wiring 追加は本 STEP では行わない**。

## 表示する field / 表示しない field

**表示する（安全な label / enum / band / allowlist scalar のみ）**:

- `feature` → 日本語ラベル（マッチング / 相談AI / 面接 / ES / プレゼン / 企業研究 / GD / 自己分析 …）
- `event_type` → 日本語ラベル（完了 / AI生成 / マッチング実行 / 相談 …）
- `score_band`（S/A/B/C/D のみ。生スコアは持たない）
- `industry` / `job_type` / `selection_phase`（短ラベル。長文・改行入りは drop）
- `metadata` の **表示側 allowlist** scalar のみ chip 化
  （companyCount / selectionType / interviewType / mode / charLimit / revisionCount / count /
  turnCount / threadCount / industryCount / jobCount / format / participationMode /
  charLimit / timeLimitSec / durationSec）
- `occurred_at` → JST の `YYYY/MM/DD HH:mm`（マシン TZ 非依存の決定論整形）

**表示しない / そもそも取得しない**:

- `user_id`（表示しない）・`company_id`（取得しない）・`created_at`（取得しない）
- `weakness_category` / `next_action` は取得はするが本 pilot では非表示（保守的）
- 本文・自由記述・prompt / response・氏名 / メール / 大学名（列に存在しない＋二重防御で遮断）

## raw text / PII 防御（多層）

1. **書き込み側（既存 sanitize.ts、本 STEP で不変）**: metadata は allowlist、denylist substring、
   scalar 限定、truncate。生スコアは band 化。長文・改行・object/array は drop。
2. **表示側（timeline.ts、本 STEP 追加）**: 表示 allowlist（sanitize allowlist の部分集合）で
   再度絞り、denylist substring（text/body/content/answer/message/prompt/response/email/name/
   university …）に一致する key は allowlist にあっても弾く。非スカラー・長文・改行は drop。
   想定外 key は UI に一切出さない。
3. **整合検査（QA）**: 表示 allowlist ⊆ sanitize allowlist を harness で機械検証。
   （検査で `messageCount` は sanitize の denylist `message` に一致し書き込み側で必ず落ちる＝
   DB に入り得ないと判明したため、表示 allowlist から除外済み。）

## fallback（guest / env なし / error）

- **guest（未ログイン / userId なし）**: DB を叩かず「ログインすると利用履歴が記録されます」を表示。
- **env 未設定（Supabase client なし）**: read helper が空配列 → 「まだ利用履歴がありません」。
- **fetch error**: read helper が握りつぶして空配列 → 空表示。mypage 本体は無傷。
- read helper は member only・never throw・occurred_at desc・limit 上限（既定 20 / 最大 50）。

## QA

- 追加: `scripts/career-event-timeline-qa.ts`（`npm run qa:careerEvents`）。
  DB / env / API 非依存・完全決定論・FAIL 時 exit 1。
  検査内容: feature/event_type ラベル化、score_band 採用可否、metadata allowlist chip 化、
  **PII/本文 value の非出力**、非スカラー/長文/改行 drop、短ラベル drop、JST 整形の決定論、
  表示 allowlist ⊆ sanitize allowlist、異常入力頑健性。
- 不変確認（本 STEP で変化なしを確認済み）: `qa:careerContextCore` / `qa:careerMemoryAll` /
  `qa:careerMemoryPromptGolden`（core 内）/ `qa:careerMemoryMatching`（core 内）/
  `career-context-budget-qa`（P8-B 圧縮保証を含め body-neutral・prompt 不変）。

## rollback 方針

以下を削除／revert すれば完全に元の write-only 状態へ戻る（DB / sanitize / 既存 context は無変更）:

- `app/career/mypage/CareerEventTimeline.tsx`
- `lib/careerEvents/read.ts` / `lib/careerEvents/timeline.ts`
- `scripts/career-event-timeline-qa.ts`・package.json の `qa:careerEvents`
- `app/career/mypage/page.tsx` の import と `<CareerEventTimelineSection />` セクション

## 次 STEP 候補

- event wiring 未対応機能（presentation → company_research）へ同型パターンで拡張（P9-A §8 優先順）。
- L2 方向: CareerMemorySnapshot に eventSignals を実装（selector 経由）。ただし prompt/body/budget
  への影響が出るため golden 再取得を伴う別 STEP。
- L4（匿名集計）は k-anonymity / consent / threshold / privacy policy 未整備のため未着手。

# P9-C: Career Event Log wiring 拡張（presentation / company_research）

## P9-A / P9-B との関係

- **P9-A**（read-only 監査）: Career Event Log は write-only で、wiring 済みは matching /
  consultation / interview / ES の 4 機能のみ。未 wiring の優先順位で **presentation →
  company_research** が最上位（interview/es と同型で低コスト・遷移分析の穴を塞ぐ）と結論。
- **P9-B**: `career_user_events` の owner-scoped read path を mypage timeline として開通。
- **P9-C（本 STEP）**: P9-A の優先順に従い presentation / company_research に event 記録を追加。
  これで「自己分析→ES→面接→プレゼン／企業研究」の遷移が Event Log 上でより連続的に追える。

## なぜ presentation / company_research を先に wiring するか

- interview / ES と同じ「主要結果が確定した完了タイミングで `void recordCareerEvent(...)`」の
  型にそのまま乗る（実装容易・duplicate 安全）。
- L2 Personal Memory の目玉「準備状況・遷移」に直結（プレゼン練習の有無・企業研究の深さ）。
- raw text リスクが低い（構造化 enum / band / カウントのみで記録できる）。

## 何を記録するか

### presentation（`app/career/presentation/session/page.tsx` 評価完了直後）

- feature: `presentation` / event_type: `feature_completed`（専用 enum なし＝interview と同方針）
- completion_status: `completed`
- clientEventId: `resultLog.id`（= session.id。安定 id）
- score_band: `toScoreBand(result.totalScore)`（生スコアは保存しない）
- industry / job_type: `config.industry` / `config.jobType`（短ラベル。長文・改行は sanitize で drop）
- metadata: `mode`（voice/text）/ `scenario`（想定シーン enum・`unspecified` は除外）/
  `format`（発表形式 enum・`unspecified` は除外）/ `selectionType`（main/internship）

### company_research（`app/career/company-research/do/page.tsx` 保存直後 = AI添削済み研究ログ確定時）

- feature: `company_research` / event_type: `company_researched`（既存 enum を使用）
- completion_status: `completed`
- clientEventId: `saved.id`（= log id。安定 id）
- industry: `input.industry`（短ラベル）
- metadata: `sourceType`（file / paste / manual / mixed の派生 enum）/
  `revisionCount`（`revisionHistory.length`）

## 何を記録しないか（raw text / PII 防御）

以下は **event に一切載せない**（列にも metadata にも入れない）:

- presentation: 発表本文 / transcript / theme（お題本文）/ Q&A 本文 / feedback 本文
- company_research: **companyName（企業名文字列）** / OCR 抽出本文 / manualMemo / pastedText /
  verifiedResearchText / review 本文 / fitAnalysis 本文 / interviewContextSummary 本文
- 生スコア（band 化のみ）/ 氏名 / メール / 大学名

多層防御:

1. 記録側は allowlist 済み enum / band / カウント / 短ラベルのみを渡す（本文フィールドを渡さない）。
2. 書き込み側 sanitize（`lib/careerEvents/sanitize.ts`）が allowlist + denylist + scalar 限定 +
   truncation で本文混入を機械遮断。**万一 metadata に本文 key が混入しても drop**（QA で検証）。
3. company_id は **企業名が自由入力で UUID 化できないため載せない**（企業名の間接混入も防ぐ）。

## sanitize 仕様変更（最小・additive）

`ALLOWED_METADATA_KEYS` に **`scenario` と `sourceType` の 2 key を追加**した。

- 追加理由: presentation の想定シーン・company_research の情報源は、L2/L4 で有用かつ **本文を含まない
  bounded enum**。既存の allowlisted key では表現できないため。
- 安全性: denylist（text/body/answer/summary/name/email/university 等）・scalar 限定・truncation は
  **一切変更していない**（additive のみ）。両 key とも denylist substring に非該当。よって PII/本文の
  遮断能力は不変。QA（`qa:careerEvents`）で「表示 allowlist ⊆ sanitize allowlist」と本文 key drop を保証。

## idempotency / clientEventId 方針

- presentation は `resultLog.id`、company_research は `saved.id` を clientEventId に使用。
- `career_user_events` の部分 unique index `(user_id, client_event_id) WHERE client_event_id NOT NULL`
  により、二重記録は DB 側で冪等吸収（2 回目 insert は error → devWarn で握り潰し・行は増えない）。
- `recordCareerEvent` は fire-and-forget / never throw / guest・env 未設定は no-op（本体機能を壊さない）。
- **既知の限界**: company_research の再添削（同一 log の editing 再保存）は同じ `saved.id` を使うため
  **2 回目以降は記録されない**（初回のみ）。既存 4 機能と同じ「安定 log id」方針を優先し duplicate を
  避けた結果。再添削を別 event として数えたい場合は revision-scoped id 化が将来の選択肢。

## mypage timeline でどう見える

P9-B の `lib/careerEvents/timeline.ts` はそのまま対応:

- feature ラベル: `presentation` → プレゼン / `company_research` → 企業研究（既存）
- event_type ラベル: `feature_completed` → 完了 / `company_researched` → 企業研究（既存）
- metadata 表示 allowlist に **`scenario`（シーン）/ `sourceType`（情報源）** を追加（sanitize allowlist の部分集合）。
- 表示は band / enum / 短ラベルのみ。本文・企業名は構造的に出ない（QA で検証）。

## 接続しないもの（明示）

- **AI prompt / context / body に event を混ぜない**（記録のみ・表示は P9-B の owner-scoped read）。
- **BaseMemorySummary 未接続** / CareerMemorySnapshot / selector 未変更（event 混入なし）。
- **L4 匿名集計ではない**（本人 owner-scoped の観測ログ記録のみ）。
- Company Knowledge Base / 明示共有には進まない。
- self_analysis / GD / profile / activity / values への wiring は本 STEP では行わない。

## QA

- `qa:careerEvents`（`scripts/career-event-timeline-qa.ts`）に section [10] を追加:
  presentation / company_research の実 event 形状で feature/event ラベル・band・enum chip・
  **本文/企業名 key の drop と value 非出力**・想定外 key 非表示・sanitize 整合（scenario/sourceType 保持、
  companyName/verifiedResearchText/interviewContextSummary/feedbackText の drop）を検査。全 PASS。
- context 不変（本 STEP で変化なしを確認）: `qa:careerContextCore`（ALL_PASS）/ `qa:careerMemoryAll`
  （ALL_PASS）/ `qa:careerPersonaSpotcheck`（ALL_PASS）/ `qa:careerMemoryPromptGolden`（ALL_MATCH）/
  `qa:careerMemoryMatching`（ALL_MATCH）/ `career-context-budget-qa`（ALL PASS・P8-B 圧縮維持）。

## rollback 方針

以下を revert すれば元へ戻る（DB / read path / 既存 4 機能 wiring は無変更）:

- `app/career/presentation/session/page.tsx` の event 記録ブロックと import
- `app/career/company-research/do/page.tsx` の event 記録ブロックと import
- `lib/careerEvents/sanitize.ts` の allowlist 2 key（scenario / sourceType）
- `lib/careerEvents/timeline.ts` の META_DISPLAY 2 key
- `scripts/career-event-timeline-qa.ts` の section [10] と DISPLAY_KEYS 追加

## 次に wiring するなら何か

- **self_analysis**（起点 feature。遷移の始点を捕捉。interview/es と同型・低リスク）
- 次いで **GD**（solo/room 2 系統。topic は free text 化せず role/outcome を enum 化する前提）
- profile / activity / values は「準備完了度」signal として意味はあるが SN 比が下がるため後段。
- L2 eventSignals（selector 実装）/ L4 匿名集計は別フェーズ（prompt/body/budget 波及・consent/k-anon 前提）。

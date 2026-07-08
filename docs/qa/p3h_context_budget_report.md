# P3-H Context Budget 実測レポート

> 自動生成: `npx tsx scripts/career-context-budget-qa.ts --write`
> 本レポートは **観測のみ**。context 削減・本番 route / prompt / AI schema / API / UI / DB / timeout は一切変更していない。

## 1. Summary

- 実施日: 2026-07-08
- branch: `feature/career-mvp`
- HEAD commit: `2e63ae9`
- 変更範囲: dev-only 計測スクリプト + 本 QA レポートのみ（本番 runtime 不変）
- 本番 runtime 不変確認: production code は **import のみ**（buildCareerContextForPurpose / budget / rawTextGuard）。route から自動実行しない。

## 2. Measurement Method

- fixture 方針: 実 DB / Supabase / 本番ユーザーデータに接続せず、mock `CareerAiContext` と文字列 fixture で計測。
- base: `buildCareerContextForPurpose(purpose, mockContext)` の `estimatedChars`（= `buildCareerSystemPrompt` の文字数）。
- route 固有 block: 現行 route の上限・実装に合わせた文字列 fixture（意味・内容は変えない）。
- scenario:
  - **normal**: 一般ユーザー想定（数セクション・短めカード・snapshot 少数）。
  - **heavy**: 長文・複数 snapshot・長め transcript 想定（P2-A 活動圧縮が効く量）。
- env / secret / API key / Supabase URL / token は読まない・出力しない。
- **文字数ベースであり token 実測ではない**（policy.maxContextChars も文字数目安）。

> **policyMaxContextChars(=3500) は registry 上「base context の目安上限」**（`purpose.ts` の
> `maxContextChars` コメント／orchestrator `isOverPolicyBudget`）であって、prompt 全体の予算ではない。
> route 固有 block（cross-feature 要約・添削本文・静的 outputFormat）は base とは別に正当に積まれる。
> → 実効的なシグナルは **isBaseOverBudget**。isTotalOverBudget は「total の内訳観測」であり超過自体は設計上想定内。

## 3. Budget Results

### 3.1 purpose × scenario

| purpose | scenario | base | route | total | policyMax | baseOver | totalOver | top heavy blocks | warnings |
|---|---|---:|---:|---:|---:|:--:|:--:|---|---|
| consultation | normal | 1014 | 4800 | 5814 | 3500 | — | ⚠️ | outputFormat=2000, base=1014, conversationMessages=900 | total_over_budget |
| consultation | heavy | 5093 | 17600 | 22693 | 3500 | ⚠️ | ⚠️ | conversationMessages=8000, base=5093, historySnapshots=3000 | base_over_budget, total_over_budget |
| matching | normal | 1146 | 2930 | 4076 | 3500 | — | ⚠️ | outputFormat=2000, base=1146, selfAnalysis=250 | total_over_budget |
| matching | heavy | 5225 | 3900 | 9125 | 3500 | ⚠️ | ⚠️ | base=5225, outputFormat=2000, selfAnalysis=500 | base_over_budget, total_over_budget |
| presentation_feedback | normal | 1176 | 4000 | 5176 | 3500 | — | ⚠️ | outputFormat=2500, transcript=1500, base=1176 | total_over_budget |
| presentation_feedback | heavy | 5255 | 16400 | 21655 | 3500 | ⚠️ | ⚠️ | transcript=10000, base=5255, qaContext=3000 | base_over_budget, total_over_budget |
| interview_practice | normal | 1029 | 3330 | 4359 | 3500 | — | ⚠️ | outputFormat=2500, base=1029, selfAnalysis=300 | total_over_budget |
| interview_practice | heavy | 5108 | 5980 | 11088 | 3500 | ⚠️ | ⚠️ | base=5108, outputFormat=2500, targetConfig=1500 | base_over_budget, total_over_budget |
| company_research_review | normal | 1037 | 2980 | 4017 | 3500 | — | ⚠️ | outputFormat=1500, base=1037, verifiedResearchText=1000 | total_over_budget |
| company_research_review | heavy | 5116 | 6300 | 11416 | 3500 | ⚠️ | ⚠️ | base=5116, verifiedResearchText=4000, outputFormat=1500 | base_over_budget, total_over_budget |
| self_analysis | normal | 1040 | 3870 | 4910 | 3500 | — | ⚠️ | outputFormat=2500, base=1040, conversation=800 | total_over_budget |
| self_analysis | heavy | 5119 | 7600 | 12719 | 3500 | ⚠️ | ⚠️ | base=5119, conversation=4000, outputFormat=2500 | base_over_budget, total_over_budget |
| self_analysis_deep_dive | normal | 1040 | 1170 | 2210 | 3500 | — | — | base=1040, pastLog=320, topics=300 | none |
| self_analysis_deep_dive | heavy | 5119 | 3400 | 8519 | 3500 | ⚠️ | ⚠️ | base=5119, userPrompt=2000, pastLog=700 | base_over_budget, total_over_budget |
| es_generation | normal | 1072 | 1750 | 2822 | 3500 | — | — | outputFormat=1200, base=1072, question=300 | none |
| es_generation | heavy | 5151 | 3200 | 8351 | 3500 | ⚠️ | ⚠️ | base=5151, companyResearch=1200, outputFormat=1200 | base_over_budget, total_over_budget |

### 3.2 heavy total ランキング

| # | purpose (heavy) | total | policyMax | totalOver | dominant block |
|---:|---|---:|---:|:--:|---|
| 1 | consultation | 22693 | 3500 | ⚠️ | conversationMessages=8000 |
| 2 | presentation_feedback | 21655 | 3500 | ⚠️ | transcript=10000 |
| 3 | self_analysis | 12719 | 3500 | ⚠️ | base=5119 |
| 4 | company_research_review | 11416 | 3500 | ⚠️ | base=5116 |
| 5 | interview_practice | 11088 | 3500 | ⚠️ | base=5108 |
| 6 | matching | 9125 | 3500 | ⚠️ | base=5225 |
| 7 | self_analysis_deep_dive | 8519 | 3500 | ⚠️ | base=5119 |
| 8 | es_generation | 8351 | 3500 | ⚠️ | base=5151 |

- base が policy(base目安3500) 超過: consultation/heavy, matching/heavy, presentation_feedback/heavy, interview_practice/heavy, company_research_review/heavy, self_analysis/heavy, self_analysis_deep_dive/heavy, es_generation/heavy
- total が policy 超過（＝内訳観測。設計上想定内）: consultation/normal, consultation/heavy, matching/normal, matching/heavy, presentation_feedback/normal, presentation_feedback/heavy, interview_practice/normal, interview_practice/heavy, company_research_review/normal, company_research_review/heavy, self_analysis/normal, self_analysis/heavy, self_analysis_deep_dive/heavy, es_generation/heavy

## 4. Raw Text Guard Results

| ケース | 期待 | 結果 |
|---|---|---|
| A 横断 safe snapshot | ok=true / findings=[] | ✅ ok=true |
| B raw 本文混入 | ok=false / path 付き findings | ✅ ok=false (10 findings) |
| C-1 verifiedResearchText allowed | ok=true | ✅ ok=true |
| C-1 verifiedResearchText 横断(allow無) | 検出される | ✅ 検出 |
| C-2 transcript allowed | ok=true | ✅ ok=true |
| C-3 essay/essayBody allowed | ok=true | ✅ ok=true |

B の findings（path:reason）:

- `essayBody` — raw_text_like_key
- `answer` — raw_text_like_key
- `transcript` — raw_text_like_key
- `verifiedResearchText` — raw_text_like_key
- `prompt` — raw_text_like_key
- `response` — raw_text_like_key
- `email` — raw_text_like_key
- `name` — raw_text_like_key
- `freeText` — raw_text_like_key
- `freeText` — long_free_text

## 5. Interpretation（依頼の 10 問）

1. **base だけで policy(base目安3500) を超える purpose はあるか** —
   normal では **なし**（base ~1.0–1.2k）。heavy では **全 purpose が超過**（base 5093〜5255）。
   heavy base の内訳は「活動整理(P2-A で ≤3500 に圧縮済み) + profile + 就活軸 + 基本方針/機能指示」で、
   data-rich ユーザーでは活動 3500 上限だけで base 目安をほぼ使い切る。

2. **total で policy を超える purpose はどれか** —
   heavy は全 purpose。normal でも **consultation / matching / presentation_feedback / interview_practice / company_research_review / self_analysis** が超過。
   ただし §3 冒頭の通り 3500 は base 目安であり、total 超過は「静的 outputFormat(~1.2–2.5k) + 正当な route block」が
   base の外に積まれる設計上の内訳。**total を 3500 に収めることは設計目標ではない**。

3. **重い原因は base か route 固有 block か** —
   - **normal**: 支配は多くの purpose で **静的 outputFormat(~2–2.5k)**（＋base ~1k）。ユーザーデータではなく固定指示が主因。
   - **heavy**: **base(活動圧縮上限)** と、purpose ごとの **大きな本文 block**（consultation 会話 / presentation transcript /
     company_research verifiedText / self_analysis 会話）の 2 つ。

4. **consultation は本当に route 固有 block が重いか** — **YES**。
   heavy で route=17600（base の 3.5 倍）、
   単一最大は **conversationMessages=8000**（MAX_MESSAGE_LENGTH 1000 × HISTORY_MAX_TURNS 10 の上限）。
   normal でも route=4800 が base=1014 を上回る。司令塔ゆえ手組みアグリゲートが支配的。

5. **matching はどの cross-feature block が重いか** —
   実は **突出した cross-feature block は無い**。cross-feature（selfAnalysis/es/interview/consultation/gd）は各
   ≤500（最大は selfAnalysis）で、すべて要約・list slice 済み。matching の重さは
   **base + 静的 outputFormat(2000)** に由来する。→ matching で削るべき「重い cross-feature」は存在しない。

6. **presentation は transcript が支配的か** — **YES**。
   heavy で transcript=10000（route の 61%、単一最大 block）。
   route 側で MAX_TRANSCRIPT_CHARS=20000 を超えると reject（truncate ではない）＝上限は既に存在。

7. **self_analysis_deep_dive の pastLog / coverage は許容範囲か** — **YES**。
   pastLog=700（SELF_ANALYSIS_PAST_LIMIT=3 で頭打ち）、coverage=400。deep_dive は
   **normal で唯一 total も policy 未超過（total=2210）**。変動要因は pastLog/coverage ではなく userPrompt(過去ターン transcript)。

8. **company_research_review は verifiedResearchText が支配的か** — **YES**。
   heavy で verifiedResearchText=4000（route の 63%）。route 側に char cap が無い本人一次メモ本文。
   ただしこれは **添削対象そのもの**であり、削ると添削品質が直接落ちる（rawTextGuard でも allowedRawKeys で許可する正当本文）。

9. **削減に進むならどこが最小リスクか** —
   - 触ると危険: 静的 **outputFormat**（AI 出力 schema・評価軸に直結）、**添削/評価対象の本文**（transcript / verifiedResearchText /
     conversation）＝品質と直結。
   - 既に cap 済み: 活動(P2-A ≤3500)、consultation 会話(1000×10)、presentation transcript(≤20000)、pastLog(≤3)、各 snapshot slice。
   - 最小リスク候補（§6 参照）: **cap の無い自由本文 block に決定論的な上限を "追加観測" として先に測る**
     （interview targetConfig.companyMemo / self_analysis conversation / deep_dive userPrompt）。ただし削減自体は本人本文に触れるため慎重に。

10. **Memory 永続化前にまだ確認すべきこと** —
   - **token 実測**（本 report は文字数。日本語は文字≠token、比率は概算 1.5–2 char/token）。
   - **実 route の base 実測**（本 report は mock base。実 profile/activity/values 形状での再測）。
   - **横断 snapshot formatter 出力に対する rawTextGuard の実データ回し**（historySnapshots / matching consultationContext /
     companyResearch context の生成結果を guard に通す）。
   - consultation の会話 10×1000 が実運用でどの程度発生するかの分布確認。

## 6. Recommendation for P3-I

評価軸（最小差分・revert 容易・AI 出力 schema 不変・品質低下しにくい 順）で順位付け。

1. **案E+D（推奨）: まだ削減せず、rawTextGuard を self-check/CI 化して Memory 化前の安全網にする。**
   - 最小差分・revert 容易・schema 完全不変・品質影響ゼロ。
   - 本 runner（`scripts/career-context-budget-qa.ts`）を package.json の `qa:*` に接続し、
     横断 snapshot formatter の実出力を guard に通す test を足すだけ。削減判断のデータは本 report で揃っている。

2. **案A: presentation transcript の上限を "実装前に" dev-only 測定で詰める（削減はしない）。**
   - transcript は heavy で単一最大かつ既に 20000 reject 済み。truncate 化する前に「20000 が実際に効いているか / 適正閾値か」を観測追加。
   - schema 不変・本番挙動不変。ただし transcript は評価対象本文 → 実削減は品質リスクありのため観測に留める。

3. **案C: matching cross-feature block の観測詳細化（削減はしない）。**
   - §5-5 の通り matching は cross-feature が既に軽い。詳細化しても削減余地は小さいと確認するための観測に留まる。低優先。

4. **案B: consultation route 固有 block をさらに分解観測（削減はしない）。**
   - conversationMessages が支配的なのは判明済み。分解観測の追加価値は限定的。低優先。

**まだ削減しない方がよい箇所**: 静的 outputFormat、添削/評価対象本文（transcript / verifiedResearchText / conversation）、
base の profile/activity（人格一貫性・P2-A で既に圧縮済み）。これらは品質・人格一貫性に直結する。

**P4 / Memory 化前の残課題**: token 実測、実 route base 実測、snapshot formatter の guard 実データ回し（§5-10）。

## 7. Final State

- git status: この時点では未 commit（レビュー後に指示があれば commit）。
- commit / push: 未実施。
- secret: 非出力（fixture のみ・env/secret/Supabase 未読取）。

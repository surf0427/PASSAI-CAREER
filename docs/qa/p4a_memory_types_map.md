# P4-A: Central Memory 型・マップ設計

> フェーズ: **P4-A（型・契約・マップの固定）**。実装・selector・既存呼び出し変更は含まない。
> 追加物: [`lib/careerMemory/types.ts`](../../lib/careerMemory/types.ts)（型 + 反復用 const key 配列）と本文書のみ。
> 既存 production code / route / prompt / AI schema / storage / Supabase mirror / DB / SQL は **一切不変**。
> secret / env / token / Supabase URL / service_role / API key は非参照・非出力。

中央メモリは **新しい永続ストアではない**。localStorage canonical の raw log から、純関数
`careerMemorySelector`（P4-C で実装）が purpose 別に AI-consumable summary block を算出する
**論理的な読み取り層**である。案A（client-side selector）を採用し、server route は
現状どおり stateless（client が request body で渡す）を維持する。

---

## A. 現状保存構造マップ

canonical = localStorage、Supabase = durable mirror（消さない）。summary は `career_user_events`
を除き未永続化（都度生成）。「memory 搭載」= P4 中央メモリに **要約/signal として** 載せる対象。

| feature | localStorage key | stored shape | Supabase mirror | raw/summary | prompt直入りリスク | rawTextGuard対象 | central memory搭載 | 備考 |
|---|---|---|---|---|---|---|---|---|
| profile | `careerBasicFormData` | `CareerProfile`(BasicInfo系) | `career_profiles`(jsonb, 1行/user) | raw | 中(name) | name 検出 | **base**(PII除外) | 氏名/メールは載せない |
| activity | `careerActivityData` | `CareerActivity`(18section) | `career_activities` | raw | 中(自由記述) | long_free_text | **base**(compact) | 既存 P2-A 圧縮を継承 |
| values | `careerValues`(+`careerValuesCategories`) | `CareerValues` | `career_values` | raw | 低 | 低 | **base** | 選択ラベル主体 |
| self-analysis | `careerSelfAnalysisLogs`(+`careerAnalyzeState`/`careerSelfPRs`) | `CareerSelfAnalysisLog[]` | `career_self_analysis_results`/`_self_prs` | raw + 都度summary | 低 | 低 | **selfAnalysis**(latest+longTerm) | 結果は構造化済 |
| ES | `careerEsLogs` | `CareerEsLog[]` | `career_es_logs` | raw(本文) | **高(essay)** | essay/draft | **es**(要約のみ) | 生 essay body 除外 |
| interview | `careerInterviewSessions`/`Results`(+`...TargetDraft`) | `CareerInterviewResult[]`(+turns) | `career_interview_sessions`/`_results` | raw(turn全文) | **高(answer/turn)** | answer/transcript | **interview**(要約のみ) | turn 全文除外 |
| presentation | `careerPresentationSessions`/`Results`(+`...TargetDraft`) | `CareerPresentationResult[]` | `career_presentation_sessions`/`_results` | raw(transcript) | **高(transcript)** | transcript | **presentation**(要約のみ) | transcript 除外 |
| company research | `careerCompanyResearchLogs` | `CareerCompanyResearchLog[]` | `career_company_research_logs` | raw(verifiedText) | **高(verifiedText)** | verifiedresearchtext | **companyResearch**(要約のみ) | 生 verifiedText 除外 |
| matching | `careerMatchingResults` | `CareerMatchingLog[]` | `career_matching_results` | raw | 低(構造化) | 低 | **matching**(signals) | 生スコア詳細除外 |
| consultation | `careerConsultationLogs` | thread(messages+`CareerConsultationResult`) | `career_consultation_threads` | raw thread | **高(会話本文)** | message/content | **consultation**(現在地signal) | thread 本文除外 |
| GD solo | `careerGdSessions`/`careerGdResults` | `CareerGdResult[]` | （solo mirror なし） | raw(message) | **高(message)** | message/transcript | **gdSolo**(signals) | 発言本文除外 |
| GD multiplayer | `careerGdRoomLogs` | `CareerGdRoomLog[]` | `career_gd_room_results`(**lossy**: theme/format/duration欠落) | raw(message) | **高(message)** | message/transcript | **gdRoom**(signals) | mirror は placeholder 再水和 |
| career_user_events | （なし） | `CareerEventInput` scalar のみ | `career_user_events`(本文なし) | metadata signal | なし | 構造上 raw 不可 | **signals**(member-only) | guest は no-op で空 |

**キー正本の不在:** 単一 constants は無く各 `*Storage.ts` にローカル宣言。最も近い集約は
[`lib/repository/careerRestore.ts`](../../lib/repository/careerRestore.ts) の restore フロー一覧と
[`lib/repository/backfillFlag.ts`](../../lib/repository/backfillFlag.ts) の per-feature フラグ。
→ P4-A 型では `CareerMemoryFeature` として機能キーを一元宣言した（実 storage 型への接続は P4-C）。

---

## B. 3層分離ルール

| 層 | 実体 | canonical/source | 変更方針 | P4 での扱い |
|---|---|---|---|---|
| **1. Raw Log** | 各機能の localStorage key + Supabase durable mirror | localStorage が canonical、mirror は durable コピー | **現状維持（本層は触れない）** | 参照のみ。selector の入力元。 |
| **2. Feature Summary** | raw log から都度生成する AI-consumable 要約 | 生成物（未永続化） | on-the-fly 生成。route 別に再利用可能 | `FeatureSummary<TLatest, TLongTerm>` で型化。P4-B で共有 util 化。 |
| **3. Career Memory Snapshot** | route 横断の中央 memory | 生成物（未永続化） | selector が purpose 別に必要 block のみ返す | `CareerMemorySnapshot`。long-term / latest / signals / warnings に分離。 |

**分離原則（P4 の背骨）:** memory は「raw を要約したもの」だけを運ぶ。raw 本文が prompt に入るのは
「その本文が当該機能の添削/評価対象そのもの」の場合に限り、その経路は **selector を通さず**
route が直接 user メッセージとして渡す（rawTextGuard の `allowedRawKeys` と対応）。

- **latest**: 直近スナップショット（新しい順・件数上限つき）。既存 `build*History` の件数上限を継承。
- **longTerm**: 複数件から算出した累積要約（一貫強み・繰り返し課題・スコア推移）。既存の「推移メモ」相当。
- **signals**: `career_user_events` 由来の member-only metadata（弱みカテゴリ・次アクション・band）。
- **warnings**: budget 超過 / raw 混入疑いなどの観測フラグ（挙動には影響しない）。

---

## C. 中央メモリに入れるもの / 入れないもの

### 入れる（AI-consumable summary / signal のみ）

| block | source | 内容 | 型 |
|---|---|---|---|
| `base` | profile/activity/values | stable base summary（PII除外・activity compact） | `BaseMemorySummary` |
| `selfAnalysis` | self-analysis logs | 強み/価値観/方向性 + 一貫強み・推移 | `SelfAnalysisMemorySummary` |
| `es` | ES logs | 再利用可能な訴求軸・ガクチカ/自己PR/志望動機の**要約** | `EsMemorySummary` |
| `interview` | interview results | 総評/繰り返し改善点(=優先課題)/強み | `InterviewMemorySummary` |
| `presentation` | presentation results | 構成/delivery 改善点/スコア推移 | `PresentationMemorySummary` |
| `companyResearch` | company research logs | 企業別 verified メモの**要約**・fit | `CompanyResearchMemorySummary` |
| `matching` | matching logs | career direction / fit signals | `MatchingMemorySummary` |
| `gdSolo`/`gdRoom` | GD results / room logs | behavior / teamwork signal | `GdMemorySummary` |
| `consultation` | consultation threads | 司令塔レベルの現在地 signal | `ConsultationMemorySummary` |
| `signals` | career_user_events | metadata signals（member-only） | `CareerEventSignalSummary` |

### 入れない（raw 本文・PII・one-time text）

- full interview turns / full GD messages / full consultation thread 本文
- raw ES essay body / draft
- full presentation transcript
- full company `verifiedResearchText`（**例外:** company-research review の添削対象本文は
  memory を通さず route が user メッセージで直接渡す）
- route-specific one-time prompt text（outputFormat / persona）
- 不要な PII（氏名・メール・大学名の一部）/ token / secret
- memory 化する必要のない添削対象本文

---

## D. Route別 memory selector 契約

budget 目安は `docs/qa/p3h_context_budget_report.md` 実測に基づく（base ~1k normal / ~5.1k heavy、
各 snapshot ≤~500字、policy base目安 3500）。**本表が selector 契約の正本**。const registry 化・
強制は P4-C 以降（P4-A は型 `CareerMemoryPurposePolicy` のみ提供）。

| purpose | 必須 block | 任意 block | 禁止 raw | budget目安 | fallback | backward-compat | timeout/token対策 |
|---|---|---|---|---|---|---|---|
| **self_analysis** | `base`, `selfAnalysis`(past) | — | 横断他機能ログ | base + pastLog≤700 + coverage≤400 | pastLog空→block省略 | v2欠損は空扱い | pastLog≤3件, coverage ラベルのみ |
| **es_generation** | `base` | `companyResearch`(選択時), `selfAnalysis` | 他社ES本文 | base + companyResearch≤1200 | selfAnalysis無→base のみ | 単体成立 | companyResearch 1件, 訴求軸のみ |
| **es_review** | （base不使用） | — | 横断・他社ES | essay本文(user側=添削対象) | — | 静的SYSTEM_PROMPT維持 | memory 不使用（対象外明記） |
| **interview** | `base`, `selfAnalysis` | `es`(訴求整合), `matching` | turn全文, consultation本文 | base + cross各≤300–500 | 各block独立に省略可 | 旧clientは単体render | cross 各≤3件・要約のみ |
| **presentation** | `base` | `selfAnalysis` | transcript(評価対象はuser側) | base + qaContext | 無→base | 単体成立 | transcript は memory 非搭載 |
| **company_research** | `base` | `selfAnalysis`, `matching` | 他社verifiedText | base + selfAnalysis≤500 | 無→base | 本人一次メモ主体 | verifiedText は user 側(添削対象) |
| **matching** | `base`, `values` | `selfAnalysis`/`es`/`interview`/`gdSolo` signals | — | base + cross各≤500(計~2.9k) | cross無→base+values | §5-5「既に軽い」 | cross 各≤2件・signal 化 |
| **consultation** | `base`(activity compact), 全機能 summary | `signals` | 会話全文(直近のみ), 全raw本文 | base + 各summary(3–5件) + 会話1000×10 | 機能ごと has-flag で省略 | 旧client単体render経路維持 | 各機能 truncate + 件数上限を継承 |
| **gd_solo** | （base任意）`gdSolo` signal | `selfAnalysis` | GD message全文 | signal≤3件 | 無→transcript主体 | — | signal 化・発言本文除外 |
| **gd_multiplayer_result** | `gdRoom` signal | — | message全文 | signal≤3 | mirror lossy→placeholder theme | 既存再水和維持 | room signal のみ |
| **mypage** | `base`(minimal), `signals` | latest各1件 | 全raw本文 | ≤1500(policy) | 未実装/予約 | 新規 | 最小注入・signal 主体 |

**共通対策（selector 側で強制する設計）:**
- 各 block に既存 truncate/件数上限を継承（history=3, companyResearch=5, matching=2）。
- selector 出力を `lib/careerContext/budget.ts` の `createContextBudgetReport` に通せる形にする（dev-only 観測）。
- memory 化前に `lib/careerContext/rawTextGuard.ts` の `guardRawText` に selector 出力を通す self-check（P4-A.5 で dev-only 追加予定。P4-A では設計のみ）。

---

## E. 既存関数との対応表（P4-B 以降の統合計画）

| 既存関数 | ファイル | 現在の用途 | raw input | output summary | 中央memory統合 | いつ | backward-compat 注意 |
|---|---|---|---|---|---|---|---|
| `buildCareerContextForPurpose` | careerContext/orchestrator.ts | base system prompt(byte一致 wrapper) | CareerAiContext | base prompt text | `base` block の生成元として温存 | P4-D | byte 一致を崩さない |
| `buildSelfAnalysisHistory` | careerConsultation/historySnapshots.ts | consultation 用 self要約(3件) | `CareerSelfAnalysisLog[]` | `SelfAnalysisHistorySnapshot[]` | **`selfAnalysis.latest` へ集約** | **P4-B** | 推移メモ文言を確定 |
| `formatSelfAnalysisHistoryForPrompt` | 同上 | prompt 整形 | snapshot[] | text | format は残し selector 出力から呼ぶ | P4-C | 出力 byte 一致 |
| `buildSelfAnalysisPastSummaries` / `formatPastSummariesForPrompt` | careerSelfAnalysis/pastLogSummary.ts | deep-dive 用 self要約(3件) | `CareerSelfAnalysisLog[]` | `SelfAnalysisPastSummary[]` | **`buildSelfAnalysisHistory` と統合**(重複) | **P4-B** | deep-dive 独自 fields(valueKeywords/nextActions) を保持 |
| `buildEsHistory` / `formatEsHistoryForPrompt` | historySnapshots.ts | ES 要約 | `CareerEsLog[]` | `EsHistorySnapshot[]` | `es` block へ | P4-B(build)/P4-C(format) | 生 essay 非搭載を維持 |
| `buildInterviewHistory` / `formatInterviewHistoryForPrompt` | historySnapshots.ts | 面接要約 | `CareerInterviewResult[]` | `InterviewHistorySnapshot[]` | `interview` block へ | P4-B/P4-C | turn 全文非搭載 |
| `buildPresentationHistory` / `formatPresentationHistoryForPrompt` | historySnapshots.ts | プレゼン要約 | `CareerPresentationResult[]` | `PresentationHistorySnapshot[]` | `presentation` block へ | P4-B/P4-C | transcript 非搭載 |
| `compressCareerActivityForConsultation` | historySnapshots.ts | 活動圧縮(3件/160字) | `CareerActivity` | `CareerActivity`(軽量) | `base.activity` の生成補助 | P4-D | 形状維持で renderActivity 互換 |
| `buildCompanyResearchContext` / `formatCompanyResearchContextForPrompt` | careerCompanyResearch/context.ts | consultation 用企業研究要約 | `CareerCompanyResearchLog[]` | snapshot / text | `companyResearch` block へ | P4-C | verifiedText 非搭載 |
| `formatInterviewCompanyResearchForPrompt` | careerCompanyResearch/context.ts | interview 用(consumer別) | snapshot | text | framing 引数化して統合 | **P4-D**(後回し) | consumer 別 framing は意図的 |
| `buildLatestMatchingConsultationSnapshots` / `formatMatchingConsultationForPrompt` | careerMatching/consultationContext.ts | matching signal 要約(2件) | `CareerMatchingLog[]` | snapshot / text | `matching` block へ | P4-C | 生スコア詳細非搭載 |
| `buildLatestGdConsultationSnapshots` / `buildGdConsultationSnapshotById` / `formatGdConsultationForPrompt` | careerGd/context.ts | GD solo signal | `CareerGdResult[]` | snapshot / text | `gdSolo` block へ | P4-C | 発言本文非搭載 |
| `buildLatestGdRoomSignals` / `formatGdRoomSignalsForConsultation` | careerGd/context.ts | GD room signal(consultation) | `CareerGdRoomLog[]` | snapshot / text | `gdRoom` block へ | P4-C | mirror lossy 前提 |
| `formatGdRoomSignalsForMatching` | careerGd/context.ts | GD room signal(matching, consumer別) | snapshot | text | framing 引数化して統合 | **P4-D**(後回し) | consumer 別 framing は意図的 |
| `renderSelfAnalysis`/`renderEs`/`renderInterview`/`renderPresentation`(legacy) | consultation/route.ts | 旧client 単体render | 単体 object | text | selector 導入後に旧経路実利用が消えたら削除 | **P4-D**(後回し) | 旧client backward-compat 経路。急がず残す |
| `str`/`truncate`/`strList`/`repeatedItems`/`round100`/`clamp100`(各自再宣言) | historySnapshots / pastLogSummary / careerGd / careerMatching / careerCompanyResearch / route内 | 汎用 helper | — | — | **共有 util 化** | **P4-B**(最初) | 出力 byte 一致を CI で担保 |

---

## F. P4-A で「やらないこと」（確認）

selector 実装 / localStorage 読込 / `buildConsultationContext` 抽出 / route request body 変更 /
prompt block 変更 / AI 出力形式変更 / Supabase summary table 追加 / `career_user_events` 集約実装 /
rawTextGuard・budget の挙動変更 / helper 共通化 / self-analysis summarizer 統合 / GD mirror 修正 —
いずれも本フェーズでは実施しない。P4-B 以降で段階導入する。

---

## G. P4-B への引き継ぎ

1. **最初に共有 util 化**（P4-B）: `str/truncate/strList/repeatedItems/round100/clamp100`。純関数・出力不変。
   置換前後で prompt byte 差分ゼロを `scripts/career-context-budget-qa.ts` で検証してから merge。
2. **self-analysis summarizer 二重化の解消**（P4-B〜C）: `buildSelfAnalysisHistory`(consultation) と
   `buildSelfAnalysisPastSummaries`(deep-dive) を単一 `selfAnalysis` summary に集約。ただし
   両者の「推移メモ文言」「保持 fields(valueKeywords/nextActions)」の差を byte 監査してから寄せる。
3. **byte 一致確認が必要な箇所**: `buildConsultationContext` 抽出(P4-C)後の request body、
   各 `format*ForPrompt` の出力、`buildCareerContextForPurpose` の base prompt。
4. **P4-A.5（任意・dev-only）**: `CareerMemorySnapshot` fixture を `guardRawText` に通す self-check を
   `scripts/` に追加（本番 route から自動実行しない）。memory 化の安全網を型と同時に立てる。

---

## H. 実装照合（P4-I 監査 / 2026-07-09）

> P4-C〜P4-H の実装結果を P4-A 設計（§A〜G）と突き合わせた **read-only 監査**の記録。
> production code / selector / route / prompt / AI schema / storage / DB / SQL は **不変**（本節は docs のみ追加）。
> secret / env / token / Supabase URL / service_role / API key は非参照・非出力。
> 実装コミット: `d9cf62c`(P4-B util 共有) / `2f4eef4`(P4-C consultation) / `ab1b09f`(P4-D interview) /
> `942152e`(P4-E1 presentation) / `e6b79bd`(P4-E2 matching)。P4-F/G/H は **B判定**（抽出せず・§H-2）。

### H-1. 実装済み 4 selector の実態

いずれも `lib/careerMemory/selector.ts` に純関数として存在。page/contextSource(client) が `load*` した生データを
受け取り、返り値を `fetch` body へ spread する。**page-local proto-selector から「出力 byte 不変」で抽出**したもので、
route / prompt / AI schema / storage / DB / SQL は一切変更していない（本層は body の一部を組むだけ）。

| selector | 呼び出し元(client) | POST 先 route | body 範囲 | 含む memory source | latest / 件数上限 / fallback | proto-selector 由来 |
|---|---|---|---|---|---|---|
| `buildConsultationRequestContext` | `consultation/page.tsx` の `buildConsultationContext(gdResultId?)` | `/api/career/consultation` | message/history を除く横断 context 全部 | profile, activity(raw→route圧縮), values, selfAnalysis/es/interview/presentation history(各3), companyResearch(5), gd(id優先/最新2), gdRoom(3), matching(2) | history=3 / companyResearch=5 / gd=最新2(id深リンク優先) / gdRoom=3 / matching=2。空は空配列で残る | 旧 page-local `buildConsultationContext`（key順・件数・fallback 完全一致） |
| `buildInterviewRequestContext` | `interview/contextSource.ts` の `buildInterviewContextPayload(researchLogId?)` | `/interview/start`・`/turn`・`/complete` | payload 全体（`{ ...payload, interviewType, target }` 等） | profile, activity, values, selfAnalysis(最新1), es(最新1), matching(最新1), consultationInsights(最大5・dedup), companyResearch(選択1件) | latest=`logs[0].result`／未選択・失敗は null／insights ≤5 | 旧 `contextSource.buildInterviewContextPayload`（型 `CareerInterviewContextPayload` を selector から re-export し importer 互換維持） |
| `buildPresentationRequestContext` | `presentation/contextSource.ts` の `buildPresentationContextPayload()` | `/presentation/theme`・`/evaluate`・`/qa` | payload 全体（`{ ...ctx, ... }`） | profile, activity, values, selfAnalysis(最新1), es(最新1), interview(最新1), matching(最新1), consultationInsights(最大5) | latest=`logs[0].result`／null fallback／insights ≤5（interview と同一 `collectConsultationInsights` を共有） | 旧 `contextSource.buildPresentationContextPayload`（型 `CareerPresentationContextPayload` を re-export） |
| `buildMatchingRequestContext` | `matching/page.tsx` の `buildMatchingContext(gdResultId?)` | `/api/career/matching` | `{ ...ctx, userInput }` の ctx 部 | profile, activity, values, selfAnalysis(最新1), es(最新1), interviewResult(最新1), consultation(最新thread末尾assistant), gdSnapshot(id優先/最新), gdRoomSignals(3) | latest=`logs[0].result`／GD は id 深リンク→最新の順で fallback／gdRoom=3 | 旧 page-local `buildMatchingContext`（key順・latest・GD fallback・件数一致） |

**P4-A 設計との整合:** §D の route 別契約（history=3 / companyResearch=5 / matching=2、cross は要約・件数上限つき）と
一致する。相違点は「設計 §C の `CareerMemorySnapshot`（block 単位の中央 snapshot 型）には**まだ寄せていない**」こと。
現状 4 selector は各 route の **既存 request body 形状をそのまま返す薄い純関数**であり、`CareerMemorySnapshot` /
`CareerMemoryPurposePolicy` への統一は P4-A の設計宣言のまま（型は `types.ts` に存在するが未接続）。これは
「byte 不変で抽出」を最優先した結果であり、設計とのズレではなく **段階導入の途中状態**として妥当。

### H-2. B判定 route（selector 抽出を行わない方針）

以下は「専用 selector を切り出す利得が薄い / 抽出が byte リスクを上げる」ため、**現状の inline 構造を維持**する。

- **self-analysis（P4-F: B判定）** — route は `self-analysis/route.ts`（結果生成）と `self-analysis/question/route.ts`
  （深掘り質問）。run page の body は `{ profile, activity, values, pastSummaries }` の **pass-through**
  （`pastSummaries` = `buildSelfAnalysisPastSummaries` の軽量サマリ）。coverage 棚卸し
  （`formatCoverageForPrompt(buildCoverageInventory(...))`）は **route 側**で生成。cross-feature aggregation なし。
  → 横断 memory を組む selector 層が不要なため抽出対象外。
- **ES（P4-G: B判定）** — body は `es/run/page.tsx` の `handleRun` 内**インライン** `JSON.stringify({...})`。
  memory 由来値（profile/activity/values/selfAnalysis）と **UI フォーム値**（userInput/question/charLimit/
  companyName/selectionType/industry/jobType）が同一 object に混在し、`companyResearchContext` が**非連続の最終 key**。
  抽出すると memory 部と UI 部を分離することになり **key-order byte リスク**が上がる。利得も薄いため見送り。
  - **es-review** — route は `es-review/route.ts`。body は `{ answer, question, companyName, charLimit,
    selectionType, industry, jobType, companyResearchContext }`（`es/result/page.tsx` の `runReview`）。
    profile/activity/values/selfAnalysis 等の**横断 base memory は持たない**。唯一の cross-feature 値は
    添削対象に紐づく `companyResearchContext`（選択企業1件のスナップショット）のみで、これは §C の
    「es_review は base 不使用・添削対象本文は user 側」の設計と整合。中央 memory aggregation は実質ゼロ。
- **company-research（B判定・read-only 所見）** — ES と同型。`company-research/do/page.tsx` が `useMemo` の
  **latest-pick**（`selfAnalysis = logs[0].result` / `matching = logs[0].result`）+ basicInfo/activity/values memo を持ち、
  body を**インライン** `JSON.stringify({ profile, activity, values, selfAnalysis, matching })` で組む。route は
  `buildCareerAiContext` → `buildCareerContextForPurpose('company_research_review', ...)` を通す。
  **専用 proto-selector は無し**。追加抽出の利得は薄い見込み。将来 cross-feature 拡張が入るなら
  fresh byte harness つきで再検討する（現時点は現状維持）。

### H-3. self-analysis summary の mechanical 統合は不可（現時点）

`buildSelfAnalysisHistory`（consultation 用・`historySnapshots.ts`）と
`buildSelfAnalysisPastSummaries`（deep-dive 用・`pastLogSummary.ts`）は **mechanical merge 禁止**。根拠:

- **summary truncate が異なる**: consultation=`truncate(r.summary, 160)` / deep-dive=`truncate(r.summary, 140)`。
- **共通 field の object key 位置が異なる**: consultation snapshot は
  `createdAt, summary, careerDirection, strengths, weaknesses, recommendedIndustries, ...`（valueKeywords/
  strengthKeywords/nextActions を持たず、gakuchikaIdeas を持つ）。deep-dive summary は
  `... weaknesses, valueKeywords, strengthKeywords, recommendedIndustries, ...`（valueKeywords/strengthKeywords/
  nextActions を持ち、gakuchikaIdeas を持たない）。→ 共通 field（recommendedIndustries 等）の **key index がズレる**。
- 両者とも request body に `JSON.stringify` され、**key 順が byte に直結**する（consultation は
  `selfAnalysisHistory`、deep-dive は `pastSummaries` として送出）。
- 「共通コア + consumer 別 projection」は**将来設計としては可能**だが、**現時点では実装しない**。
- 新 consumer が出た時のみ、**fresh byte harness 付き**で再検討する（§G-2 の引き継ぎを本判断で確定）。

### H-4. latest-pick helper 化は見送り（現時点）

- `logs.length > 0 ? logs[0].result : null` の反復は selector.ts に存在する
  （interview/presentation/matching の selfAnalysis/es/interview/matching pick、計 9 箇所前後）。
- helper 化自体は **byte-safe**（純関数・同一式）だが、**実利が薄い**。
- 加えて page 側（company-research/do・interview 等）は同型を `useMemo` **境界内**で持つため、揃えると
  UI の useMemo 境界に **churn** が出る。
- よって **現時点では実装しない**。反復は許容し、必要になった時点で selector 内のみに閉じた helper 化を検討する。

### H-5. P4 mechanical 抽出フェーズの自然境界

P4-C〜P4-E2 で「page-local proto-selector を byte 不変で `lib/careerMemory/selector.ts` へ寄せる」対象は **出尽くした**。
残る consultation-body 系（self-analysis / ES / company-research）は §H-2 の通り **B判定**で、これ以上の mechanical 抽出は
byte リスクに見合わない。したがって:

- **mechanical 抽出フェーズ（P4-C〜P4-H）はここが自然な打ち切り点**。
- 次の実利は「型の統一」= §C `CareerMemorySnapshot` / §D `CareerMemoryPurposePolicy` への接続だが、これは
  byte 不変では済まない（block 形状・key 順が変わる）ため、**mechanical refactor ではなく設計変更**として、
  fresh byte harness とセットで別フェーズ（P5 想定）に切る。
- それまでは 4 selector = 各 route の request body を返す薄い純関数、という現状を **正**とする。

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

---

## I. P5: snapshot→projection 接続完了（P5-G 監査 / 2026-07-09）

> §H-5 が P5 想定として切り出した「型の統一」の第一段階（**byte 不変での 2 段パイプライン接続**）の完了記録。
> P5-C〜P5-F で 4 selector すべてを `build*Snapshot` → `project*RequestContext` 経路へ接続した結果を、
> P5-G で **read-only 監査**し本節に反映した（本節は docs のみ追加）。
> production code / selector / snapshot / route / prompt / AI schema / storage / DB / SQL は **不変**。
> secret / env / token / Supabase URL / service_role / API key は非参照・非出力。

### I-1. P5-C〜F の実装コミット

| フェーズ | 対象 selector | commit |
|---|---|---|
| **P5-C** matching | `buildMatchingRequestContext` | `151d5de refactor(career): route matching memory through snapshot projection` |
| **P5-D** presentation | `buildPresentationRequestContext` | `fb48e3f refactor(career): route presentation memory through snapshot projection` |
| **P5-E** interview | `buildInterviewRequestContext` | `2854ea8 refactor(career): route interview memory through snapshot projection` |
| **P5-F** consultation | `buildConsultationRequestContext` | `28f8f58 refactor(career): route consultation memory through snapshot projection` |

> 前提: `c8ca536`（P5-A/B 由来の memory snapshot mapping harness 追加）で常設 byte harness を整備し、
> `lib/careerMemory/snapshot.ts`（additive snapshot + projection）と
> `lib/careerMemory/purposeMapping.ts`（type-only purpose 対応表）を先に地ならししてある。

### I-2. 4 selector の現状態

`lib/careerMemory/selector.ts` の 4 selector はすべて内部が **snapshot→projection の 2 段**に統一済み。

| selector | 経路 | externals |
|---|---|---|
| `buildMatchingRequestContext` | `buildMatchingSnapshot` → `projectMatchingRequestContext` | `gdResultId`（深リンク選択 id） |
| `buildPresentationRequestContext` | `buildPresentationSnapshot` → `projectPresentationRequestContext` | なし |
| `buildInterviewRequestContext` | `buildInterviewSnapshot` → `projectInterviewRequestContext` | 選択 `companyResearchLog`（id→log 解決済み1件） |
| `buildConsultationRequestContext` | `buildConsultationSnapshot` → `projectConsultationRequestContext` | `gdResultId`（深リンク選択 id） |

各 selector の使わない source は空配列で snapshot input へ渡す（snapshot は未参照）。外部インターフェース
（`*SelectorInput` / 返り値形状）と POST 先 route・request body は **不変**で、page/contextSource(client) 側は変わらない。

### I-3. selector と snapshot の責務分担

- **`selector.ts` は薄い委譲層**になった。各 selector は「client が load* した生データを `*Snapshot` input へ
  詰め替え、externals を渡し、対応する projection を呼んで返す」だけ。build*/normalize* の**直接呼び出しは消え**、
  selector.ts からの block helper import は不要になった（`./snapshot` から build/project のみ import）。
- **実際の memory block 組み立ては `snapshot.ts` に集約**された。history 件数上限（3）・companyResearch(5)・
  gd(id 優先/最新2)・gdRoom(3)・matching(2)・latest pick（`logs[0].result`）・consultationInsights の dedup(≤5)・
  companyResearch の throw→null fallback など、**旧 selector が持っていた private helper と件数ロジックは
  snapshot.ts 側の builder へ 1:1 で移設**済み（`gdConsultationContext` / `collectConsultationInsights` /
  `resolveInterviewCompanyResearch` / `latestConsultationResult` 等）。
- **projection は key 順の復元のみ**を行う。snapshot が保持する block を、既存 request body の key 順どおりに
  並べ替えて返すだけ（要約・truncate・件数変更はしない）。→ 出力は旧 selector と **byte 一致**する。

### I-4. purpose mapping の位置づけ

`lib/careerMemory/purposeMapping.ts` は **type-only の共存対応表**であり、production flow には**未接続**のまま。
live registry（`lib/careerContext/purpose.ts` の `CAREER_CONTEXT_REGISTRY`。route の base system prompt 生成に使用中）と
design registry（`lib/careerMemory/types.ts` の `CareerMemoryPurpose`）を**統一せず**、対応関係（interview→practice/complete の
1:N、gd_solo/gd_multiplayer_result→gd_feedback の N:1 等）を型安全に宣言するだけ。P5 の snapshot 接続は
この対応表を runtime へ接続しない（registry 統合は保留のまま）。

### I-5. raw base 維持の理由 / `BaseMemorySummary` 未接続の理由

- snapshot の `base`（profile/activity/values）は **raw のまま carry**。§C 設計の `BaseMemorySummary`
  （PII 除外・activity compact の**別形状**）へは接続していない。
- 理由: `BaseMemorySummary` 化は base prompt の **byte を意図的に変える**設計変更であり、P5 の「byte 不変で
  2 段パイプラインへ寄せる」目的と両立しない。§H-5 の通り、block 形状・key 順が変わるものは mechanical refactor
  ではなく設計変更として別フェーズに切る方針。よって P5 では **raw base を守り**、`BaseMemorySummary` は**未接続**。
- 同様に、strict な `CareerMemorySnapshot` / `*MemorySummary`（要約型）は interview/presentation/matching が運ぶ
  latest の **full result**、consultation が運ぶ `*HistorySnapshot` を byte 復元できないため、snapshot.ts は
  設計型に**寄せた block 構造**（faithful interim carrier）に留め、strict 変換は繰り延べている。

### I-6. externals の扱い

selected id / 選択ログは **snapshot 外 input**（builder の第2引数 `CareerMemorySnapshotExternals`）として扱い、
snapshot object 内には**計算結果のみ**を保持する。

- **`gdResultId`**: consultation / matching が使用。指定時はその1件を優先（`buildGdConsultationSnapshotById` /
  `buildGdMatchingSnapshotById`）、無ければ最新へ fallback。projection は外部 id を必要としない。
- **selected `companyResearchLog`**: interview のみ。id→log の解決は呼び出し側（contextSource）の責務。
  snapshot builder は解決済み1件を受け取り `buildInterviewCompanyResearchContext`（throw→null）で context 化する。

### I-7. 常設 harness（byte 不変ガード）

4 selector の返り値が旧実装と byte 一致することを、以下の常設 harness scripts が担保する。

| npm script | scripts ファイル | ケース数 |
|---|---|---|
| `npm run qa:careerMemoryMatching` | `scripts/career-memory-matching-byte-qa.ts` | 18/18 ALL_MATCH |
| `npm run qa:careerMemoryPresentation` | `scripts/career-memory-presentation-byte-qa.ts` | 16/16 ALL_MATCH |
| `npm run qa:careerMemoryInterview` | `scripts/career-memory-interview-byte-qa.ts` | 18/18 ALL_MATCH |
| `npm run qa:careerMemoryConsultation` | `scripts/career-memory-consultation-byte-qa.ts` | 32/32 ALL_MATCH |

**84 ケース ALL_MATCH の意味**: 各 harness は「旧 build*/normalize* 直呼びで組んだ期待 body」と「snapshot→projection
経由の現 selector 出力」を `JSON.stringify` レベルで突き合わせる。全 84 ケースが一致 = 4 selector の
経路差し替えが **request body の byte を 1 bit も変えていない**ことの回帰ガード。これらは
**旧 byte 一致 harness**（現行 prompt/body を守るためのもの）であり、新期待値ベースではない。

### I-8. P5 で完了したこと / P6 に残したこと

**P5 で完了:**

- 4 selector すべてを `build*Snapshot` → `project*RequestContext` の 2 段経路へ接続（P5-C〜F）。
- selector.ts を薄い委譲層化し、block 組み立てを snapshot.ts へ集約。
- 84 ケースの常設 byte harness で「経路差し替え = byte 不変」を担保。
- raw base を守り、externals（gdResultId / 選択 companyResearchLog）を snapshot 外 input として整理。

**P6 に残すもの（byte-breaking 設計変更フェーズ）:**

- strict な `CareerMemorySnapshot` / `BaseMemorySummary` / `*MemorySummary` への寄せ（要約型化）。
- base の PII 除外・activity 圧縮（`BaseMemorySummary` 接続）。
- prompt / body byte を**意図的に変える**設計変更（現行 raw carry からの離脱）。
- self-analysis summary 二重化（`buildSelfAnalysisHistory` × `buildSelfAnalysisPastSummaries`。§H-3）の
  **共通コア + consumer 別 projection** への統合。
- 旧 byte 一致 harness から、**新期待値ベースの harness** への切り替え（byte が変わる前提で期待値を更新）。

> P6 は §H-5 の通り mechanical refactor ではなく **byte-breaking フェーズ**として扱う。P6-A で strict memory
> summary / `BaseMemorySummary` の設計監査を先に行い、fresh byte harness とセットで段階導入する。

---

## J. P6 byte-breaking memory summary phase（P6-A 監査結論 + P6-B 基盤 / 2026-07-09）

> P6-A の read-only 設計監査結論と、P6-B で追加した prompt-level golden 基盤の記録。
> P6-B 時点では **production route / prompt / selector / snapshot / AI schema / DB は不変**（harness・fixtures・
> docs・package script のみ追加）。secret / env / token / Supabase URL / service_role / API key は非参照・非出力。

### J-1. P6-A の結論 — base 削減は memory 層ではなく route/orchestrator 層で行う

監査で判明した決定的事実:

- **base（profile/activity/values）の prompt 化は route 層で起きている**。selector は生 profile/activity/values を
  request body に carry するだけで、prompt は route が
  `buildCareerAiContext` → `buildCareerContextForPurpose` → `buildCareerSystemPrompt` →
  `renderProfile/renderActivity/renderValues` で組む。
- `buildCareerContextForPurpose` は **byte 恒等 wrapper**で、[`orchestrator.ts`](../../lib/careerContext/orchestrator.ts) の
  `omitted: []` はハードコード。`CAREER_CONTEXT_REGISTRY` の `profile:minimal` 等の policy は**宣言のみで未強制**。
- cross-feature block は orchestrator ではなく **route-local / shared-builder-local の render 関数**が組む。

→ 結論: **base 削減（PII 除外・activity 圧縮）は memory 層の `BaseMemorySummary` ではなく、
route/orchestrator 層で行う**。`BaseMemorySummary` 型（[`types.ts`](../../lib/careerMemory/types.ts)）は
**型として温存し、既存 prompt には接続しない**。実削減は orchestrator policy の**通電**（`omitted` を実装し
`renderProfile` を policy 駆動にする）で行い、新しい base prompt builder は並立させない。

### J-2. 2 つの byte 面 — P5 harness と P6 harness の守備範囲

| byte 面 | 実体 | 守る harness | 効くもの |
|---|---|---|---|
| **request body byte** | selector 出力の `JSON.stringify` | P5: `qa:careerMemory{Matching,Presentation,Interview,Consultation}`（84 ケース） | ネットワーク payload / body 形状の回帰 |
| **system prompt byte** | `render*` 出力 = 実 system prompt string | **P6-B 新設: `qa:careerMemoryPromptGolden`** | **AI 挙動 / token / cache / PII** |

P5 harness は body byte しか守らない。P6 の PII 除外・token 削減は **prompt byte 面**で発生するため、
P6-B で prompt golden harness を新設した。

### J-3. P6-B で追加した prompt golden harness

[`scripts/career-memory-prompt-golden-qa.ts`](../../scripts/career-memory-prompt-golden-qa.ts)（`npm run qa:careerMemoryPromptGolden`）:

- **対象 purpose（live `CareerContextPurpose` 単位）**: `consultation` / `matching` / `interview_practice` /
  `interview_complete` / `presentation_feedback`。consultation のみ route と同じ
  `compressCareerActivityForConsultation` を通す。`interview_complete` の base は `interview_practice` と同一
  （base builder 共有）であることを golden で確認。
- **経路**: `buildCareerAiContext` → `buildCareerContextForPurpose` → `buildCareerSystemPrompt` →
  `renderProfile/renderActivity/renderValues` を通した base system prompt string を golden 比較。
- **fixtures**: `scripts/fixtures/prompt-golden/{purpose}__{case}.txt`（1 prompt 1 ファイル・diff 容易）。
  case は `normal` / `heavy` / `pii-profile` / `activity-multi-section` / `values-notes` の 5 種 × 5 purpose = 25 golden。
- **golden 更新**: `--update`（または `UPDATE=1`）で現在の出力を golden に上書き。P6-C 以降で prompt を
  意図的に変える際は `--update` で golden を更新し、diff をレビューする運用。
- **初回**: current output = golden として bootstrap 済み。`ALL_MATCH`。

### J-4. PII / raw baseline（P6-B は検出のみ・fail させない）

- 現状 `renderProfile` は system prompt に **`- 氏名:` 行を出力**している（25/25 ケースで検出）。
  `備考`（notes）経由でメール等 PII が載るケースもある（pii-profile 等 5/25）。
- P6-B では **fail させず baseline 報告**に留める（現状の prompt 出力を壊さない）。
  harness は `guardRawText` を base context の key ベースで通し、findings 数も baseline として出す。
- rawTextGuard の既存 self-check（budget-qa 側）は **findings 不増**を確認済み（production 未変更のため）。
- **P6-C 以降**: `expectNoProfilePii`（氏名行 = 0）のような **strict assertion** に切り替える。
  それまでは golden がそのまま「PII が載っている現状」を固定する。

### J-5. prompt length baseline（文字数ベース / token 実測ではない）

P6-B harness は purpose × case ごとに prompt 全体 / profile / activity / values の**文字数**を出力する
（token 実測ではない旨を明記）。P6-C 以降の base 削減の効果測定の起点とする。目安:

- profile section: normal ≈ 117 字 / heavy ≈ 290 字 / pii-profile ≈ 120 字。
- activity section: heavy ≈ 802 字（consultation の圧縮は fixture の各 field が 160 字閾値未満のため本 fixture では identity）。
- values section: values-notes ≈ 233 字。

### J-6. strict `*MemorySummary` 化の優先順（P6-C 以降）

- **優先**: `es` / `interview` / `presentation` の latest full result → summary 化（本文派生が重く要約耐性が高い）。
- **後回し**: `companyResearch` / `gd`（既に signal 化済みで削減余地が小さい）。
- **最後**: `consultation`（司令塔の現在地 signal が薄まる品質リスクが高い）。
- 注意: snapshot が full result を carry していても、prompt に何が出るかは `render*` が field 選択する。
  **「body だけ縮んで token が変わらない」罠**を避けるため、各 block で `render*` 出力サイズを先に測ってから型を確定する。

### J-7. self-analysis summary 二重化（§H-3 の P6 版）

- `buildSelfAnalysisHistory`（consultation）× `buildSelfAnalysisPastSummaries`（deep-dive）の共通コア化は、
  **新 expected fixture（consultation 用 / deep-dive 用の期待 JSON）を先に置いてから**行う。
- P6 は byte-break 許容のため、truncate 差（160 / 140）は**統一**してよい。共通 `SelfAnalysisLatest` を実体に採用し、
  consumer 別 field（consultation: `gakuchikaIdeas` / deep-dive: `valueKeywords` `strengthKeywords` `nextActions`）は
  projection で出し分ける。

### J-8. migration strategy（P6 推奨順序）

1. **prompt golden harness**（P6-B 完了）。
2. **baseline PII/raw report**（P6-B 完了・fail させない）。
3. **orchestrator policy pilot**（P6-C）— `omitted` を実装し 1 purpose で policy を通電。golden を意図更新。
4. **base 削減 pilot**（P6-C）— `renderProfile` から PII（氏名）を除外。`expectNoProfilePii` へ strict 化。
5. **budget 差分測定**（文字数ベース）で削減効果を確認。
6. **strict `*MemorySummary` 展開**（es → interview → presentation → companyResearch/gd → consultation の順）。
7. **self-analysis 共通コア化**（新 expected fixture 先行）。

原則: **新 harness を byte 保存で先に立ててから**（step 1–2）byte-break（step 3 以降）に入る。
最初の byte-break は base 削減 pilot（PII 除外）を **1 purpose 限定**で行い、golden 更新差分をレビューする。

### J-9. P6-C pilot 結果 — matching profile PII 除外（orchestrator policy 通電・初回 byte-break）

migration strategy step 3–5 を **matching 限定**で実施した記録。

**通電箇所（最小差分）:**
- [`purpose.ts`](../../lib/careerContext/purpose.ts): `CAREER_CONTEXT_REGISTRY.matching.profile` を `'include'` → **`'minimal'`**。
- [`orchestrator.ts`](../../lib/careerContext/orchestrator.ts): `buildCareerContextForPurpose` に policy 通電を追加。
  `policy.profile === 'minimal'` の purpose は、prompt 生成用 **context のコピー**から構造化 PII（氏名 = `profile.name`）を
  除去し、`omitted` に `['profile.name']` を積む（`omitted: []` 固定を解除）。
  `renderProfile` の `push('氏名', '')` が空値を捨てるため **`prompts.ts` は無変更**で氏名行が消える。
  現状 `minimal` を実際に base 描画する purpose は matching のみ（es_review は静的 SYSTEM_PROMPT・mypage 未実装で
  本 builder を通らない）ため、実効は **matching pilot に限定**される。include の他 purpose は byte 一致（挙動不変）。

**変更しなかったもの（重要）:**
- **request body byte は不変**。selector は生 profile（氏名含む）を carry し、route まで raw で届く。
  除去は prompt 生成用 context のコピー内のみ（本体 object・fetch body・snapshot は不変）。
  → 84 ケースの body-byte harness は **ALL_MATCH 継続**。
- `BaseMemorySummary` は**未接続**（memory 層は使わず route/orchestrator 層で削減）。
- activity / values の削減は**まだしない**（policy は宣言のまま）。備考等 **自由記述内の email pattern は baseline のまま**
  （構造化 PII のみ除去）。

**prompt golden（system prompt byte）:**
- matching の 5 golden のみ意図的に更新（`matching__{normal,heavy,pii-profile,activity-multi-section,values-notes}.txt`）。
  diff は各ファイル **`- 氏名: …` 1 行の削除のみ**。他 20 golden（consultation/interview/presentation）は**不変**。

**PII assertion（P6-C で matching のみ strict 化）:**
- harness に `PII_STRICT_PURPOSES = {'matching'}` を追加。matching は **氏名行 0 を要求（strict PASS）**、
  他 purpose は **baseline（氏名行が残っても fail させない）**。exit code は golden 一致 + matching strict の両方で決まる。
- 結果: matching 氏名行 **0/5（strict PASS ✅）** / others 氏名行 20/20（baseline・現状維持）。

**prompt length before/after（文字数ベース / token 実測ではない）:**

| matching case | total before→after | profile section before→after | 削減 |
|---|---|---|---|
| normal | 969 → 958 | 117 → 106 | −11 |
| heavy | 1999 → 1988 | 290 → 279 | −11 |
| pii-profile | 781 → 770 | 120 → 109 | −11 |
| activity-multi-section | 1274 → 1264 | 41 → 31 | −10 |
| values-notes | 955 → 943 | 42 → 30 | −12 |

削減は氏名行（`- 氏名: {name}\n`）分のみで total と profile section が同幅で縮む。他 purpose の length は不変。
`guardRawText` findings は **100 件のまま**（raw data 側は氏名を保持しているため。prompt 側だけ落とす設計）。

**残課題 / 次工程の判断材料:**
- 次は (a) matching の **activity/values 削減**へ進む（`activity:'compact'` / `values` policy 通電）か、
  (b) **profile PII 除外を他 purpose へ展開**（consultation/interview/presentation を順次 minimal + PII_STRICT へ）か。
  base の PII は全 purpose 共通の課題なので **(b) を先に横展開**して氏名除外を揃え、その後 (a) の block 削減へ進むのが
  blast radius を段階化できて安全（各展開で該当 golden のみ更新）。

### J-10. P6-D pilot 結果 — presentation profile PII 除外の横展開

J-9 の判断材料 (b) に従い、P6-C の仕組みを **presentation_feedback** へ横展開した記録。**presentation のみ**対象で、
matching(P6-C) の state は維持し、consultation / interview は未変更。

**policy 変更箇所（orchestrator は無変更）:**
- [`purpose.ts`](../../lib/careerContext/purpose.ts): `CAREER_CONTEXT_REGISTRY.presentation_feedback.profile` を
  `'include'` → **`'minimal'`**。
- **[`orchestrator.ts`](../../lib/careerContext/orchestrator.ts) は変更不要**。P6-C の `profile:minimal → 氏名 strip` は
  purpose 非依存の汎用ロジックのため、policy を minimal にするだけで presentation にも自動適用される
  （evaluate/theme/qa が共有する base builder 経由）。
- [harness](../../scripts/career-memory-prompt-golden-qa.ts): `PII_STRICT_PURPOSES` に `presentation_feedback` を追加
  （`{'matching','presentation_feedback'}`）。strict report を purpose 別内訳に変更。

**変更しなかったもの:**
- **request body byte 不変**（selector は生 profile を carry・presentation body-byte harness 16/16 ALL_MATCH）。
- `prompts.ts`（renderProfile 等）無変更 / `BaseMemorySummary` 未接続 / activity・values 削減なし /
  自由記述内 email pattern は baseline のまま。

**prompt golden（system prompt byte）:**
- presentation の 5 golden のみ更新。diff は各ファイル **`- 氏名: …` 1 行の削除のみ**。
  matching golden（P6-C 済）・consultation・interview の golden は**不変**。

**PII assertion 結果:**
- matching 氏名行 **0/5（strict PASS ✅）**（P6-C 維持）。
- presentation_feedback 氏名行 **0/5（strict PASS ✅）**（P6-D 新規）。
- others（consultation + interview_practice + interview_complete）氏名行 **15/15（baseline・fail させない）**。

**prompt length before(P6-B)/after（文字数ベース / token 実測ではない）:**

| presentation case | total before→after | profile section before→after | 削減 |
|---|---|---|---|
| normal | 999 → 988 | 117 → 106 | −11 |
| heavy | 2029 → 2018 | 290 → 279 | −11 |
| pii-profile | 811 → 800 | 120 → 109 | −11 |
| activity-multi-section | 1304 → 1294 | 41 → 31 | −10 |
| values-notes | 985 → 973 | 42 → 30 | −12 |

matching は P6-C 後の値を維持、consultation / interview は不変。`guardRawText` findings は **100 件のまま**。

**次工程の判断:**
- 横展開は残り **interview**（`interview_practice` / `interview_complete` は base builder 共有なので
  policy 1 箇所で両方に効く）。次は **interview の profile PII 除外**へ進む。
- **consultation は最後に回す**：compressCareerActivityForConsultation・全機能集約で base 描画の影響面が最大のため、
  他 3 系統（matching/presentation/interview）を揃えてから最後に strict 化する。
- 全 purpose の PII 除外が揃った後に、block 削減（activity/values policy 通電・strict `*MemorySummary` 化）へ進む。

### J-11. P6-E pilot 結果 — interview profile PII 除外の横展開

J-10 の方針に従い、interview 系（`interview_practice` / `interview_complete`）へ横展開した記録。**interview 系のみ**対象で、
matching(P6-C) / presentation(P6-D) の strict state は維持し、consultation は未変更（唯一の baseline）。

**policy 変更箇所（orchestrator は無変更）:**
- [`purpose.ts`](../../lib/careerContext/purpose.ts): `interview_practice.profile` と `interview_complete.profile` を
  `'include'` → **`'minimal'`**。両者は base builder 共有（start/turn/complete が `interview_practice` 経由）だが、
  policy 整合のため `interview_complete` も揃える。
- **[`orchestrator.ts`](../../lib/careerContext/orchestrator.ts) は変更不要**（P6-C の汎用ロジックを再利用）。
- [harness](../../scripts/career-memory-prompt-golden-qa.ts): `PII_STRICT_PURPOSES` に
  `interview_practice` / `interview_complete` を追加（計 4 purpose strict）。baseline は consultation のみ。

**変更しなかったもの:**
- **request body byte 不変**（selector は生 profile を carry・interview body-byte harness 18/18 ALL_MATCH）。
- `prompts.ts` 無変更 / `BaseMemorySummary` 未接続 / activity・values 削減なし / 自由記述内 email pattern は baseline のまま。

**prompt golden（system prompt byte）:**
- interview 系の 10 golden のみ更新（`interview_practice__*` / `interview_complete__*` 各 5）。
  diff は各ファイル **`- 氏名: …` 1 行の削除のみ**。`interview_practice` と `interview_complete` の golden は
  同一内容（base builder 共有の裏付け）。matching / presentation / consultation の golden は**不変**。

**PII assertion 結果:**
- matching 氏名行 **0/5（strict PASS ✅）**（P6-C 維持）。
- presentation_feedback 氏名行 **0/5（strict PASS ✅）**（P6-D 維持）。
- interview_practice 氏名行 **0/5（strict PASS ✅）**（P6-E 新規）。
- interview_complete 氏名行 **0/5（strict PASS ✅）**（P6-E 新規）。
- consultation 氏名行 **5/5（baseline・fail させない）**（唯一の残り baseline）。

**prompt length before(P6-B)/after（文字数ベース / token 実測ではない）:**

| interview case | total before→after | profile section before→after | 削減 |
|---|---|---|---|
| interview_practice normal | 852 → 841 | 117 → 106 | −11 |
| interview_practice heavy | 1882 → 1871 | 290 → 279 | −11 |
| interview_complete normal | 852 → 841 | 117 → 106 | −11 |
| interview_complete heavy | 1882 → 1871 | 290 → 279 | −11 |

matching / presentation は既存削減後の値を維持、consultation は不変。`guardRawText` findings は **100 件のまま**。

**次工程の判断:**
- 残りは **consultation のみ**。`compressCareerActivityForConsultation` を通した base + 全機能集約で影響面が最大のため、
  最後に P6-F として `consultation.profile` を minimal 通電 + strict 化する（consultation golden 5 件のみ更新）。
- consultation まで揃えば **全 purpose の profile PII（氏名）除外が完了**し、次の block 削減フェーズ
  （activity/values policy 通電・strict `*MemorySummary` 化：ES→interview→presentation の順）へ移行できる。

### J-12. P6-F 結果 — consultation profile PII 除外（横展開完了 / profile PII フェーズ終了）

J-11 の方針どおり、最後の consultation へ横展開し、**golden 対象の全 live purpose の profile 氏名 PII 除外を完了**した記録。

**policy 変更箇所（orchestrator は無変更）:**
- [`purpose.ts`](../../lib/careerContext/purpose.ts): `CAREER_CONTEXT_REGISTRY.consultation.profile` を
  `'include'` → **`'minimal'`**。
- **[`orchestrator.ts`](../../lib/careerContext/orchestrator.ts) は変更不要**（P6-C の汎用 `minimal → 氏名 strip` を再利用）。
- consultation の `activity: 'compact'`（route 側 `compressCareerActivityForConsultation`）は **base の別処理**であり、
  PII strip とは独立。activity 圧縮挙動には影響しない（heavy golden でも diff は氏名行のみ = 0 added / 1 deleted）。
- [harness](../../scripts/career-memory-prompt-golden-qa.ts): `PII_STRICT_PURPOSES` に `consultation` を追加（計 **5 purpose**）。
  baseline purpose が無くなったため report を「PII baseline purpose なし」に分岐。

**変更しなかったもの:**
- **request body byte 不変**（selector は生 profile を carry・consultation body-byte harness 32/32 ALL_MATCH）。
- `prompts.ts` 無変更 / **`BaseMemorySummary` 未接続のまま** / activity・values 削減なし /
  自由記述内 email pattern は baseline のまま（5/25 ケース残存）。

**prompt golden（system prompt byte）:**
- consultation の 5 golden のみ更新。各ファイル **0 added / 1 deleted = `- 氏名: …` 1 行削除のみ**（heavy 含む）。
  matching / presentation / interview の golden は**不変**。

**PII assertion 結果（golden 対象の全 live purpose が strict・baseline なし）:**
- matching **0/5 ✅** / presentation_feedback **0/5 ✅** / interview_practice **0/5 ✅** /
  interview_complete **0/5 ✅** / consultation **0/5 ✅**。
- **baseline purpose: なし**（氏名行 total 0/25）。

**prompt length before(P6-B)/after（文字数ベース / token 実測ではない）:**

| consultation case | total before→after | profile section before→after | 削減 |
|---|---|---|---|
| normal | 837 → 826 | 117 → 106 | −11 |
| heavy | 1867 → 1856 | 290 → 279 | −11 |
| pii-profile | 649 → 638 | 120 → 109 | −11 |
| activity-multi-section | 1142 → 1132 | 41 → 31 | −10 |
| values-notes | 823 → 811 | 42 → 30 | −12 |

matching / presentation / interview は既存削減後の値を維持。`guardRawText` findings は **100 件のまま**
（raw data 側は氏名を保持し prompt 側だけ落とす設計）。

**profile PII 除外フェーズ 完了サマリ（P6-C〜P6-F）:**
- 5 live purpose（matching / presentation_feedback / interview_practice / interview_complete / consultation）すべてで
  system prompt から氏名行を除去。**request body byte は全期間で不変**（body-byte harness 84/84 継続 ALL_MATCH）。
- 実装は `orchestrator.ts` の汎用 `profile:minimal → 氏名 strip`（P6-C の 1 箇所）+ 各 purpose の policy flip のみ。
  `prompts.ts` は最後まで無変更。`BaseMemorySummary` は未接続のまま。

**次フェーズ（P7 想定・block 削減）の候補と順序:**
- profile PII は完了。次は **block 削減**へ:
  1. **strict `*MemorySummary` 化**（byte-break の本命。ES → interview → presentation の順。full result → 要約型で token 削減）。
  2. **activity policy 通電**（`activity:'compact'`/`'exclude'` の実適用。現在 route 側圧縮に依存している部分を policy 化）。
  3. **values 削減**（notes 短縮等）。
- いずれも該当 purpose の golden 更新を伴う byte-break。**まず strict `*MemorySummary`（block 単位）から**入るのが、
  render\* 出力サイズの実測（§J-6 の「body だけ縮んで token 不変」の罠回避）とセットで効果が大きい。
- 自由記述内 PII（備考の email 等・現状 5/25）の strict 化は、activity/values 削減の際に併せて設計する。

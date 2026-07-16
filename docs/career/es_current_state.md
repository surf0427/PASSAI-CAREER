# 就活版 ES（エントリーシート）機能 現在仕様

> **役割**: ES 機能を「AIによる代筆」から「ユーザー自身が書く力を鍛えるESトレーニングシステム」へ
> 再設計した後の責務マップ。AIの役割は 深掘り質問 / 材料整理 / 添削 / 改善支援 に限定し、
> **ES本文はユーザーが書く**（[`docs/principles/ai_policy.md`](../principles/ai_policy.md) 厳守）。

関連: [ai_policy](../principles/ai_policy.md) / 受験版の同思想実装 [essay_current_state](../essay/essay_current_state.md)

---

## 4 機能（ハブ `/career/es`）

| # | 機能 | 種別 | 入口 |
|---|---|---|---|
| ① | 深掘りしながら書く | Do | `/career/es/new?mode=deep` |
| ② | 自力で書く | Do | `/career/es/new?mode=write` |
| ③ | 添削結果を見る | View | `/career/es/history` → `/career/es/[id]` |
| ④ | 改善する | Do | `/career/es/history` → `/career/es/[id]`（改善ボタンで次版） |

- ①②: Step1（`/career/es/new`）で 設問・文字数・企業名・業界・職種 を入力 → **作成中ドラフト**（`careerEsDrafts`）を作成 → `/career/es/draft/[draftId]` エディタへ。正式ログ（`careerEsLogs`）はまだ作らない。
- ① deep は draft エディタで先に深掘りQ&A（`EsDeepDivePanel`）→ 材料整理メモを保存 → 本文入力へ。進捗は draft へ autosave され、途中離脱・リロードから再開できる。
- draft エディタ「AI添削する」= **保存を確定**。添削成功時に初めて `careerEsLog(v1)`（body + review + deepDive）を作成し、draft を削除して `[id]` へ遷移する。添削失敗時は log を作らず draft を残す。
- `[id]` エディタ（保存済みログ専用）: 上=設問 / 左=整理メモ（deep）または前回添削（改善時） / 中央=本文 → AI添削（再添削）→ 版に保存。
- ④: `[id]` の「改善する」で同グループの次版（v+1）を作成。前版本文を初期表示・前回添削を左に表示・再添削で点数推移。

## バージョン管理

- 1 版 = 1 `CareerEsLog`。`groupId`（設問＋企業の束）＋`version`（1 始まり）でまとめる。
- 各版に `body`（本文）と `review`（添削結果）を**永続化**（従来 review は画面 state のみで未保存だった）。
- 版タイムライン（v1 72点 → v2 81点 …）を `[id]` に表示。history 一覧は group 別の最新版のみ。

## AI ルート（すべて課金/quota 非接続・localStorage canonical・Supabase mirror は best-effort）

| route | 役割 | 本文生成 |
|---|---|---|
| `POST /api/career/es-review` | 添削（6軸スコア＋良かった点＋改善点＋不足要素＋採用担当視点コメント） | **しない**（完成例 rewriteExample は廃止） |
| `POST /api/career/es/deep` | 深掘り質問（設問種別で質問数レンジを変える） | しない |
| `POST /api/career/es/organize` | Q&A→材料整理メモ | しない |

設問種別と質問数上限（`lib/careerEs/deepDivePrompt.ts` `esQuestionTurnCap`）:
ガクチカ 7 / 志望動機 5 / 自己PR 6 / 研究 7 / その他 5（設問文から `classifyEsQuestionType` で推定）。

## 責務マップ

| 層 | ファイル | 責務 |
|---|---|---|
| 型 | [`types/careerEs.ts`](../../types/careerEs.ts) | `CareerEsReview`（missingElements/recruiterComments・rewriteExample 廃止）/ `CareerEsLog`（body/review/groupId/version/mode/deepDive 追加） |
| storage | [`app/career/es/esStorage.ts`](../../app/career/es/esStorage.ts) | localStorage I/O・normalize・版管理ヘルパー（`loadEsGroupsLatest`/`loadEsGroupVersions`/`latestEsVersion`/`updateEsReview`）・factory（`createEsWorkspaceLog`/`newEsId`/`emptyEsResult`） |
| prompt | [`lib/careerEs/deepDivePrompt.ts`](../../lib/careerEs/deepDivePrompt.ts) | 深掘りQ&A の種別分類・質問数レンジ・seed/followup プロンプト |
| prompt | [`lib/careerEs/organizePrompt.ts`](../../lib/careerEs/organizePrompt.ts) | 材料整理メモ SYSTEM_PROMPT（本文禁止）+ user message builder |
| API | [`app/api/career/es-review/route.ts`](../../app/api/career/es-review/route.ts) | 添削（スコアは AI、rank/overallScore は決定論導出） |
| API | [`app/api/career/es/deep/route.ts`](../../app/api/career/es/deep/route.ts) | 深掘り質問（ステートレス・turns はクライアント送信） |
| API | [`app/api/career/es/organize/route.ts`](../../app/api/career/es/organize/route.ts) | 材料整理メモ生成 |
| UI | [`app/career/es/page.tsx`](../../app/career/es/page.tsx) | ハブ（4カード） |
| UI | [`app/career/es/new/page.tsx`](../../app/career/es/new/page.tsx) | Step1 設問メタ入力 → v1 作成 |
| UI | [`app/career/es/[id]/page.tsx`](../../app/career/es/[id]/page.tsx) | エディタ／詳細（深掘り・本文・添削・版・改善） |
| UI | [`app/career/es/history/page.tsx`](../../app/career/es/history/page.tsx) | ログ一覧（group 別最新版） |
| UI 部品 | [`app/career/es/components/EsReviewPanel.tsx`](../../app/career/es/components/EsReviewPanel.tsx) | 添削結果表示 |
| UI 部品 | [`app/career/es/components/EsDeepDivePanel.tsx`](../../app/career/es/components/EsDeepDivePanel.tsx) | 深掘りQ&A対話＋整理呼び出し |

## 作成中ドラフト（下書き）保存・再開

未完成の作成状態（深掘りQ&A・整理メモ・執筆中本文）は `careerEsLogs` とは**別ストア** `careerEsDrafts`
（[`app/career/es/esDraftStorage.ts`](../../app/career/es/esDraftStorage.ts)）に保存する。狙いは「未完成状態を横断機能・履歴に露出させない」こと。

- **正式ログ化のタイミング**: draft エディタの「AI添削」成功時のみ `careerEsLog` を作成する（＝保存の確定）。それ以前は draft のみ。
- **owner 境界**: 各 draft は `ownerId`（member=userId / guest=null）を持ち、読み込み時に現在の owner で絞り込む。他ユーザーの draft は復元しない。
- **schema version**: `ES_DRAFT_SCHEMA_VERSION`。不一致・壊れた draft は読み込み時に安全に破棄する（fail-safe。localStorage JSON parse error も `safeStorage` が吸収）。
- **autosave**: 設定・Q&A回答・質問進行・organize完了は即時保存、本文入力は約 700ms debounce（blur・添削前に flush）。外部 API への自動送信はしない。
- **再開UI**: `/career/es/new?mode=…` で同モードの未完成 draft を「続きから再開」として上部に表示（勝手に上書きしない。新規は別 draftId で作成）。
- **draft 削除**: (a) AI添削成功で正式ログ化したとき、(b) ユーザーが明示的に破棄したとき、のみ。API/添削/保存の失敗では削除しない。(a) は **正式ログの永続化を `loadEsLogById` で確認できたときだけ** 削除する（quota 超過などで `safeSetStorage` が黙って失敗した場合、正式ログも draft も失う本文消失を防ぐ）。
- **分離不変条件**: draft は matching / presentation / mypage / consultation / ES履歴 / 添削履歴 に露出しない（それらは `careerEsLogs` のみ読む）。draft は LRU 上限 20 件。

## storage キー

| key | 形式 | 状態 |
|---|---|---|
| `careerEsLogs` | JSON（`CareerEsLog[]`） | 正本（完成・保存確定ログ）。新フローは body/review/version 付きで追記。旧生成ログ（result 系のみ）は破壊せず保持 |
| `careerEsDrafts` | JSON（`CareerEsDraft[]`） | 作成中の未完成ドラフト（owner 単位・schemaVersion 付き）。正式ログとは分離。横断機能・履歴には出さない |

## 横断機能との互換

`CareerEsLog` は横断メモリ（matching / presentation / consultation / mypage / personal-memory / Supabase mirror）が参照する。
新規ユーザー執筆ログは `result.answer = body` を埋め、各 summary で `body` を優先して読む:
- [`lib/careerMemory/matchingEs.ts`](../../lib/careerMemory/matchingEs.ts) / [`presentationEs.ts`](../../lib/careerMemory/presentationEs.ts) `buildMatching/PresentationEsSummary` — 任意 2 引数 `{ body, question }` を追加（後方互換）。body があれば設問種別（`classifyEsQuestionType`）で既存フィールドへ投影する:
  - matching（3 フィールド）: 志望動機系→`motivation` / それ以外→`selfPr`
  - presentation（4 フィールド）: 自己PR系→`selfPr` / 志望動機系→`motivation` / それ以外（ガクチカ・研究等）→`gakuchika`
  - snapshot が `esLogs[0]`（canonical な最新版）の body/question を渡す。**contract（フィールド数）は拡張しない**。review の有無は参照しない（未添削を負値扱いしない）。
- [`lib/careerConsultation/historySnapshots.ts`](../../lib/careerConsultation/historySnapshots.ts) `buildEsHistory`（`body?`）＋ server 側 `normalizeEsHistory`（`body` 保持・`hasContent` に `body` 追加で body-only ログを落とさない）＋ `formatEsHistoryForPrompt`（body 優先で `本文:` を出力。旧生成ログは従来 field で byte 互換）。
- [`lib/careerMemory/renderers/interviewCrossFeature.ts`](../../lib/careerMemory/renderers/interviewCrossFeature.ts) `renderEs` — 旧生成 4 field が 1 つも出ない body-only ログでは、本人本文（`result.answer` 投影）を `- 本文:` で fallback 出力（4 field があるログは本文行を足さず byte 互換）。
- [`app/career/mypage/mypageSummary.ts`](../../app/career/mypage/mypageSummary.ts) snippet も `body` を fallback に読む。
- いずれも AI 添削・改善案（review）を本人本文として渡さない（本文は `body` / `result.answer` 投影のみ）。回帰ガード: `scripts/career-es-cross-feature-closeout-qa.ts`（`npm run qa:careerEsCrossFeatureCloseout`）。

**フォールバック順**: `body`（trim 後・非空）→ 旧 result フィールド → 空文字。body が空白のみなら legacy へフォールバック。
**バージョン選択**: snapshot は既存の canonical `esLogs[0]`（最新更新＝最新版）を使用し、版選択を重複実装しない。
**contract 上の制限**: 設問文・企業名は既存 summary 型に無いため carry しない（型拡張を避けるため。matching/presentation の render 対象は従来どおり）。

## 撤去したもの（P: 代筆廃止）

- `app/api/career/es/route.ts`（ES本文まるごと生成）＋ `esPrompt.ts`
- `app/career/es/run/page.tsx`（生成UI）/ `app/career/es/result/page.tsx`（旧結果・rewriteExample 保存）
- `scripts/career-es-orchestrator-parity-qa.ts` ＋ golden（生成 prompt の parity QA。生成撤去で dead）
- `CareerEsReview.rewriteExample`（AIが書いた完成本文）

## 責務マップ（追補: 下書き・横断互換）

| 層 | ファイル | 責務 |
|---|---|---|
| storage | [`app/career/es/esDraftStorage.ts`](../../app/career/es/esDraftStorage.ts) | 作成中ドラフト（`careerEsDrafts`）の I/O・owner 絞り込み・schemaVersion 破棄・fail-safe normalize・LRU |
| UI | [`app/career/es/draft/[draftId]/page.tsx`](../../app/career/es/draft/%5BdraftId%5D/page.tsx) | draft エディタ（深掘りQ&A autosave・本文執筆・AI添削で正式ログ化） |
| UI 部品 | [`app/career/es/components/EsDeepDivePanel.tsx`](../../app/career/es/components/EsDeepDivePanel.tsx) | 深掘りQ&A（`initialTurns` から resume・`onTurns` で進捗 autosave・`onOrganized` で整理完了） |
| QA | `scripts/career-es-body-summary-qa.ts` / `scripts/career-es-draft-storage-qa.ts` | body 投影・フォールバック / draft の owner・schema・fail-safe・分離の決定論検証 |

## 未対応 / 今後

- draft の LRU 上限（20 件）超過時は古いものから破棄（作成中データの一時性ゆえ許容）。
- draft は localStorage のみ（Supabase mirror なし）。端末をまたぐ再開は不可。
- **multi-tab の制限**: 同一 owner の同一 draft を複数タブで開いた場合、共同編集はせず last-write-wins（最後に保存したタブの内容が残る。`updatedAt` による衝突検知はしない）。ただし正式ログ化は上記の保存成功確認を通るため、古いタブが「削除済み draft を復活させて重複正式ログを量産する」ことはない（正式ログの id は `newEsId` で毎回新規・添削成功時のみ append）。
- essay と異なり課金/quota 非接続（既存 career/es 慣習を踏襲）。将来 gate 化する場合は別途方針。

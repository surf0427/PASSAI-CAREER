# storage ルール

このディレクトリは、localStorage / sessionStorage を安全に扱うためのヘルパーを管理します。

---

## safeStorage を使うケース

JSON 形式でデータを保存・読み込みする際は、必ず `safeStorage.ts` の関数を使うこと。

```ts
import { safeGetStorage, safeSetStorage, safeRemoveStorage } from '@/lib/storage/safeStorage';
```

| 関数 | 用途 |
|---|---|
| `safeGetStorage<T>(key, fallback)` | JSON.parse + SSR ガード + エラー吸収 |
| `safeSetStorage<T>(key, value)` | JSON.stringify + SSR ガード + エラー吸収 |
| `safeRemoveStorage(key)` | SSR ガード + エラー吸収 |

### 使用例

```ts
// 保存
safeSetStorage('myKey', { count: 1 });

// 読み込み（パース失敗・未存在時は fallback を返す）
const data = safeGetStorage<MyType | null>('myKey', null);

// 削除
safeRemoveStorage('myKey');
```

---

## safeStorage を使わないケース

### raw string を保存する場合

`safeSetStorage` は内部で `JSON.stringify` するため、
raw string（JSON 化しない文字列）を保存しているキーには使用しない。

例: `selfPRDraftStorage.ts` は `selfPR_draft` キーに raw string を保存している。

```ts
// NG: safeSetStorage('selfPR_draft', text) → '"text"' と保存されてしまう
// OK: localStorage.setItem('selfPR_draft', text)
```

raw string ストレージには以下のコメントを必ず付けること:

```ts
// 注意：このファイルは raw string を保存する（JSON.stringify しない）。
// safeSetStorage は JSON.stringify するため使用しない。
// 既存データ互換性維持のため、保存形式は変更しない。
```

---

## sessionStorage の扱い

`safeStorage.ts` は `localStorage` 専用。`sessionStorage` には使用しない。

- `sessionStorage` を使う箇所はユーザー操作時のみ（SSR ガード不要）
- ただし `typeof window === 'undefined'` チェックが必要な文脈では個別に対応する
- 使用箇所: `hooks/useActivityForm.ts` → AI 分析ページへのデータ受け渡し

---

## key 名・保存形式のルール

1. **key 名は絶対に変更しない。** 変更すると既存ユーザーのデータが読めなくなる。
2. **保存形式（JSON/raw string）は変更しない。** 互換性が壊れる。
3. 新しいキーを追加する場合は、このファイルに記載する。

### 既存の key 一覧

| key 名 | ファイル | 形式 | 用途 |
|---|---|---|---|
| `basicFormData` | `lib/basicInfoStorage.ts` | JSON | 基本情報フォーム |
| `activityFormData` | `lib/activityStorage.ts` | JSON | 活動整理フォーム（入力途中） |
| `analyzeState` | `lib/analyzeStorage.ts` | JSON | 壁打ちセッション状態 |
| `wallHittingResult` | `lib/wallHittingStorage.ts` | JSON | 壁打ち分析結果 |
| `wallHittingInputHash` | `lib/wallHittingInputHashStorage.ts` | JSON | `/api/analysis` の input hash cache（STEP5.2）。同入力なら AI call を skip するための判定 key。`wallHittingResult` と AND で照合する |
| `additionalQuestionsInputHash` | `lib/additionalQuestionsCache.ts` | JSON | `/api/analysis/additional` の input hash + 生成済み追加質問の同居 cache（STEP5.4）。hit 時は daily limit を消費しない |
| `summarizeInputHash` | `lib/summarizeCache.ts` | JSON | `/api/summarize` の input hash + 生成済み `SummaryResult` の同居 cache（STEP5.8）。`analyzeState.summary` とは独立 |
| `statementReviewInputHash` | `lib/statement/review/statementReviewCache.ts` | JSON | `/api/statement-review` の input hash + 生成済み `ApiReviewResponse` の同居 cache（STEP5.10 / STEP-F で v5）。hit 時は `statementReviewLimit` を消費せず、`statementReviewHistory` には append する。STEP-F (v5) で hash 入力から `wallHittingResult` を除外し canonical `studentProfile` 一本化 |
| `essayReviewInputHash` | `lib/essayReviewCache.ts` | JSON | `/api/essay-review` の input hash + 生成済み `ReviewResult` の同居 cache（STEP5.11）。`essayPracticeReview` (`SavedReview`) とは独立 |
| `selfPRs` | `lib/selfPRStorage.ts` | JSON | 自己 PR 一覧 |
| `selfPR_draft` | `lib/selfPRDraftStorage.ts` | **raw string** | 自己 PR 下書き（ページ間受け渡し）。既存例外（raw string） |
| `admissionMatchingInput` | `lib/admissionMatchingStorage.ts` | JSON | AI 志望校マッチング入力 |
| `admissionMatchingResult` | `lib/admissionMatchingStorage.ts` | JSON | AI 志望校マッチングの完了結果（completed フラグ込み） |
| `matchingResult` | `app/admission-matching/page.tsx` | JSON | マッチング結果のキャッシュ。**TODO**: 将来 `lib/admissionMatchingStorage.ts` 経由に統一予定（STEP6 で `localStorage` 直書きとして検出） |
| `matchingTimestamp` | `app/admission-matching/page.tsx` | **raw string**（ISO 文字列） | マッチング結果キャッシュのタイムスタンプ。**TODO**: 上記と同タイミングで lib に集約予定 |
| `statementDraft` | `lib/statementStorage.ts` | JSON | 志望理由書下書き |
| `statementReviewHistory` | `lib/statementStorage.ts` | JSON | 志望理由書添削履歴 |
| `statementReviewLimit` | `lib/statementLimit.ts` | JSON | 志望理由書添削 日次回数（daily limit） |
| `statement_prepare_answers` | `lib/statementPrepareStorage.ts` | JSON | 志望理由書 整理メモ 入力 3 項目（interestReason / memorableExperience / futureGoal） |
| `statement_prepare_summary` | `lib/statementPrepareStorage.ts` | JSON | 志望理由書 整理メモ AI 出力 5 項目（impressiveExperience / feltIssue / interestInField / universityLearning / futureApplication） |
| `statementPrepareFollowUpAnswers` | `lib/statementPrepareStorage.ts` | JSON | 志望理由書 整理メモの深掘り回答（弱点別） |
| `statement_prepare_limit` | `lib/statementPrepareLimit.ts` | JSON | 志望理由書 整理メモ AI 日次回数（daily limit） |
| `statement_rewrite_memo` | `lib/statement/rewrite/rewriteMemoStorage.ts` | JSON | reviewId（`statementReviewHistory` の id）単位の「書き直し方針メモ」。`/statement/improve/rewrite/[id]` でユーザーが書く整理 artifact。`Partial<Record<reviewId, { text, updatedAt, version?: 2, workAnswers?: Partial<Record<string, Partial<Record<string, string>>>> }>>`。v1 record（`version` 無し）は後方互換で透過 load される。`workAnswers` は改善ポイント別ワークの回答（外側 key = axis/improvement key、内側 key = 質問 id）。AI 出力・bullet snapshot は持たない（analysis = master 方針、edit 側は render-time derive）。旧 `statement_rewrite_drafts`（軸別、撤去済み）の後継。user の localStorage に旧 key の残骸が残っていても誰も読まないため放置 |
| `essayPracticeData` | `lib/essayPracticeStorage.ts` | JSON | 小論文練習の進捗状態（途中保存）。essay STEP I で Phase 1 中は **維持** 方針確定（rollback safety） |
| `essayPracticeReview` | `lib/essayPracticeStorage.ts` | JSON | 小論文添削結果の保存。essay STEP B 以降は `essayWorkspaces` への dual-write の片側として運用。Phase 1 中は **削除しない**（rollback safety） |
| `essayWorkspaces` | `lib/essayWorkspaceStorage.ts` | JSON | 小論文 `EssayWorkspace[]` の正本配列（LRU 10 件）。review append-only 履歴と改善ワーク状態を含む。essay STEP A 新規・STEP B で `/essay-practice` 添削成功時に dual-write 化。Phase 2 完了まで dual-write 維持 |
| `essayImproveSummaryInputHash` | `lib/essay/improveSummaryCache.ts` | JSON | `/api/essay-improve-summary` の input hash + 生成済み `ImprovementSummary` の同居 cache。essay STEP F 新規。同入力なら AI call を skip して保存済み方針を復元する |
| `passai_diagnosis_result` | `lib/diagnosisStorage.ts` | JSON | 受験タイプ診断結果（LP → 診断 → 結果動線で再訪復元用） |
| `deepDiveUsage` | `lib/dailyLimit.ts` | JSON | 壁打ち（深掘り質問）日次制限（daily limit） |
| `selfAnalysisUsage` | `lib/dailyLimit.ts` | JSON | 自己分析 日次制限（daily limit） |
| `additionalQuestionsUsage` | `lib/dailyLimit.ts` | JSON | 自己分析の追加質問生成 日次制限（daily limit） |
| `interview_records` | `lib/interviewRecordStorage.ts` | JSON | 面接練習記録 |
| `interviewDraft` | `lib/interviewDraftStorage.ts` | JSON | 面接記録フォームの入力途中 |
| `interviewAdditionalQuestionUsage` | `lib/interviewAdditionalUsage.ts` | JSON | 面接予想質問の追加生成 日次カテゴリ別制限（daily limit、`{date, categoryCounts:{reason,activity,university}}`） |
| `interviewQuestionsCache` | `lib/interviewQuestionCache.ts` | JSON | `/api/interview-questions` の input hash + 生成済み `TwoLayerInterviewQuestions` の同居 cache（STEP8）。同入力（basicInfo / statementDraft / studentProfile / activitySummary / model / promptVersion）なら AI call を skip して保存済み questions を復元する。legacy fallback 経路は保存対象外 |
| `supabaseBackfill` | `lib/repository/backfillFlag.ts` | JSON | Supabase backfill 完了 flag（STEP-SUPABASE-COMPLETE-03B）。形式 `{ [userId]: { [feature]: { version, at } } }`。`tutorRepository.ts:backfillTutorOnce` が「初回 1 回だけ LS 全履歴を Supabase へ一括同期」する起動制御に使う（feature=`tutor`、userId 単位）。flag は最適化で、消えても backfill 本体は冪等のため再実行は無害。`AuthProvider` の `profileReady` 後 fire-and-forget 起動経由でのみ書き込まれる。例外的に `lib/repository/` 配下に置く（feature storage の `lib/*Storage.ts` flat ルールには含めない） |
| `careerGdSessions` | `app/career/gd/gdStorage.ts` | JSON | 【就活版】GD（グループディスカッション）の進行中/完了セッション（会話状態）。career feature-local storage（`app/career/*` 配下に置く既存 career 慣習に準拠）。受験版キーとは衝突しない |
| `careerGdResults` | `app/career/gd/gdStorage.ts` | JSON | 【就活版】GD の完了結果（個別FB・S/A/B/C/D 企業評価・順位・matchingHints）。view で一覧/詳細表示する正データ。Phase1 は localStorage canonical（Supabase 非接続） |

---

## 新しい storage を追加するときのルール

1. **`lib/` 直下**に `{feature}Storage.ts` を作る（命名・配置の詳細は [`lib/README.md`](../README.md) を参照）。`lib/storage/` 配下は `safeStorage.ts` ヘルパー専用とする
2. key 名は他と被らないよう確認し、この README の既存 key 一覧に追記する
3. JSON 形式 → `safeStorage` を使う（`safeGetStorage` / `safeSetStorage` / `safeRemoveStorage`）
4. raw string 形式 → 既存例外（`selfPR_draft`）以外は新規追加禁止
5. sessionStorage を使う場合は専用コメントを付ける

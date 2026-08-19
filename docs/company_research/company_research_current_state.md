# 企業研究（company-research）current state

PASSAI CAREER の企業研究機能の現在仕様。受験版には一切影響しない（PASSAI CAREER 配下のみ）。

## 設計思想（最重要）

本機能は **「AI が企業情報を代わりに調べる機能」ではない**。ユーザーが自分で行った企業研究（手入力・テキスト貼り付け・PDF/画像アップロード＋抽出テキスト）を一次データとして受け入れ、AI は **不足指摘・本人情報とのすり合わせ**を行う「添削者（＝企業情報の生成者ではない）」として振る舞う。

> 2026-08-19: 旧 STEP 3「内容を確認・修正する（添削対象）」の**手動確認 UI を廃止**した。分析対象本文（`verifiedResearchText`）は素材から **決定論的に**合成される（`app/career/company-research/researchText.ts` の `combineSources`。純粋な文字列結合・AI call ゼロ）。UI 文言も実態に合わせ「添削」→「企業分析」へ統一した。API contract・prompt・出力・persistence は不変。

- AI は企業情報の正解を断定しない。「あなたの記述を見る限り〜」「根拠が不足しています」「公式情報や説明会資料で再確認してください」という文体に徹する（system prompt で強制）。
- **分析対象は、アップロードファイルそのものではなく、素材から合成した `verifiedResearchText` のみ**。OCR 結果はファイル行の textarea でその場で確認・修正できる（巨大な確認欄への再集約は不要）。
- ユーザー脳死・コピペ就活を促進しない。企業研究力の向上を目的にする。

## ルート（do / view 構成）

- `/career/company-research` — ハブ。
- `/career/company-research/do` — **新規作成・既存編集・再分析を兼用する単一ページ**。
  - 新規: `?id` なしで空状態から開始。
  - 編集/再分析: `/career/company-research/do?id=<logId>` で既存ログを読み込み編集状態に。
  - 旧ログ後方互換: 素材（manualMemo / pastedText / ファイル抽出）が空で `verifiedResearchText` だけ持つログは、本文を手入力メモへ戻して読み込む（`hasAnyMaterial`）。
- `/career/company-research/view` — 一覧・詳細。`?id=<logId>` で詳細を直接開ける（保存直後の遷移先）。詳細から「修正して再分析する」で `do?id=` へ戻る。

新規用・編集用に do ページを重複作成しない（単一ページの使い回し）。

## 入力フロー（do ページ）

1. 企業名（必須）・志望度・業界
2. 素材入力: 手入力メモ / テキスト貼り付け / PDF・画像・スクショアップロード
3. テキスト抽出（OCR）
   - クライアント境界 `app/career/company-research/extraction.ts`: 検証 / TXT ローカル読取 / API 呼び出し / `CareerCompanyResearchFile` 組み立て（`createPendingFile` → `extractTextFromFile` → `applyExtraction`）。
   - サーバ `app/api/career/company-research/extract/route.ts`（Node runtime・multipart/form-data）:
     - **PDF**: `pdfjs-dist` で埋め込みテキスト抽出を優先。テキストがほぼ無い画像PDFは Claude の document ブロックで OCR にフォールバック。
     - **画像（png/jpeg/webp）**: Claude Vision（image ブロック）で原文抽出。
     - **TXT**: そのまま読む。
     - OCR プロンプトは「原文抽出のみ・推測/補完/要約/分析を禁止・判読不可は [判読不可]・出力は抽出テキストのみ」。
     - `ANTHROPIC_API_KEY` 未設定時は自動 OCR をスキップし `manual_required` を返す（手入力・貼り付けは不変）。サーバでもサイズ/MIME を再検証。
   - 抽出結果はファイル行の textarea でその場で確認・修正でき、分析実行時に他の素材と結合される。
   - ファイル本体（バイト列・base64）は保存しない。ファイル名・型・サイズ・抽出テキスト・抽出ステータス・`extractionError` のみ保持（`storagePath` は将来 Supabase Storage 用に予約）。
4. 「参考にした情報源（任意）」— 素材入力（STEP 2）の一部。分析 prompt・保存データ・結果画面で使う
5. 「企業分析する →」— 押下時に `combineSources(manualMemo, pastedText, files)` で `verifiedResearchText` を合成し、`/api/career/company-research` へ送る（**唯一の企業分析 AI call**）。素材を編集すると結果は対象とずれるため、分析時のテキストと一致するときだけ有効な結果として扱う（`activeResult`）
6. 保存: 新規は新規ログ、`?id` ありは既存ログ更新（`revisionHistory` に新版を先頭追加）

対応入力: 手入力 / テキスト貼り付け / PDF / 画像（PNG・JPG・JPEG・WEBP）/ スクショ / TXT。

## 企業分析の出力（`/api/career/company-research`・唯一の企業分析 AI call）

- `review`: overallScore（6 軸平均から決定論導出）/ rank（決定論導出）/ overallComment / breakdown（企業理解度・業界理解度・競合理解度・根拠の質・考察の深さ・志望理由への接続度）/ goodPoints / missingInfo / weakAssumptions / nextResearchActions。
- `fitAnalysis`: selfAnalysisFit / valuesFit / activityFit / matchingFit（各 1〜3 文）/ gaps / strengthsToUse。本人情報（自己分析・就活軸・活動整理・マッチング）が無い/不足なら断定せず不足と述べる。
- `interviewContextSummary`: 面接機能へ渡す文脈要約（3〜5 文）。

プロンプトは共通基盤 `@/lib/careerAi`（featureKey=`career-company-research`）経由。

## 保存データ

- canonical: localStorage `careerCompanyResearchLogs`（`companyResearchStorage.ts`）。型は `types/careerCompanyResearch.ts` の `CareerCompanyResearchLog`。
  - `input`（一次データ）: companyName / industry / interestLevel / manualMemo / pastedText / uploadedFiles / extractedText / verifiedResearchText / sources。
  - `review` / `fitAnalysis` / `interviewContextSummary` / `revisionHistory`（分析履歴・新しい順。再分析のたびに先頭追加 → 学習ループの記録）。
  - 旧スキーマ（業界・強み等の構造化フィールド）のログは normalize で `manualMemo` へ畳み込み後方互換。
- durable mirror（member のみ・best-effort・env 未設定時 no-op）: `lib/supabase/careerCompanyResearch.ts` → `career_company_research_logs`（DDL は `supabase/schema.sql` §92 / `supabase/career_features_apply.sql` §92。`revision_history jsonb` 列を含む）。

## 他機能連携

企業研究機能内では面接練習をしない。保存された `interviewContextSummary` を面接機能・ES・相談 AI・マッチングが後で参照できる形で保持する。

### 共通ヘルパー `lib/careerCompanyResearch/context.ts`（純粋関数・client/server 共用）
- `buildCompanyResearchSnapshot(log, opts)` — 1 件を軽量 `CompanyResearchSnapshot`（companyName / industry / interestLevel / updatedAt / verifiedResearchTextPreview / reviewSummary / fitSummary / interviewContextSummary）へ。verifiedResearchText は抜粋に短縮（既定280字、ES 個別選択は `SINGLE_VERIFIED_PREVIEW`=1200字）。
- `buildCompanyResearchContext(logs, opts)` — 最新更新順・最大件数（既定5）・選択ログ優先でスナップショット配列に。
- `normalizeCompanyResearchSnapshot(raw)` — API 受信側の防御正規化。
- `formatCompanyResearchContextForPrompt(snapshots)` — プロンプト用テキストへ整形。
- 全文を無制限に API へ送らない（件数・文字数制限）。null / 旧ログに耐える。

### ES 機能（`/career/es`）
- `/career/es/run`: 「企業研究ログを使う（任意）」で 1 件選択（または「企業研究なしで進める」）。選択で企業名・業界を引き継ぐ。生成 API へ `companyResearchContext`（スナップショット）を渡し、ES ログに `companyResearchLogId` / `companyResearchSnapshot` を保存（後方互換 optional・Supabase は meta jsonb）。
- `app/api/career/es/route.ts`: 志望動機・企業別設問・入社後・自己PRと企業の接続に「ユーザーの企業研究に基づくと」という扱いで活用（企業情報は補完・断定しない）。
- `app/api/career/es-review/route.ts`: スナップショットがあれば企業理解の深さ・志望動機の具体性・企業研究との整合・自己分析/活動/就活軸との接続を評価（断定回避の文体）。
- `/career/es/result`: 生成時のスナップショットを添削にも引き継ぎ、使用した企業研究へのリンクを表示。

### 相談 AI（`/career/consultation`）
- 画面で `buildCompanyResearchContext`（最大5件）を context として送信。
- `app/api/career/consultation/route.ts`: 「保存済みの企業研究を見る限り」「あなたのメモでは」という文体で根拠回答。未保存・未作成なら企業研究機能の利用を案内。断定・最新情報の生成・根拠なき適合判定をしない。

### 面接 AI（`/career/interview`）
- 共通ヘルパーに面接用 API を追加: `InterviewCompanyResearchContext` 型 / `buildInterviewCompanyResearchContext(log)`（要約優先・抜粋200字）/ `normalizeInterviewCompanyResearchContext` / `formatInterviewCompanyResearchForPrompt`。verifiedResearchText 全文は渡さず interviewContextSummary / fitSummary / reviewSummary を優先（トークン節約）。
- `/career/interview/setup`: 「企業研究ログを使う（任意）」で1件選択（または「企業研究なしで進める」）。ログが無ければ非表示。選択は `CareerInterviewSession.companyResearchLogId`（+ snapshot）に保存。
- `contextSource.ts`: `buildInterviewContextPayload(companyResearchLogId?)` がログIDから面接用コンテキストを解決。session 画面は毎ターン `session.companyResearchLogId` を渡す。
- `interviewPrompt.ts`: 選択時のみ企業研究ブロックを注入。面接官は「企業研究を試験する」のではなく「ユーザーの企業研究を踏まえて深掘りする」役割（なぜ興味を持ったか／経験との接続／競合比較／入社後ビジョン）。売上・IR数字の暗記確認や企業クイズはしない。「あなたの企業研究を見る限り」「保存済みメモでは」「追加確認が必要ですが」の文体。
- 最終評価（complete）: 選択時のみ `companyResearchFit`（企業理解の活用度・志望理由/自己分析との接続・入社後ビジョンの具体性）を追加出力。結果画面に「企業研究との接続評価」と参照元リンクを表示。
- 保存: `CareerInterviewSession` / `CareerInterviewResult` に `companyResearchLogId` / `companyResearchSnapshot`（optional・後方互換）。`companyResearchFit` は result jsonb 内。Supabase は `career_interview_sessions` / `career_interview_results` に `company_research_log_id` / `company_research_snapshot` 列を追加（idempotent ALTER）。
- 未選択時は従来どおり（企業研究ブロック・companyResearchFit を出さない）。

## 非接続方針

課金 / quota・usage 記録・Stripe には接続しない（他 career 機能と同一）。

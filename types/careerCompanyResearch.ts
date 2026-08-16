// PASSAI 就活版 — 企業研究AIの入力・出力・ログ型
//
// 設計思想（重要）:
//   - 本機能は「AIが企業情報を生成する」機能ではない。ユーザー自身が行った企業研究（手入力・
//     テキスト貼り付け・PDF/画像アップロード＋抽出テキスト）を一次データとして受け入れ、
//     AIは家庭教師のように「添削・不足指摘・本人情報とのすり合わせ」を行う添削者として振る舞う。
//   - AI添削の対象は、アップロードファイルそのものではなく、ユーザーが確認・修正した
//     verifiedResearchText に限る（OCR 誤りを人が直すステップを必須にする）。
//   - 保存単位（CareerCompanyResearchLog）は AI 結果だけでなく、ユーザー原文（manualMemo /
//     pastedText）・添付ファイルメタ・抽出テキスト・ユーザー確認済みテキストを必ず保持する。
//     これは ES・面接・マッチング・相談AIで再利用できる一次データになる。
//   - 受験版の型には一切依存しない。DB / Supabase は best-effort mirror。canonical は localStorage。

// ── 志望度 ────────────────────────────────────────────────────────
export type CareerCompanyInterestLevel = 'high' | 'mid' | 'low' | 'watch';

export const CAREER_COMPANY_INTEREST_LABELS: Record<CareerCompanyInterestLevel, string> = {
  high: '本命',
  mid: '志望',
  low: '検討中',
  watch: '情報収集',
};

// ── 添付ファイルの抽出ステータス ─────────────────────────────────────
//   - pending         : 抽出処理待ち
//   - success         : 自動抽出に成功（テキストあり）
//   - failed          : 抽出に失敗
//   - manual_required : 自動抽出できないため、ユーザーが手動で貼り付け／修正する必要がある
//     （MVP の PDF/画像はこの状態になり、ユーザーが内容を書き写す前提）
export type CareerCompanyResearchExtractionStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'manual_required';

// アップロードされた 1 ファイルのメタ + 抽出テキスト。
// MVP ではファイル本体（バイト列）は保存しない（localStorage 容量・object URL の揮発性のため）。
// storagePath は将来 Supabase Storage 等に本体を置いたときのパス用（現状は未使用）。
export type CareerCompanyResearchFile = {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  uploadedAt: string;
  // 将来の本体保管先（Supabase Storage 等）。MVP では未設定。
  storagePath?: string;
  // このファイルから抽出した（または手動で書き写した）テキスト。
  extractedText: string;
  extractionStatus: CareerCompanyResearchExtractionStatus;
  // 自動抽出が manual_required / failed のときの理由（UI 表示用。任意）。
  extractionError?: string;
};

// ── User Private Evidence（Company Data Spine B 層）──────────────────
// 本ログ（CareerCompanyResearchLog）は Company Data Spine における
// **User Private Evidence の canonical** である（新テーブルを作らない）。
//
// 100% PRIVATE:
//   - 本人以外に見せない。Community（Layer 5）へは **一切**書かない・変換しない。
//   - そのため visibility / shareConsent / communityRequested / publish /
//     moderationStatus といったフィールドは **意図的に持たない**（型に存在させない）。
//
// 一次情報と AI 生成物を混同しない:
//   - 一次情報 = input（manualMemo / pastedText / uploadedFiles / extractedText /
//     verifiedResearchText / sources）
//   - AI 生成物 = review / fitAnalysis / interviewContextSummary / revisionHistory
//     これらは Private Evidence **ではない**。

/**
 * この企業情報をどこで得たか（Phase A / R5・optional・後方互換）。
 * 欠損は 'own_note' 相当（自分のメモ）として扱う。UI では未選択も許す。
 */
export type CompanyEventType =
  | 'briefing' // 説明会
  | 'ob_visit' // OB/OG訪問
  | 'internship' // インターン
  | 'employee_talk' // 社員との会話
  | 'material' // 配布資料
  | 'selection' // 選考関連
  | 'own_note'; // 自分のメモ

export const CAREER_COMPANY_EVENT_TYPE_LABELS: Record<CompanyEventType, string> = {
  briefing: '説明会',
  ob_visit: 'OB/OG訪問',
  internship: 'インターン',
  employee_talk: '社員との会話',
  material: '配布資料',
  selection: '選考関連',
  own_note: '自分のメモ',
};

// ── ユーザーが行った企業研究（一次データ） ────────────────────────────
export type CareerCompanyResearchInput = {
  // 企業名（必須運用）。★ Company Identity 導入後も **維持する**（削除しない）。
  companyName: string;
  // Company Data Spine の canonical key（Phase A / R3 で追加・optional・後方互換）。
  //   - 登録済み企業を選んだときだけ入る。欠損（未登録・free-text 入力）が正常。
  //   - companyName の置換ではなく **追加情報**。表示は companyName へ fallback できる。
  companyId?: string;
  // 業界。
  industry: string;
  // 志望度。
  interestLevel: CareerCompanyInterestLevel | null;
  // 手入力メモ（自分の言葉で書いた企業研究）。
  manualMemo: string;
  // テキスト貼り付け（他所からコピーした素材。OCR ではない貼り付け）。
  pastedText: string;
  // アップロードしたファイルのメタ + 抽出テキスト。
  uploadedFiles: CareerCompanyResearchFile[];
  // OCR/抽出の生テキスト（ファイル群の抽出結果をまとめた未確認テキスト）。
  extractedText: string;
  // ユーザーが確認・修正した最終テキスト（AI添削の対象はこれだけ）。
  verifiedResearchText: string;
  // 参考にした情報源（公式サイト・説明会・OB訪問など）。
  sources: string;

  // ── User Private Evidence の構造化（Phase A / R5・すべて optional・後方互換）──
  //
  // ★ 最小 2 項目に絞っている。前回 PLAN の `sourceUrls` / `attachments` は
  //   既存の `sources`（情報源の free-text）と `uploadedFiles` が既に担っているため
  //   **追加しない**（巨大 schema・二重表現を作らない）。
  //
  /** この情報をどこで得たか。欠損は「自分のメモ」相当として扱う。 */
  eventType?: CompanyEventType;
  /** 観測時期（'2026-05' / '2026' 等の粗い粒度）。情報の鮮度を本人が判断するために持つ。 */
  observedPeriod?: string;
};

// ── AI添削の出力 ──────────────────────────────────────────────────

export type CareerCompanyResearchRank = 'S' | 'A' | 'B' | 'C' | 'D';

// 6 軸スコア（各 0〜100 の整数）。
export type CareerCompanyResearchBreakdown = {
  companyUnderstanding: number; // 企業理解度
  industryUnderstanding: number; // 業界理解度
  competitorUnderstanding: number; // 競合理解度
  evidenceQuality: number; // 根拠の質
  depthOfThought: number; // 考察の深さ
  motivationConnection: number; // 志望理由への接続度
};

// 添削本体（企業情報の正解を断定せず、「あなたの記述を見る限り」という文体で書く）。
export type CareerCompanyResearchReview = {
  // 総合スコア（0〜100。breakdown 6 軸の平均から決定論で導出）。
  overallScore: number;
  // ランク（overallScore から決定論で導出）。
  rank: CareerCompanyResearchRank;
  // 総評（断定を避けた添削者の所感）。
  overallComment: string;
  // 6 軸スコア。
  breakdown: CareerCompanyResearchBreakdown;
  // 良い点。
  goodPoints: string[];
  // 不足している情報。
  missingInfo: string[];
  // 思い込み・根拠不足の指摘（断定しすぎ・出典が曖昧な点）。
  weakAssumptions: string[];
  // 次に調べるべき具体的アクション。
  nextResearchActions: string[];
};

// 本人情報（自己分析・就活軸・活動整理・マッチング）とのすり合わせ。
// 各 Fit は短い所感テキスト（対象情報が無い／不足なら、その旨を述べる）。
export type CareerCompanyResearchFitAnalysis = {
  // 自己分析との整合（強み・価値観・方向性）。
  selfAnalysisFit: string;
  // 就活軸との整合（重視/回避・働き方・社風）。
  valuesFit: string;
  // 活動整理（経験）との整合（語れるエピソードの接続）。
  activityFit: string;
  // 企業マッチング結果との整合。
  matchingFit: string;
  // ギャップ・確認すべき点。
  gaps: string[];
  // この企業で活かせる本人の強み。
  strengthsToUse: string[];
};

// 1 回の添削スナップショット（学習ループの履歴）。
export type CareerCompanyResearchRevision = {
  revisionId: string;
  // この添削の対象になったユーザー確認済みテキスト。
  verifiedResearchText: string;
  review: CareerCompanyResearchReview;
  fitAnalysis: CareerCompanyResearchFitAnalysis;
  interviewContextSummary: string;
  createdAt: string;
};

// 完了済み 企業研究 1 件分の localStorage スナップショット。
// 保存キーは 'careerCompanyResearchLogs'（app/career/company-research/companyResearchStorage.ts）。
export type CareerCompanyResearchLog = {
  id: string;
  createdAt: string;
  updatedAt: string;

  // 一覧・絞り込み用に昇格した属性（input にも同値を持つ）。
  companyName: string;
  // Company Data Spine の canonical key（Phase A / R3・optional・後方互換）。
  // 既存ログには存在しないため、read / normalize 側で defensive に扱うこと。
  companyId?: string;
  industry: string;
  interestLevel: CareerCompanyInterestLevel | null;

  // ユーザーが行った企業研究（一次データ。必ず保持）。
  input: CareerCompanyResearchInput;
  // 最新の AI添削（= revisionHistory[0] と同値）。
  review: CareerCompanyResearchReview;
  // 最新のすり合わせ。
  fitAnalysis: CareerCompanyResearchFitAnalysis;
  // 面接機能へ渡すための要約（面接練習はここでは行わない。受け渡し用）。
  interviewContextSummary: string;
  // 添削の履歴（新しい順）。再添削のたびに先頭へ積む。学習ループの記録。
  revisionHistory: CareerCompanyResearchRevision[];

  // お気に入りフラグ（view 画面でトグル・任意）。
  favorite?: boolean;
};

// ── 他機能連携用の軽量スナップショット ───────────────────────────────
// ES・相談AI・将来の面接機能へ「ユーザー本人が確認した企業研究」を根拠として渡すための要約。
// 企業研究ログ全文ではなく、抜粋・要約に絞る（プロンプトへ無制限に送らない）。
// 旧ログ・欠損にも耐えるよう各フィールドは optional。
export type CompanyResearchSnapshot = {
  logId: string;
  companyName: string;
  // Company Data Spine の canonical key（Phase A / R3・optional）。
  // 他機能が「同じ企業のログか」を突き合わせるために使う。prompt には入れない。
  companyId?: string;
  industry?: string;
  interestLevel?: CareerCompanyInterestLevel | null;
  updatedAt: string;
  // verifiedResearchText（無ければ manualMemo / extractedText）を短縮した抜粋。
  verifiedResearchTextPreview?: string;
  // AI添削（スコア・総評・不足・根拠不足）の要約。
  reviewSummary?: string;
  // 本人情報とのすり合わせ（fitAnalysis）の要約。
  fitSummary?: string;
  // 面接連携用要約（そのまま）。
  interviewContextSummary?: string;
};

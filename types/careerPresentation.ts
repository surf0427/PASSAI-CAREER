// PASSAI 就活版 — プレゼン対策AIの型
//
// 受験版（lib/presentation* / Supabase Storage / 課金）には依存しない。
// 就活版は「ステートレスAPI + localStorage セッション + Web Speech API 文字起こし」で動かすため、
// 専用の軽量な型を持つ（動画保存・Supabase・課金は MVP 対象外）。
// 受験版の AO・推薦・大学受験・志望校評価軸の文脈は持ち込まない（新卒就活専用）。

// プレゼンの種類（新卒就活）。
//   - self_pr           : 自己PRプレゼン
//   - gakuchika         : ガクチカプレゼン
//   - motivation        : 志望動機プレゼン
//   - company_research  : 企業/業界研究プレゼン
//   - case              : ケース課題・新規事業提案プレゼン
//   - real              : 本番選考プレゼン（総合）
export type CareerPresentationType =
  | 'self_pr'
  | 'gakuchika'
  | 'motivation'
  | 'company_research'
  | 'case'
  | 'real';

// 入力モード（音声＝Web Speech API でライブ文字起こし / テキスト＝原稿を貼り付け）。
export type CareerPresentationMode = 'voice' | 'text';

// ── お題ベース（プロンプト型）プレゼンの設定 ───────────────────────────
// 就活・選考で出される「お題」に対して発表する形式へ寄せるための追加設定。
// すべて任意（後方互換）。最重要は「お題（theme）」と「発表時間（timeLimitSec）」で、
// 以下はお題を補強する任意コンテキスト。既存履歴には無いので UI/プロンプトは欠損に耐える。

// 想定シーン（選考の場面）。評価の重心を出し分ける。
export type CareerPresentationScenario =
  | 'main_selection' // 本選考
  | 'internship' // インターン選考
  | 'gd_followup' // グループディスカッション後の発表
  | 'case' // ケース面接
  | 'self_pr' // 自己PRプレゼン
  | 'company_proposal' // 企業課題提案
  | 'unspecified'; // 指定なし

// 発表形式。
export type CareerPresentationFormat =
  | 'individual' // 個人発表
  | 'group_rep' // グループ代表発表
  | 'with_materials' // 資料あり
  | 'without_materials' // 資料なし
  | 'unspecified'; // 指定なし

// お題ベースプレゼンの任意設定（session / result に optional で持つ）。
export type CareerPresentationConfig = {
  scenario?: CareerPresentationScenario;
  companyName?: string;
  industry?: string;
  jobType?: string;
  format?: CareerPresentationFormat;
  // 評価してほしい観点（CAREER_PRESENTATION_EVAL_FOCUS の key 群）。
  evaluationFocus?: string[];
  // 補足メモ。
  note?: string;
};

// 総合ランク。
export type CareerPresentationRank = 'S' | 'A' | 'B' | 'C' | 'D';

// 評価軸別スコア（0〜100）。key は安定識別子、label は表示名。
export type CareerPresentationAxisScore = {
  key: string;
  label: string;
  score: number;
  comment: string;
};

// プレゼン全体の最終評価レポート。
export type CareerPresentationFinalResult = {
  // 総合スコア（0〜100）。
  totalScore: number;
  // 総合ランク（S/A/B/C/D）。
  rank: CareerPresentationRank;
  // 総評（数文）。
  overallComment: string;
  // 評価軸別スコア。
  axes: CareerPresentationAxisScore[];
  // 良かった点。
  goodPoints: string[];
  // 改善点。
  improvements: string[];
  // 優先的に直すべきポイント。
  priorityImprovements: string[];
  // 次回の練習メニュー。
  nextPractice: string[];
  // 想定質問（発表後に聞かれそうな質問）。
  expectedQuestions: string[];
  // 改善版の構成例（アウトライン。完成原稿の代筆はしない）。
  improvedStructure: string[];
  // 観点別フィードバック（任意・後方互換のため optional。古い履歴には無い）。
  //   - 構成 / 説得力 / 話し方・伝え方 についての個別コメント。
  structureFeedback?: string;
  persuasionFeedback?: string;
  deliveryFeedback?: string;
  // 選考通過可能性についての所見（断定しない）。
  passLikelihood: string;
  // 志望業界・職種・就活軸との相性についての所見。
  companyFit: string;
  // 面接官・採用担当に突っ込まれそうな点。
  interviewerConcerns: string[];
};

// Q&A（発表後の質疑応答練習）の 1 発話。
export type CareerPresentationQaTurn = {
  role: 'question' | 'answer';
  content: string;
};

// 進行中 / 完了済みのプレゼンセッション（localStorage: careerPresentationSessions）。
export type CareerPresentationSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'in_progress' | 'completed';
  presentationType: CareerPresentationType;
  mode: CareerPresentationMode;
  // お題ベースプレゼンの任意設定（想定シーン・企業名・観点など）。古い履歴には無い。
  config?: CareerPresentationConfig;
  // 発表テーマ（＝お題）。
  theme: string;
  // 制限時間（秒）。0 = 未設定。
  timeLimitSec: number;
  // 実測の発表時間（秒）。
  durationSec: number;
  // 発表の文字起こし（音声）または貼り付け原稿（テキスト）。
  transcript: string;
};

// 完了済みプレゼン 1 件分の結果（localStorage: careerPresentationResults）。
export type CareerPresentationResult = {
  id: string;
  createdAt: string;
  presentationType: CareerPresentationType;
  mode: CareerPresentationMode;
  // お題ベースプレゼンの任意設定。古い履歴には無い。
  config?: CareerPresentationConfig;
  theme: string;
  timeLimitSec: number;
  durationSec: number;
  transcript: string;
  result: CareerPresentationFinalResult;
  // 発表後に練習した質疑応答（任意。未実施なら空 or 省略）。
  qa?: CareerPresentationQaTurn[];
};

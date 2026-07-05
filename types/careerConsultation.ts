// PASSAI 就活版 — 就活相談AI（司令塔）の型
//
// 受験版 tutor（types/tutorChat.ts / lib/tutorChatStorage.ts）の構造を踏襲しつつ、
// DB / Supabase / 課金には接続せず localStorage のみで扱う。就活相談AIは構造化 JSON を返す
// （受験版 tutor は plain text 応答だが、就活版は司令塔として keyInsights / actions 等を構造化する）。

// STEP-CONSULT-04: 次アクションを対応機能へ導線化するための限定 feature キー。
// AI には自由な URL を出させず、この許可リストの feature を出させて、アプリ側で href に変換する。
// （href 自体は型に持たせない＝AI が URL を注入できない設計）。
export type CareerConsultationActionFeature =
  | 'profile'
  | 'activity'
  | 'values'
  | 'selfAnalysis'
  | 'matching'
  | 'es'
  | 'interview'
  | 'gd'
  | 'presentation'
  | 'companyResearch'
  | 'consultation'
  | 'home';

export type CareerConsultationActionPriority = 'high' | 'medium' | 'low';

// 構造化された次アクション 1 件。feature があればアプリ側で機能ページへの導線を出せる。
export type CareerConsultationRecommendedActionObject = {
  label: string;
  // 対応機能（許可リストのみ）。雑談・整理だけのアクションでは省略してよい。
  feature?: CareerConsultationActionFeature;
  // なぜやるべきかの短い理由。
  reason?: string;
  priority?: CareerConsultationActionPriority;
};

// 次アクション。旧スレッド互換のため string もそのまま許容する（後方互換）。
//   - 旧: localStorage / Supabase に string[] として保存済み
//   - 新: object[]（feature 付きは機能ページへ導線）
export type CareerConsultationRecommendedAction =
  | string
  | CareerConsultationRecommendedActionObject;

// 就活相談AIが 1 ターンで返す構造化結果。
// API route（app/api/career/consultation/route.ts）の出力と 1:1 で対応する。
export type CareerConsultationResult = {
  // STEP-CONSULT-07: 現在地サマリ（1〜2文）。司令塔として「今どの段階か」を独立表示する。
  // 後方互換: 旧保存履歴には存在しないため optional。無ければ UI 側は非表示にする。
  currentStatusSummary?: string;
  // 相談への回答本文（押し付けず、選択肢を提示する）。
  answer: string;
  // 今回の相談から見えてきた要点。
  keyInsights: string[];
  // 次に取るべき具体的アクション（string=旧互換 / object=機能導線つき）。
  recommendedActions: CareerConsultationRecommendedAction[];
  // 助言の精度を上げるために、本人から引き出すべき不足情報。
  missingInformation: string[];
  // 深掘り・実体験の言語化を促すための問いかけ。
  followUpQuestions: string[];
};

export type CareerConsultationRole = 'user' | 'assistant';

// チャット 1 発話。user は入力文、assistant は回答本文（result.answer と同一）。
export type CareerConsultationMessage = {
  id: string;
  role: CareerConsultationRole;
  content: string;
  createdAt: string;
  // assistant のみ: 構造化結果（回答以外の付随情報）。
  result?: CareerConsultationResult;
};

// 相談スレッド 1 件（= 1 つの相談の会話）。localStorage: careerConsultationLogs に配列で保存。
export type CareerConsultationThread = {
  id: string;
  title: string;
  messages: CareerConsultationMessage[];
  createdAt: string;
  updatedAt: string;
};

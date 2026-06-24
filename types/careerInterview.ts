// PASSAI 就活版 — 面接AIの型
//
// 受験版（lib/interviewAi / types/interview.ts）の DB セッション・InterviewFeedback には依存しない。
// 就活版は「ステートレスAPI + localStorage セッション」で動かすため、専用の軽量な型を持つ。
// 受験版の AO・推薦・大学受験・大学評価軸の文脈は持ち込まない（新卒就活専用）。

// 会話 1 発話。質問（面接官）/ 回答（学生）の交互列で会話履歴を表す。
export type CareerInterviewTurn = {
  role: 'question' | 'answer';
  content: string;
};

// 入力モード（テキスト入力 / 音声入力）。音声は Web Speech API（ブラウザ内）で扱う。
export type CareerInterviewMode = 'text' | 'voice';

// 1 ターン（回答→次質問）のAI出力。
// reaction = 直前の回答への一言リアクション、question = 次の深掘り質問。
export type CareerInterviewTurnResult = {
  reaction: string;
  question: string;
};

// 面接全体の最終評価。
export type CareerInterviewFinalResult = {
  overallComment: string;
  strengths: string[];
  improvements: string[];
  sampleAnswers: string[];
  deepDiveTopics: string[];
  nextActions: string[];
};

// 進行中 / 完了済みの面接セッション（localStorage: careerInterviewSessions）。
// 会話状態（turns）はクライアントが保持し、各ターンの生成はステートレスAPIに委ねる。
export type CareerInterviewSession = {
  // 安定 ID（結果ログと突き合わせる）。
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'in_progress' | 'completed';
  mode: CareerInterviewMode;
  // 質問・回答の交互列（末尾が question なら回答待ち）。
  turns: CareerInterviewTurn[];
  // 回答ターン上限（これに達したら面接終了）。
  maxTurns: number;
};

// 完了済み面接 1 件分の最終結果（localStorage: careerInterviewResults）。
export type CareerInterviewResult = {
  // 対応するセッション ID。
  id: string;
  createdAt: string;
  mode: CareerInterviewMode;
  // 評価対象になった会話のスナップショット。
  turns: CareerInterviewTurn[];
  result: CareerInterviewFinalResult;
};

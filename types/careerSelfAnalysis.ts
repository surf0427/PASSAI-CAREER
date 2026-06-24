// PASSAI 就活版 — 自己分析AIの出力・ログ型
//
// 受験版の SelfAnalysisLog（analysis / summary / deepAnswers 系）とは別レーン。
// 就活版の自己分析AIは新卒就活向けの観点（ガクチカ・自己PR・ES切り口など）で
// 結果を返すため、専用の型を持つ。DB / Supabase には接続せず localStorage のみで扱う。

// 就活版 自己分析AI が返す JSON 構造。
// API route（app/api/career/self-analysis/route.ts）の出力と 1:1 で対応する。
export type CareerSelfAnalysisResult = {
  // 全体所感（就活視点での自己分析サマリ）。
  summary: string;
  // 強み。
  strengths: string[];
  // 弱み（伸びしろ）。
  weaknesses: string[];
  // ガクチカ候補（学生時代に力を入れたこと）。
  gakuchikaIdeas: string[];
  // 自己PR候補。
  selfPrIdeas: string[];
  // ESで使える経験の切り口。
  esAngles: string[];
  // 面接で深掘りされそうな点（想定質問）。
  interviewQuestions: string[];
  // 次にやるべきこと。
  nextActions: string[];
};

// 完了済み 就活自己分析 1 件分の localStorage スナップショット。
// 保存キーは 'careerSelfAnalysisLogs'（app/career/self-analysis/selfAnalysisStorage.ts）。
export type CareerSelfAnalysisLog = {
  // 安定 ID（UI の選択キー / 重複排除に使う）。
  id: string;
  // 生成時刻（ISO 文字列）。
  createdAt: string;
  // 任意: 実行時にユーザーが添えた相談・補足。
  userInput: string;
  // AI 出力本体。
  result: CareerSelfAnalysisResult;
};

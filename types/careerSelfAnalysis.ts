// PASSAI 就活版 — 自己分析AIの出力・ログ型
//
// 受験版の SelfAnalysisLog（analysis / summary / deepAnswers 系）とは別レーン。
// 就活版の自己分析AIは新卒就活向けの観点（ガクチカ・自己PR・ES切り口など）で
// 結果を返すため、専用の型を持つ。DB / Supabase には接続せず localStorage のみで扱う。

// 就活版 自己分析AI が返す JSON 構造。
// API route（app/api/career/self-analysis/route.ts）の出力と 1:1 で対応する。
//
// 後方互換: 既存フィールド（summary 〜 nextActions）は不変。下流AI（ES・面接・相談・
// マッチング・企業分析）が再利用しやすいよう、v2 で構造化フィールドを追加した。
// 旧 localStorage ログには v2 フィールドが無いため、消費側（結果画面 / renderSelfAnalysis）は
// 常に「未定義なら空」で防御的に扱うこと（型上は必須だが実データは欠損し得る）。
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

  // ── v2: 下流AI 再利用向けの構造化フィールド ──────────────────────
  // キャリアの方向性・志望の核（1〜3文）。ES志望動機・面接・マッチングの軸になる。
  careerDirection: string;
  // 向いている業界候補（根拠を短く添える）。
  recommendedIndustries: string[];
  // 向いている職種候補（根拠を短く添える）。
  recommendedJobs: string[];
  // 向いている働き方・職場環境・組織文化。
  suitableEnvironment: string[];
  // 価値観キーワード（短い語句の配列）。
  valueKeywords: string[];
  // 強みキーワード（短い語句の配列）。
  strengthKeywords: string[];
  // モチベーションの源泉。
  motivationSources: string[];
  // ストレス要因・避けた方がよい環境。
  stressFactors: string[];
  // 企業選びで重視すべき条件。
  companySelectionCriteria: string[];
  // 今後伸ばすべき点。
  developmentPoints: string[];
};

// 深掘り壁打ち（自己分析の会話）の 1 ターン。AI の質問 or ユーザーの回答。
// 構造は面接の CareerInterviewTurn と同形だが、機能間の結合を避けるため自己分析側で独自定義する。
// Phase 1 では会話は run 画面の state で保持し（resume は Phase 2）、最終生成時に
// /api/career/self-analysis へ conversation として渡す。
export type CareerSelfAnalysisTurn = {
  role: 'question' | 'answer';
  content: string;
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

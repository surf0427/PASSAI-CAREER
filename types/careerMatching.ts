// PASSAI 就活版 — 企業マッチングAIの型
//
// 就活版独自のコア機能。受験版のコピーではない。
// プロフィール・活動・自己分析・ES・面接・相談の結果を統合し、企業との相性を可視化する。
// DB / Supabase には接続せず localStorage のみで扱う。企業研究AIとは分離した型。

// 1 社分のマッチング結果。
// 「企業名を並べる」のではなく「なぜ向いているのか」を必ず根拠付きで持つ。
export type CareerCompanyMatch = {
  // 企業名（実在する日本国内企業のみ。根拠が弱い場合は名称に「（候補）」を含めてよい）。
  company: string;
  // 相性スコア（0〜100）。
  score: number;
  // マッチ理由（必須）。なぜ向いているのかの根拠。
  matchReasons: string[];
  // この企業で活きる本人の強み。
  strengthsUsed: string[];
  // 留意点（合う/合わないを見極めるために確認すべき観点。待遇は断定しない）。
  attentionPoints: string[];
  // この企業に向けて次に取るべき具体的アクション。
  nextActions: string[];
};

// マッチングAIの出力全体。
// API route（app/api/career/matching/route.ts）の出力と 1:1 で対応する。
export type CareerMatchingResult = {
  // 本人のプロフィール総括（マッチングの前提）。
  profileSummary: string;
  // タイプ分類（例:「裁量重視の挑戦型」など）。
  careerType: string;
  // 向いている業界（分散させる）。
  recommendedIndustries: string[];
  // 向いている職種。
  recommendedJobs: string[];
  // 企業マッチング（最大5社・大手/ベンチャー偏りなし・業界分散）。
  companyMatches: CareerCompanyMatch[];
  // 伸ばすべき領域。
  developmentAreas: string[];
  // 全体としての次の一歩。
  nextSteps: string[];
};

// 完了済みマッチング 1 件分の localStorage スナップショット（careerMatchingResults）。
export type CareerMatchingLog = {
  id: string;
  createdAt: string;
  // 任意: 実行時にユーザーが添えた志望の方向性メモ。
  userInput: string;
  result: CareerMatchingResult;
};

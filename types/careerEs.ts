// PASSAI 就活版 — ES（エントリーシート）作成AIの出力・ログ型
//
// 受験版の志望理由書（statement）系の型には依存しない（新卒就活向けに新規定義）。
// DB / Supabase には接続せず localStorage のみで扱う。

// 就活版 ES作成AI が返す JSON 構造。
// API route（app/api/career/es/route.ts）の出力と 1:1 で対応する。
export type CareerEsResult = {
  // ガクチカ（学生時代に力を入れたこと）本文ドラフト。
  gakuchika: string;
  // 自己PR本文ドラフト。
  selfPr: string;
  // 志望動機本文ドラフト。
  motivation: string;
  // キャッチコピー（自分を一言で表す見出し）。
  headline: string;
  // 企業へのアピールポイント。
  appealPoints: string[];
  // 面接で深掘りされそうな想定質問。
  interviewQuestions: string[];
  // 改善点（さらに良くするための指摘）。
  improvements: string[];
};

// 完了済み ES作成 1 件分の localStorage スナップショット。
// 保存キーは 'careerEsLogs'（app/career/es/esStorage.ts）。
export type CareerEsLog = {
  // 安定 ID（UI の選択キー / 重複排除に使う）。
  id: string;
  // 生成時刻（ISO 文字列）。
  createdAt: string;
  // 任意: 実行時にユーザーが添えた補足・志望企業メモなど。
  userInput: string;
  // AI 出力本体。
  result: CareerEsResult;
};

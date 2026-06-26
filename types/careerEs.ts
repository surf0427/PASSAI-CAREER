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

  // ── 設問モード（任意設問が指定されたとき）の追加フィールド ──────────
  // 後方互換: 既存の「おまかせ生成モード」（7フィールド一括）ログには存在しない。
  // 消費側は常に「未定義なら設問モードでない」と防御的に扱うこと。
  //
  // 設問に対する回答本文ドラフト。設問モードのときのみ生成される。
  answer?: string;
  // 生成時に与えられた ES 設問文（結果を自己完結させるため echo する）。
  question?: string;
  // 生成時に与えられた文字数指定。
  charLimit?: number;
  // 生成時に与えられた企業名（任意）。
  companyName?: string;
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

  // ── 企業別 ES 管理の土台（すべて optional・後方互換） ────────────────
  // 既存ログには存在しないため、read / normalize 側で defensive に扱うこと。
  //
  // 対象企業名（企業別の一覧・絞り込みに使う）。
  companyName?: string;
  // 生成に使った ES 設問文（設問モードのときに保存）。
  question?: string;
  // 生成に使った文字数指定。
  charLimit?: number;
  // お気に入りフラグ（結果画面でトグル）。
  favorite?: boolean;
  // 提出済みフラグ（結果画面でトグル）。
  submitted?: boolean;
  // 将来の編集保存用（今回は型のみ用意し、UI からは未書き込み）。
  editedResult?: CareerEsResult;
};

// PASSAI 就活版 — ES（エントリーシート）作成AIの出力・ログ型
//
// 受験版の志望理由書（statement）系の型には依存しない（新卒就活向けに新規定義）。
// DB / Supabase には接続せず localStorage のみで扱う。

// 選考種別（応募する選考の種類）。
//   - 'main'       : 本選考（入社を前提とした選考）
//   - 'internship' : インターン応募
// 未指定（undefined）は「選考種別の指定なし」を表す。後方互換のため optional 運用。
export type CareerEsSelectionType = 'main' | 'internship';

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
  // 生成時に与えられた選考種別（本選考 / インターン）。任意。
  selectionType?: CareerEsSelectionType;
  // 生成時に与えられた志望業界（このESに限った指定。任意）。
  industry?: string;
  // 生成時に与えられた志望職種（このESに限った指定。任意）。
  jobType?: string;
};

// ── AI添削（es-review）の型 ──────────────────────────────────────────
// 既存の生成系（CareerEsResult / CareerEsLog）とは独立した追加型。
// 既存型を一切変更しないため、後方互換は自明（新規 type の追加のみ）。
// 今回は localStorage に保存せず画面 state のみで扱う（将来 Supabase 保存も可能な形）。

// ランク（スコアから決定論で導出する。AI には決めさせない）。
export type CareerEsRank = 'S' | 'A' | 'B' | 'C' | 'D';

// 6 軸スコア（各 0〜100 の整数）。
export type CareerEsReviewBreakdown = {
  // 論理性。
  logic: number;
  // 具体性。
  specificity: number;
  // オリジナリティ。
  originality: number;
  // 読みやすさ。
  readability: number;
  // 説得力。
  persuasion: number;
  // 企業適合性。
  companyFit: number;
};

// ES添削AI の出力（API route app/api/career/es-review/route.ts の出力と 1:1）。
export type CareerEsReview = {
  // 総合スコア（0〜100。breakdown 6 軸の平均から決定論で導出）。
  overallScore: number;
  // ランク（overallScore から決定論で導出）。
  rank: CareerEsRank;
  // 総評（全体所感）。
  overallComment: string;
  // 6 軸スコア。
  breakdown: CareerEsReviewBreakdown;
  // 良い点。
  strengths: string[];
  // 改善点。
  improvements: string[];
  // そのまま提出できる完成版（盛りすぎ禁止・事実の捏造禁止）。
  rewriteExample: string;
  // 優先的に直すべきアクション（重要な順）。
  priorityActions: string[];
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
  // 生成に使った選考種別（本選考 / インターン）。
  selectionType?: CareerEsSelectionType;
  // 生成に使った志望業界（このESに限った指定）。
  industry?: string;
  // 生成に使った志望職種（このESに限った指定）。
  jobType?: string;
  // お気に入りフラグ（結果画面でトグル）。
  favorite?: boolean;
  // 提出済みフラグ（結果画面でトグル）。
  submitted?: boolean;
  // 将来の編集保存用（今回は型のみ用意し、UI からは未書き込み）。
  editedResult?: CareerEsResult;

  // ── ログの出自（添削からの改善版保存など） ──────────────────────────
  // 既存ログには存在しないため、欠損を前提に防御的に扱うこと。
  //
  // このログの生成元ログの ID（改善版保存のとき元ログを指す）。
  sourceLogId?: string;
  // ログの種別。未指定（欠損）は従来の生成ログ（'generated' 相当）として扱う。
  //   - 'generated'      : ES生成（おまかせ / 設問モード）由来
  //   - 'review_rewrite' : AI添削の rewriteExample を改善版として保存したもの
  sourceType?: 'generated' | 'review_rewrite';
};

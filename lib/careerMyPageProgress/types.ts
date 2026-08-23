// PASSAI CAREER — マイページ「練習・作成の進度 / 成長進度」の表示用型。
//
// 純粋な型のみ（I/O / env / React 非依存）。server aggregation・client fallback・QA が共有する。
//
// 設計原則（このレイヤは「読むだけ」）:
//   - 新しい評価ロジックを作らない。既存機能が **すでに保存している数値** を読み出して並べるだけ。
//   - AI を呼ばない。スコアを再計算しない。欠損を 0 点で埋めない（＝グラフ対象から外す）。
//   - グラフに要るもの（id / score / 軸 / 時刻）だけを持つ。本文・transcript・AI 全文は持たない。

/** 各機能の実施・作成回数（ユーザー視点で「1 回」に相当する単位で数えたもの）。 */
export type CareerMyPageActivityProgress = {
  selfAnalysisCount: number;
  esCount: number;
  interviewCount: number;
  presentationCount: number;
};

/**
 * 自己分析レーダーの 1 軸。
 *
 * ★ これは **点数ではない**。自己分析の既存出力（CareerSelfAnalysisResult）の各 field に
 *   「いくつ言語化できているか」の **件数** である。自己分析には既存の数値評価が存在しない
 *   ため、点数を捏造せず、実データの件数だけを描く（scale も件数のまま扱う）。
 */
export type CareerSelfUnderstandingDimension = {
  /** CareerSelfAnalysisResult の field 名と 1:1（表示ラベルと切り離した安定 key）。 */
  key: string;
  label: string;
  /** 非空・重複除去後の件数。 */
  count: number;
};

export type CareerSelfAnalysisProgress = {
  /** 最新の「中身のある」自己分析結果。1 件も無い / 全軸 0 件なら null（＝empty state）。 */
  latest: {
    id: string;
    createdAt: string;
    dimensions: CareerSelfUnderstandingDimension[];
  } | null;
};

/** 折れ線 1 点 = ユーザー視点で確定した 1 件の最終評価。 */
export type CareerGrowthPoint = {
  id: string;
  /** 時系列順の通し番号（1 始まり = 「1 回目」）。 */
  attempt: number;
  /** 既存仕様のスコアをそのまま（ES / 面接 / プレゼンとも 0〜100）。 */
  score: number;
  /** 結果が確定した時刻（ISO 文字列）。 */
  completedAt: string;
};

export type CareerGrowthSeries = {
  /** 古い → 新しい順。スコアが無い / 未完了 / 日時不正のものは含まれない。 */
  history: CareerGrowthPoint[];
  /** 最新点のスコア。history が空なら null。 */
  latestScore: number | null;
  /** 前回比。history が 2 点未満なら null（＝「初回」表示）。 */
  delta: number | null;
  /** 実施・作成の総数（スコア未確定のものも含む＝「練習・作成の進度」と同じ数）。 */
  totalCount: number;
};

export type CareerMyPageProgress = {
  activity: CareerMyPageActivityProgress;
  selfAnalysis: CareerSelfAnalysisProgress;
  es: CareerGrowthSeries;
  interview: CareerGrowthSeries;
  presentation: CareerGrowthSeries;
};

/** 表示中の数値がどこ由来か（UI の注記に使う。値そのものは同じ純関数が作る）。 */
export type CareerMyPageProgressSource = 'server' | 'device';

export const EMPTY_CAREER_GROWTH_SERIES: CareerGrowthSeries = {
  history: [],
  latestScore: null,
  delta: null,
  totalCount: 0,
};

export const EMPTY_CAREER_MYPAGE_PROGRESS: CareerMyPageProgress = {
  activity: {
    selfAnalysisCount: 0,
    esCount: 0,
    interviewCount: 0,
    presentationCount: 0,
  },
  selfAnalysis: { latest: null },
  es: EMPTY_CAREER_GROWTH_SERIES,
  interview: EMPTY_CAREER_GROWTH_SERIES,
  presentation: EMPTY_CAREER_GROWTH_SERIES,
};

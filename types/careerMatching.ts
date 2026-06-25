// PASSAI 就活版 — 企業マッチングAIの型（storage 連携）
//
// 就活版独自のコア機能。受験版のコピーではない。
// スコアの本体（CareerMatchEngineResult / CompanyScore など）は決定的スコアリングエンジン
// （@/lib/careerMatching）が所有する。本ファイルは localStorage 永続化の単位のみを定義する。
// DB / Supabase には接続せず localStorage のみで扱う。

import type { CareerMatchEngineResult } from '@/lib/careerMatching';

// 完了済みマッチング 1 件分の localStorage スナップショット（careerMatchingResults）。
// result は決定的エンジンの出力。schemaVersion は result.schemaVersion を参照する
// （旧スキーマのログは UI 側で版判定し「再実行」へ誘導する）。
export type CareerMatchingLog = {
  id: string;
  createdAt: string;
  // 任意: 実行時にユーザーが添えた志望の方向性メモ。
  userInput: string;
  result: CareerMatchEngineResult;
};

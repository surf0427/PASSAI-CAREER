// PASSAI 就活版 AI 共通基盤 — ログ（スタブ）
//
// 将来 DB（就活版専用テーブル）へ保存するための「ログ型」と「スタブ関数」を定義する。
//
// 重要: 本フェーズでは DB へは書き込まない。Supabase client も import しない。
// console.log も出さない。すべて No-op（呼んでも何もしない）。
// 実際の永続化は、就活版 usage/DB 設計が固まった次フェーズで配線する。

import type { CareerAiFeatureKey } from './types';

// AI 利用 1 回分のログ payload（将来 DB 保存する想定の形）。
export type CareerAiLogPayload = {
  featureKey: CareerAiFeatureKey;
  // 'success' | 'error' | 'truncated' などを想定（自由文字列で前方互換）。
  status: string;
  // 任意: トークン使用量（入力/出力）。未計測なら undefined。
  inputTokens?: number;
  outputTokens?: number;
  // 任意: モデル識別子・所要 ms など補助情報。
  model?: string;
  durationMs?: number;
  // 任意: バリデーション・エラーの補足メッセージ。
  message?: string;
};

// AI バリデーション結果のログ payload（将来 DB 保存する想定の形）。
export type CareerAiValidationPayload = {
  featureKey: CareerAiFeatureKey;
  // 入力/出力どちらの検証かなど。自由文字列で前方互換。
  kind: string;
  ok: boolean;
  message?: string;
};

// AI 利用ログ（No-op スタブ）。
// 次フェーズで就活版専用テーブルへの insert に差し替える。今は意図的に何もしない。
export function logCareerAiUsage(payload: CareerAiLogPayload): void {
  // no-op: DB 未接続。受験版 usage ログ（logAiUsage 等）には絶対に接続しない。
  // payload は次フェーズで就活版テーブルへ insert する。今は意図的に破棄する。
  void payload;
}

// AI バリデーションログ（No-op スタブ）。
export function logCareerAiValidation(payload: CareerAiValidationPayload): void {
  // no-op: DB 未接続。受験版 validation ログ（logAiValidation 等）には接続しない。
  void payload;
}

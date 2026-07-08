/**
 * career_user_events — 「本文を持たない観測ログ」の型定義（STEP-CAREER-EVENTLOG-P1）。
 *
 * - 本ファイルは型のみ（repo 規約: 型定義は types/ に置く）。
 * - 記録ロジックは lib/careerEvents/*（sanitize / record）。
 * - Event Log は将来の匿名集計の一次データ。個人の自由記述・回答本文は一切入れない。
 *   混入防止は lib/careerEvents/sanitize.ts の allowlist / denylist で担保する。
 */

// イベント種別（enum 風 union）。
export type CareerEventType =
  | 'feature_started'
  | 'feature_completed'
  | 'feature_abandoned'
  | 'ai_generated'
  | 'ai_reviewed'
  | 'score_recorded'
  | 'weakness_identified'
  | 'action_suggested'
  | 'company_researched'
  | 'matching_run'
  | 'consultation_asked';

// 機能名（enum 風 union）。
export type CareerEventFeature =
  | 'profile'
  | 'activity'
  | 'values'
  | 'self_analysis'
  | 'es'
  | 'interview'
  | 'presentation'
  | 'company_research'
  | 'matching'
  | 'consultation'
  | 'gd';

// 生スコアは保存しない。保存する場合は必ずこの band に変換する。
export type CareerScoreBand = 'S' | 'A' | 'B' | 'C' | 'D';

// metadata に入れてよい値はスカラーのみ（object / array は本文混入源なので許可しない）。
export type CareerEventMetadataValue = string | number | boolean;
export type CareerEventMetadata = Record<string, CareerEventMetadataValue>;

// recordCareerEvent の入力。すべて optional の低リスク metadata。本文フィールドは持たない。
export type CareerEventInput = {
  feature: CareerEventFeature;
  eventType: CareerEventType;
  companyId?: string | null; // uuid のみ採用（それ以外は drop）
  industry?: string | null;
  jobType?: string | null;
  selectionPhase?: string | null;
  scoreBand?: CareerScoreBand | null;
  weaknessCategory?: string | null;
  nextAction?: string | null;
  completionStatus?: string | null;
  clientEventId?: string | null; // 二重記録の冪等吸収用（任意）
  metadata?: Record<string, unknown>; // sanitize で allowlist 通過分のみ保存
};

// ランタイム検証用の許可値一覧（union と同期）。
export const CAREER_EVENT_TYPES: readonly CareerEventType[] = [
  'feature_started',
  'feature_completed',
  'feature_abandoned',
  'ai_generated',
  'ai_reviewed',
  'score_recorded',
  'weakness_identified',
  'action_suggested',
  'company_researched',
  'matching_run',
  'consultation_asked',
];

export const CAREER_EVENT_FEATURES: readonly CareerEventFeature[] = [
  'profile',
  'activity',
  'values',
  'self_analysis',
  'es',
  'interview',
  'presentation',
  'company_research',
  'matching',
  'consultation',
  'gd',
];

export const CAREER_SCORE_BANDS: readonly CareerScoreBand[] = ['S', 'A', 'B', 'C', 'D'];

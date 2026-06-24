// PASSAI 就活版 AI 共通基盤 — usage（利用上限）設計
//
// 就活版 AI の feature key 別・プラン別の利用上限「設計値」を保持する。
//
// 重要: 本ファイルは既存の課金・usage 処理（ensurePlanQuota / recordUsage / Stripe /
// Supabase usage ログ）には一切接続しない。あくまで設計値（定数）と純粋な参照関数のみ。
// 実際のクォータ判定・消費記録は次フェーズで別途配線する。

import type { CareerAiFeatureKey, CareerPlan } from './types';
import { CAREER_AI_FEATURE_KEYS } from './types';

// プラン別・機能別の上限設計値。
// 未掲載の (plan, feature) の組み合わせは「未提供 = 0」とみなす（getCareerFeatureLimit 参照）。
//
// 数値は設計のたたき台であり、課金実装時に確定する。0 は「そのプランでは使えない」を表す。
export const CAREER_PLAN_LIMITS: Record<
  CareerPlan,
  Partial<Record<CareerAiFeatureKey, number>>
> = {
  free: {
    'career-self-analysis': 1,
    'career-es': 0,
    'career-interview': 0,
    'career-consultation': 0,
  },
  basic: {
    'career-self-analysis': 10,
    'career-es': 10,
    'career-interview': 5,
    'career-consultation': 10,
  },
  premium: {
    'career-self-analysis': 30,
    'career-es': 30,
    'career-interview': 20,
    'career-consultation': 30,
    'career-company-research': 30,
    'career-gd': 10,
    'career-aptitude': 20,
  },
};

// 指定プラン・機能の利用上限を返す。未掲載は 0（未提供）。
export function getCareerFeatureLimit(
  plan: CareerPlan,
  featureKey: CareerAiFeatureKey,
): number {
  return CAREER_PLAN_LIMITS[plan]?.[featureKey] ?? 0;
}

// 任意の値が CareerAiFeatureKey かを判定する type guard。
export function isCareerAiFeatureKey(value: unknown): value is CareerAiFeatureKey {
  return (
    typeof value === 'string' &&
    (CAREER_AI_FEATURE_KEYS as readonly string[]).includes(value)
  );
}

'use client';

// PASSAI 就活版 — 面接AI 入力コンテキストの収集（クライアント）。
//
// 受験版 app/interview/ai/sourceData.ts に相当するが、就活版の localStorage キーからのみ読む。
//   - careerBasicFormData      → profile
//   - careerActivityFormData   → activity
//   - careerSelfAnalysisLogs[0] → selfAnalysis（最新）
//   - careerEsLogs[0]          → es（最新）
// 受験版ストレージ・DB・Supabase は一切参照しない。

import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData } from '@/app/career/activity/activityStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadEsLogs } from '@/app/career/es/esStorage';
import type { BasicInfo } from '@/types/basicInfo';
import type { ActivityData } from '@/types/activity';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';

export type CareerInterviewContextPayload = {
  profile: BasicInfo | null;
  activity: ActivityData | null;
  selfAnalysis: CareerSelfAnalysisResult | null;
  es: CareerEsResult | null;
};

export function hasAnyActivity(activity: ActivityData | null): boolean {
  if (!activity) return false;
  return Object.values(activity).some((v) => Array.isArray(v) && v.length > 0);
}

// 面接AI API に渡す入力コンテキストを localStorage から組み立てる。
export function buildInterviewContextPayload(): CareerInterviewContextPayload {
  const selfAnalysisLogs = loadSelfAnalysisLogs();
  const esLogs = loadEsLogs();
  return {
    profile: loadBasicInfo(),
    activity: loadActivityData(),
    selfAnalysis: selfAnalysisLogs.length > 0 ? selfAnalysisLogs[0].result : null,
    es: esLogs.length > 0 ? esLogs[0].result : null,
  };
}

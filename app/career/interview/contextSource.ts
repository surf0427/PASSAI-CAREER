'use client';

// PASSAI 就活版 — 面接AI 入力コンテキストの収集（クライアント）。
//
// 受験版 app/interview/ai/sourceData.ts に相当するが、就活版の localStorage キーからのみ読む。
//   - careerBasicFormData      → profile
//   - careerActivityData   → activity
//   - careerSelfAnalysisLogs[0] → selfAnalysis（最新）
//   - careerEsLogs[0]          → es（最新）
// 受験版ストレージ・DB・Supabase は一切参照しない。

import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import {
  loadActivityData,
  hasAnyActivity,
} from '@/app/career/activity/activityStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadEsLogs } from '@/app/career/es/esStorage';
import { loadCareerValues } from '@/app/career/values/careerValuesStorage';
import type { BasicInfo } from '@/types/basicInfo';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';

export type CareerInterviewContextPayload = {
  profile: BasicInfo | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysis: CareerSelfAnalysisResult | null;
  es: CareerEsResult | null;
};

// readiness 判定は activityStorage の hasAnyActivity を正本として再エクスポートする
// （interview/page.tsx・interview/setup/page.tsx が本モジュール経由で参照する）。
export { hasAnyActivity };

// 面接AI API に渡す入力コンテキストを localStorage から組み立てる。
export function buildInterviewContextPayload(): CareerInterviewContextPayload {
  const selfAnalysisLogs = loadSelfAnalysisLogs();
  const esLogs = loadEsLogs();
  return {
    profile: loadBasicInfo(),
    activity: loadActivityData(),
    values: loadCareerValues(),
    selfAnalysis: selfAnalysisLogs.length > 0 ? selfAnalysisLogs[0].result : null,
    es: esLogs.length > 0 ? esLogs[0].result : null,
  };
}

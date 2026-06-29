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
import { loadMatchingLogs } from '@/app/career/matching/matchingStorage';
import { loadConsultationThreads } from '@/app/career/consultation/consultationStorage';
import type { BasicInfo } from '@/types/basicInfo';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';

export type CareerInterviewContextPayload = {
  profile: BasicInfo | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysis: CareerSelfAnalysisResult | null;
  es: CareerEsResult | null;
  // 任意の参考データ（存在しないユーザーでは null / 空配列。プロンプトに出さないだけで落ちない）。
  matching: CareerMatchEngineResult | null;
  consultationInsights: string[];
};

// 相談AIスレッドから最近の気づき（keyInsights）を最大 maxItems 件、新しい順に集める。
// 存在しない／未利用でも空配列を返す（参考程度の連携なので落とさない）。
function collectConsultationInsights(maxItems = 5): string[] {
  let threads: ReturnType<typeof loadConsultationThreads>;
  try {
    threads = loadConsultationThreads();
  } catch {
    return [];
  }
  const sorted = [...threads].sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  );
  const insights: string[] = [];
  for (const thread of sorted) {
    // 新しいメッセージから走査し、assistant の result.keyInsights を拾う。
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const msg = thread.messages[i];
      const items = msg.role === 'assistant' ? msg.result?.keyInsights : undefined;
      if (Array.isArray(items)) {
        for (const it of items) {
          const t = typeof it === 'string' ? it.trim() : '';
          if (t && !insights.includes(t)) insights.push(t);
          if (insights.length >= maxItems) return insights;
        }
      }
    }
  }
  return insights;
}

// readiness 判定は activityStorage の hasAnyActivity を正本として再エクスポートする
// （interview/page.tsx・interview/setup/page.tsx が本モジュール経由で参照する）。
export { hasAnyActivity };

// 面接AI API に渡す入力コンテキストを localStorage から組み立てる。
export function buildInterviewContextPayload(): CareerInterviewContextPayload {
  const selfAnalysisLogs = loadSelfAnalysisLogs();
  const esLogs = loadEsLogs();
  let matching: CareerMatchEngineResult | null = null;
  try {
    const matchingLogs = loadMatchingLogs();
    matching = matchingLogs.length > 0 ? matchingLogs[0].result : null;
  } catch {
    matching = null;
  }
  return {
    profile: loadBasicInfo(),
    activity: loadActivityData(),
    values: loadCareerValues(),
    selfAnalysis: selfAnalysisLogs.length > 0 ? selfAnalysisLogs[0].result : null,
    es: esLogs.length > 0 ? esLogs[0].result : null,
    matching,
    consultationInsights: collectConsultationInsights(),
  };
}

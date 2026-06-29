'use client';

// PASSAI 就活版 — プレゼン対策AI 入力コンテキストの収集（クライアント）。
//
// 就活版の localStorage キーからのみ読む（受験版ストレージ・DB・Supabase は参照しない）。
// 面接AIの contextSource と同方針で、存在しないデータがあっても落ちないよう全て guarded read。
//   - 基本情報 / 活動整理 / 就活軸 / 自己分析(最新) / ES(最新)
//   - AI面接結果(最新) / 就活マッチング結果(最新) / 相談AIの気づき（参考程度）

import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData, hasAnyActivity } from '@/app/career/activity/activityStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadEsLogs } from '@/app/career/es/esStorage';
import { loadCareerValues } from '@/app/career/values/careerValuesStorage';
import { loadInterviewResults } from '@/app/career/interview/interviewStorage';
import { loadMatchingLogs } from '@/app/career/matching/matchingStorage';
import { loadConsultationThreads } from '@/app/career/consultation/consultationStorage';
import type { BasicInfo } from '@/types/basicInfo';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';
import type { CareerEsResult } from '@/types/careerEs';
import type { CareerInterviewFinalResult } from '@/types/careerInterview';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';

export type CareerPresentationContextPayload = {
  profile: BasicInfo | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysis: CareerSelfAnalysisResult | null;
  es: CareerEsResult | null;
  // 任意の参考データ（存在しないユーザーでは null / 空配列。プロンプトに出さないだけで落ちない）。
  interview: CareerInterviewFinalResult | null;
  matching: CareerMatchEngineResult | null;
  consultationInsights: string[];
};

// activity の readiness 判定を再エクスポート（hub/setup から参照）。
export { hasAnyActivity };

// try/catch で包んで「ストレージ未実装・破損でも落ちない」を担保する小ヘルパー。
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// 相談AIスレッドから最近の気づき（keyInsights）を最大 maxItems 件、新しい順に集める。
function collectConsultationInsights(maxItems = 5): string[] {
  const threads = safe(() => loadConsultationThreads(), []);
  const sorted = [...threads].sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  );
  const insights: string[] = [];
  for (const thread of sorted) {
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

// プレゼンAI API に渡す入力コンテキストを localStorage から組み立てる。
export function buildPresentationContextPayload(): CareerPresentationContextPayload {
  const selfAnalysisLogs = safe(() => loadSelfAnalysisLogs(), []);
  const esLogs = safe(() => loadEsLogs(), []);
  const interviewResults = safe(() => loadInterviewResults(), []);
  const matchingLogs = safe(() => loadMatchingLogs(), []);
  return {
    profile: safe(() => loadBasicInfo(), null),
    activity: safe(() => loadActivityData(), null),
    values: safe(() => loadCareerValues(), null),
    selfAnalysis: selfAnalysisLogs.length > 0 ? selfAnalysisLogs[0].result : null,
    es: esLogs.length > 0 ? esLogs[0].result : null,
    interview: interviewResults.length > 0 ? interviewResults[0].result : null,
    matching: matchingLogs.length > 0 ? matchingLogs[0].result : null,
    consultationInsights: collectConsultationInsights(),
  };
}

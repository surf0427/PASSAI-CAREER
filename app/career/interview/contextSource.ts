'use client';

// PASSAI 就活版 — 面接AI 入力コンテキストの収集（クライアント）。
//
// 受験版 app/interview/ai/sourceData.ts に相当するが、就活版の localStorage キーからのみ読む。
//   - careerBasicFormData      → profile
//   - careerActivityData   → activity
//   - careerSelfAnalysisLogs[0] → selfAnalysis（最新）
//   - careerEsLogs[0]          → es（最新）
// 受験版ストレージ・DB・Supabase は一切参照しない。
//
// P4-D: 横断 context の組み立ては lib/careerMemory/selector.ts（純関数）へ抽出した。
//   本モジュールは「load*（localStorage 読み出し）+ guarded read」に徹し、生データを selector へ渡す。
//   出力 payload（buildInterviewContextPayload の戻り値）は旧実装と byte 不変。

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
import { loadCompanyResearchLog } from '@/app/career/company-research/companyResearchStorage';
import {
  buildInterviewRequestContext,
  type CareerInterviewContextPayload,
} from '@/lib/careerMemory/selector';
import type { CareerCompanyResearchLog } from '@/types/careerCompanyResearch';
import type { CareerConsultationThread } from '@/types/careerConsultation';
import type { CareerMatchingLog } from '@/types/careerMatching';

// 型は selector に移設。既存 importer（interview/setup/page.tsx）互換のため re-export する。
export type { CareerInterviewContextPayload };

// readiness 判定は activityStorage の hasAnyActivity を正本として再エクスポートする
// （interview/page.tsx・interview/setup/page.tsx が本モジュール経由で参照する）。
export { hasAnyActivity };

// 相談スレッドを guarded read（読めなければ空配列。参考程度の連携なので落とさない）。
function loadConsultationThreadsSafe(): CareerConsultationThread[] {
  try {
    return loadConsultationThreads();
  } catch {
    return [];
  }
}

// 企業マッチングログを guarded read（読めなければ空配列）。
function loadMatchingLogsSafe(): CareerMatchingLog[] {
  try {
    return loadMatchingLogs();
  } catch {
    return [];
  }
}

// 選択された企業研究ログ（id）を guarded read（未選択・不存在・読取失敗なら null）。
function loadCompanyResearchLogSafe(
  companyResearchLogId?: string | null,
): CareerCompanyResearchLog | null {
  if (!companyResearchLogId) return null;
  try {
    return loadCompanyResearchLog(companyResearchLogId);
  } catch {
    return null;
  }
}

// 面接AI API に渡す入力コンテキストを localStorage から組み立てる。
// P4-D: load* はここ（client）に残し、組み立ては純関数 selector へ委譲する（payload は byte 不変）。
// companyResearchLogId を渡すと、その企業研究ログを面接用コンテキストとして含める（任意）。
export function buildInterviewContextPayload(
  companyResearchLogId?: string | null,
): CareerInterviewContextPayload {
  return buildInterviewRequestContext({
    profile: loadBasicInfo(),
    activity: loadActivityData(),
    values: loadCareerValues(),
    selfAnalysisLogs: loadSelfAnalysisLogs(),
    esLogs: loadEsLogs(),
    matchingLogs: loadMatchingLogsSafe(),
    consultationThreads: loadConsultationThreadsSafe(),
    companyResearchLog: loadCompanyResearchLogSafe(companyResearchLogId),
  });
}

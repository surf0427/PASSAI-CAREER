'use client';

// PASSAI 就活版 — プレゼン対策AI 入力コンテキストの収集（クライアント）。
//
// 就活版の localStorage キーからのみ読む（受験版ストレージ・DB・Supabase は参照しない）。
// 面接AIの contextSource と同方針で、存在しないデータがあっても落ちないよう全て guarded read。
//   - 基本情報 / 活動整理 / 就活軸 / 自己分析(最新) / ES(最新)
//   - AI面接結果(最新) / 就活マッチング結果(最新) / 相談AIの気づき（参考程度）
//
// P4-E1: 横断 context の組み立ては lib/careerMemory/selector.ts（純関数）へ抽出した。
//   本モジュールは「load*（localStorage 読み出し）+ guarded read」に徹し、生データを selector へ渡す。
//   出力 payload（buildPresentationContextPayload の戻り値）は旧実装と byte 不変。

import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData, hasAnyActivity } from '@/app/career/activity/activityStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadEsLogs } from '@/app/career/es/esStorage';
import { loadCareerValues } from '@/app/career/values/careerValuesStorage';
import { loadInterviewResults } from '@/app/career/interview/interviewStorage';
import { loadMatchingLogs } from '@/app/career/matching/matchingStorage';
import { loadConsultationThreads } from '@/app/career/consultation/consultationStorage';
import {
  buildPresentationRequestContext,
  type CareerPresentationContextPayload,
} from '@/lib/careerMemory/selector';

// 型は selector に移設。既存 importer（presentation/setup/page.tsx）互換のため re-export する。
export type { CareerPresentationContextPayload };

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

// プレゼンAI API に渡す入力コンテキストを localStorage から組み立てる。
// P4-E1: load*/guarded read はここ（client）に残し、組み立ては純関数 selector へ委譲する（payload は byte 不変）。
export function buildPresentationContextPayload(): CareerPresentationContextPayload {
  return buildPresentationRequestContext({
    profile: safe(() => loadBasicInfo(), null),
    activity: safe(() => loadActivityData(), null),
    values: safe(() => loadCareerValues(), null),
    selfAnalysisLogs: safe(() => loadSelfAnalysisLogs(), []),
    esLogs: safe(() => loadEsLogs(), []),
    interviewResults: safe(() => loadInterviewResults(), []),
    matchingLogs: safe(() => loadMatchingLogs(), []),
    consultationThreads: safe(() => loadConsultationThreads(), []),
  });
}

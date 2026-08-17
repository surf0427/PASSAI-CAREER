'use client';

// PASSAI 就活版 — ES 添削 入力コンテキストの収集（クライアント）。
//
// app/career/interview/contextSource.ts と同じ役割・同じ構造:
//   本モジュールは「load*（localStorage 読み出し）+ guarded read」に徹し、
//   組み立ては純関数 selector（lib/careerEs/reviewContext.ts）へ委譲する。
//   → client / server が同じ selector を使うため、server 化しても payload の意味は変わらない。
//
// 読むキー（就活版 localStorage のみ。受験版ストレージ・DB は一切参照しない）:
//   careerBasicFormData    → profile
//   careerActivityData     → activity
//   careerValues           → values
//   careerSelfAnalysisLogs[0].result → selfAnalysis（最新 1 件）
//
// 読めない項目は null / 空配列で落とす（ES 添削は User Data Spine が空でも従来どおり成立する）。

import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData } from '@/app/career/activity/activityStorage';
import { loadCareerValues } from '@/app/career/values/careerValuesStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import {
  buildEsReviewRequestContext,
  EMPTY_ES_REVIEW_CONTEXT,
  type CareerEsReviewContextPayload,
} from '@/lib/careerEs/reviewContext';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';

export type { CareerEsReviewContextPayload };

/** 自己分析ログを guarded read（読めなければ空配列。添削は落とさない）。 */
function loadSelfAnalysisLogsSafe(): CareerSelfAnalysisLog[] {
  try {
    return loadSelfAnalysisLogs();
  } catch {
    return [];
  }
}

/**
 * ES 深掘り / 材料整理 API に渡す **fallback 用 bridge**（base 3 kind のみ）。
 *
 * ★ 深掘りは「本人が選んだ材料（knownFacts）」を最優先する UX を維持する。
 *   本 bridge は materials 未選択時に server 側が背景 context を組むためだけに使われ、
 *   選択済みユーザーでは server 側で無視される（prompt は byte 不変）。
 *   自己分析は送らない（深掘りの主題は活動整理・基本情報・就活軸のため）。
 */
export function esFallbackBridge(): {
  profile: CareerEsReviewContextPayload['profile'];
  activity: CareerEsReviewContextPayload['activity'];
  values: CareerEsReviewContextPayload['values'];
  selfAnalysis: CareerEsReviewContextPayload['selfAnalysis'];
} {
  try {
    // 選択規則（最新 1 件）は canonical selector に委譲する（ES 専用実装を作らない）。
    return buildEsReviewRequestContext({
      profile: loadBasicInfo(),
      activity: loadActivityData(),
      values: loadCareerValues(),
      selfAnalysisLogs: loadSelfAnalysisLogsSafe(),
    });
  } catch {
    return EMPTY_ES_REVIEW_CONTEXT;
  }
}

/**
 * ES 添削 API に渡す User Data Spine payload を localStorage から組み立てる。
 *
 * ★ never-throw: どこか 1 つの storage が壊れていても添削フローを止めない
 *   （全部読めなければ空 payload ＝ 従来どおり ES 設定のみで添削される）。
 */
export function buildEsReviewContextPayload(): CareerEsReviewContextPayload {
  try {
    return buildEsReviewRequestContext({
      profile: loadBasicInfo(),
      activity: loadActivityData(),
      values: loadCareerValues(),
      selfAnalysisLogs: loadSelfAnalysisLogsSafe(),
    });
  } catch {
    return EMPTY_ES_REVIEW_CONTEXT;
  }
}

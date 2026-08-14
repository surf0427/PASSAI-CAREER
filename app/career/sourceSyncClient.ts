'use client';

// PASSAI CAREER — client 側 source-sync signal 生成（D-R2 closure / Option A）。
//
// 責務: localStorage canonical から Layer 1 Source bundle を組み、
//   `lib/careerSourceSync/revision.ts` の **server と同一の純関数** で revision を算出して
//   HTTP header 値へ直列化する。
//
// 厳守:
//   - 送るのは kind 別の 8 hex token のみ。**生データ / PII / 本文は一切送らない**。
//   - never-throw。localStorage が壊れていても機能を止めない（signal 無し ⇒ server 側は veto ＝安全側）。
//   - server は本 signal を「使わない方向へ倒す」ためだけに使う（signal.ts の trust model 参照）。
//   - app 層（localStorage loader）に依存するため lib ではなく app へ置く（lib→app 依存を作らない既存方針）。

import { computeSourceSyncRevisions } from '@/lib/careerSourceSync/revision';
import {
  CAREER_SOURCE_SYNC_HEADER,
  serializeSourceSyncSignal,
} from '@/lib/careerSourceSync/signal';
import type { CareerSourceBundle, CareerSourceKind } from '@/lib/careerSourceData/types';
// localStorage canonical loaders（既存・guarded）。shadow-write と同じ入口を使う。
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData } from '@/app/career/activity/activityStorage';
import { loadCareerValues } from '@/app/career/values/careerValuesStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadEsLogs } from '@/app/career/es/esStorage';
import { loadInterviewResults } from '@/app/career/interview/interviewStorage';
// Batch 2: cross-feature source kind の canonical loader。
import { loadMatchingLogs } from '@/app/career/matching/matchingStorage';
import { loadCompanyResearchLogs } from '@/app/career/company-research/companyResearchStorage';
import { loadPresentationResults } from '@/app/career/presentation/presentationStorage';
import { loadConsultationThreads } from '@/app/career/consultation/consultationStorage';

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * localStorage canonical から Layer 1 bundle を組む（never-throw）。
 * ★ 必要な kind だけ読む（不要な localStorage read をしない）。
 */
export function loadCanonicalSourceBundle(
  kinds: readonly CareerSourceKind[],
): CareerSourceBundle {
  const want = new Set<CareerSourceKind>(kinds);
  return {
    profile: want.has('profile') ? safe(() => loadBasicInfo(), null) : null,
    activity: want.has('activity') ? safe(() => loadActivityData(), null) : null,
    values: want.has('values') ? safe(() => loadCareerValues(), null) : null,
    selfAnalysisLogs: want.has('self_analysis') ? safe(() => loadSelfAnalysisLogs(), []) : [],
    esLogs: want.has('es') ? safe(() => loadEsLogs(), []) : [],
    interviewResults: want.has('interview') ? safe(() => loadInterviewResults(), []) : [],
    matchingLogs: want.has('matching') ? safe(() => loadMatchingLogs(), []) : [],
    companyResearchLogs: want.has('company_research') ? safe(() => loadCompanyResearchLogs(), []) : [],
    presentationResults: want.has('presentation') ? safe(() => loadPresentationResults(), []) : [],
    consultationThreads: want.has('consultation') ? safe(() => loadConsultationThreads(), []) : [],
  } as CareerSourceBundle;
}

/**
 * 指定 kind の sync header 値を作る（never-throw）。
 * 生成できなければ空文字（＝header を付けない ⇒ server は unclaimed で veto ＝安全側）。
 */
export function buildSourceSyncHeaderValue(kinds: readonly CareerSourceKind[]): string {
  try {
    if (kinds.length === 0) return '';
    const bundle = loadCanonicalSourceBundle(kinds);
    return serializeSourceSyncSignal(computeSourceSyncRevisions(bundle, kinds));
  } catch {
    return '';
  }
}

/**
 * fetch の headers へ sync header を足して返す（never-throw）。
 * 空なら header を付けない（＝明示的に「証明を提示しない」＝server veto）。
 */
export function withSourceSyncHeader(
  headers: Record<string, string>,
  kinds: readonly CareerSourceKind[],
): Record<string, string> {
  const value = buildSourceSyncHeaderValue(kinds);
  if (!value) return headers;
  return { ...headers, [CAREER_SOURCE_SYNC_HEADER]: value };
}

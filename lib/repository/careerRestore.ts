"use client";

/**
 * STEP-CAREER-SUPABASE-02: 就活版（career）各機能の初回 Supabase→localStorage restore（下り）。
 *
 * 役割:
 *   - ログイン（member）確定後に 1 度だけ、Supabase の durable mirror（lib/supabase/career*.ts）に
 *     貯まっている career データを localStorage（canonical）へマージ復元する。
 *   - 別端末ログイン時など localStorage が空 / 部分的でも、マイページ（/career/mypage）や各機能が
 *     ログイン済みユーザーのクラウド由来ログを復元できるようにする。上り backfill
 *     （lib/repository/careerBackfill.ts）と対になる下り方向。
 *   - feature 単位で backfillFlag（key='supabaseBackfill'、'careerXRestore'）に完了を記録し、
 *     二度手間・delete resurrection を防ぐ（1 端末につき 1 回のみ）。
 *
 * マージ方針（localStorage を絶対に壊さない）:
 *   - 単一レコード系（profile / activity / values）: localStorage が空のときだけ remote で埋める。
 *     手元の未同期編集を上書きしない。
 *   - 履歴系（self-analysis / matching / es / interview-results / presentation-results /
 *     company-research / consultation）: id で merge（local 優先）。remote が新規に持つ行だけ足す。
 *   - never throw（best-effort）。userId 空 / env 未設定 / 失敗時は各 restore が no-op。
 *
 * 受験版データには一切触れない（career-prefixed の LS / career_* table のみ）。
 */

import { backfillDone, markBackfillDone, type BackfillFeature } from "./backfillFlag";

import { loadBasicInfo, saveBasicInfo } from "@/app/career/profile/profileStorage";
import { loadActivityData, saveActivityData } from "@/app/career/activity/activityStorage";
import {
  loadCareerValues,
  saveCareerValues,
  isCareerValuesEmpty,
} from "@/app/career/values/careerValuesStorage";
import {
  loadSelfAnalysisLogs,
  saveSelfAnalysisLogs,
} from "@/app/career/self-analysis/selfAnalysisStorage";
import { loadMatchingLogs, saveMatchingLogs } from "@/app/career/matching/matchingStorage";
import { loadEsLogs, saveEsLogs } from "@/app/career/es/esStorage";
import {
  loadInterviewResults,
  saveInterviewResults,
} from "@/app/career/interview/interviewStorage";
import {
  loadPresentationResults,
  savePresentationResults,
} from "@/app/career/presentation/presentationStorage";
import {
  loadCompanyResearchLogs,
  saveCompanyResearchLogs,
} from "@/app/career/company-research/companyResearchStorage";
import {
  loadConsultationThreads,
  saveConsultationThreads,
} from "@/app/career/consultation/consultationStorage";

import { loadCareerProfileFromSupabase } from "@/lib/supabase/careerProfile";
import { loadCareerActivityFromSupabase } from "@/lib/supabase/careerActivity";
import { loadCareerValuesFromSupabase } from "@/lib/supabase/careerValues";
import { listCareerSelfAnalysisResultsFromSupabase } from "@/lib/supabase/careerSelfAnalysis";
import { listCareerMatchingResultsFromSupabase } from "@/lib/supabase/careerMatching";
import { listCareerEsLogsFromSupabase } from "@/lib/supabase/careerEs";
import { listCareerInterviewResultsFromSupabase } from "@/lib/supabase/careerInterview";
import { listCareerPresentationResultsFromSupabase } from "@/lib/supabase/careerPresentation";
import { listCareerCompanyResearchLogsFromSupabase } from "@/lib/supabase/careerCompanyResearch";
import { listCareerConsultationThreadsFromSupabase } from "@/lib/supabase/careerConsultation";

// 1 feature の restore を flag gate 付きで実行する。run() は never throw（best-effort）想定。
async function once(
  userId: string,
  feature: BackfillFeature,
  run: () => Promise<void>,
): Promise<void> {
  if (!userId || backfillDone(userId, feature)) return;
  try {
    await run();
  } catch {
    // run() 内は best-effort（never throw）想定だが二重に握りつぶす。
  }
  markBackfillDone(userId, feature);
}

// 履歴系の id マージ（local 優先）。remote が新規に持つ行だけ足す。
function mergeById<T extends { id: string }>(local: T[], remote: T[]): T[] {
  if (remote.length === 0) return local;
  const seen = new Set(local.map((x) => x.id));
  const merged = local.slice();
  for (const r of remote) {
    if (r && r.id && !seen.has(r.id)) {
      merged.push(r);
      seen.add(r.id);
    }
  }
  return merged;
}

// createdAt 降順（最新が先頭）。既存 append 系と同じ並びを保つ。
function sortByCreatedDesc<T extends { createdAt?: string }>(items: T[]): T[] {
  return items
    .slice()
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/**
 * 就活版の全機能を初回一括 restore する。AuthProvider の backfill と同じ場所で
 * fire-and-forget で呼ぶ（await しなくてよい）。backfill（上り）→ restore（下り）の順で呼ぶと、
 * 手元データを push した後に他端末由来の行だけを merge できる。
 */
export async function restoreCareerOnce({ userId }: { userId: string }): Promise<void> {
  if (!userId) return;

  await Promise.allSettled([
    // ── 単一レコード系: LS が空のときだけ remote で埋める（local を上書きしない） ──
    once(userId, "careerProfileRestore", async () => {
      if (loadBasicInfo()) return;
      const res = await loadCareerProfileFromSupabase(userId);
      if (res.kind === "ok") saveBasicInfo(res.profile);
    }),
    once(userId, "careerActivityRestore", async () => {
      if (loadActivityData()) return;
      const res = await loadCareerActivityFromSupabase(userId);
      if (res.kind === "ok") saveActivityData(res.activity);
    }),
    once(userId, "careerValuesRestore", async () => {
      const local = loadCareerValues();
      if (local && !isCareerValuesEmpty(local)) return;
      const res = await loadCareerValuesFromSupabase(userId);
      if (res.kind === "ok") saveCareerValues(res.values);
    }),

    // ── 履歴系: id で merge（local 優先） ──
    once(userId, "careerSelfAnalysisRestore", async () => {
      const remote = await listCareerSelfAnalysisResultsFromSupabase(userId);
      saveSelfAnalysisLogs(sortByCreatedDesc(mergeById(loadSelfAnalysisLogs(), remote)));
    }),
    once(userId, "careerMatchingRestore", async () => {
      const remote = await listCareerMatchingResultsFromSupabase(userId);
      saveMatchingLogs(sortByCreatedDesc(mergeById(loadMatchingLogs(), remote)));
    }),
    once(userId, "careerEsRestore", async () => {
      const remote = await listCareerEsLogsFromSupabase(userId);
      saveEsLogs(sortByCreatedDesc(mergeById(loadEsLogs(), remote)));
    }),
    once(userId, "careerInterviewResultsRestore", async () => {
      const remote = await listCareerInterviewResultsFromSupabase(userId);
      saveInterviewResults(sortByCreatedDesc(mergeById(loadInterviewResults(), remote)));
    }),
    once(userId, "careerPresentationResultsRestore", async () => {
      const remote = await listCareerPresentationResultsFromSupabase(userId);
      savePresentationResults(sortByCreatedDesc(mergeById(loadPresentationResults(), remote)));
    }),
    once(userId, "careerCompanyResearchRestore", async () => {
      const remote = await listCareerCompanyResearchLogsFromSupabase(userId);
      saveCompanyResearchLogs(sortByCreatedDesc(mergeById(loadCompanyResearchLogs(), remote)));
    }),
    once(userId, "careerConsultationRestore", async () => {
      const remote = await listCareerConsultationThreadsFromSupabase(userId);
      // saveConsultationThreads が updatedAt 降順 sort + 上限 trim を担う。
      saveConsultationThreads(mergeById(loadConsultationThreads(), remote));
    }),
  ]);
}

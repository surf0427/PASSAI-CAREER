"use client";

/**
 * STEP-CAREER-SUPABASE-01: 就活版（career）各機能の初回 LS→Supabase backfill オーケストレーション。
 *
 * 役割（lib/repository/*Repository.ts:backfill*Once と同思想）:
 *   - ログイン（member）確定後に 1 度だけ、localStorage（canonical）に貯まっている career データを
 *     Supabase の durable mirror（lib/supabase/career*.ts）へ一括 upsert する。
 *   - feature 単位で backfillFlag（key='supabaseBackfill'）に完了を記録し、二度手間を防ぐ。
 *   - upsert は冪等（natural key onConflict）かつ never throw。flag は最適化であり、
 *     消えても再実行は無害。
 *   - userId が空（guest）/ env 未設定なら各 upsert は no-op。
 *
 * 受験版データには一切触れない（career-prefixed の LS / career_* table のみ）。
 */

import { backfillDone, markBackfillDone, type BackfillFeature } from "./backfillFlag";

import { loadBasicInfo } from "@/app/career/profile/profileStorage";
import { loadActivityData } from "@/app/career/activity/activityStorage";
import {
  loadCareerValues,
  isCareerValuesEmpty,
} from "@/app/career/values/careerValuesStorage";
import {
  loadSelfAnalysisLogs,
  loadSelfPRs,
} from "@/app/career/self-analysis/selfAnalysisStorage";
import { loadMatchingLogs } from "@/app/career/matching/matchingStorage";
import { loadEsLogs } from "@/app/career/es/esStorage";
import {
  loadInterviewSessions,
  loadInterviewResults,
} from "@/app/career/interview/interviewStorage";
import {
  loadPresentationSessions,
  loadPresentationResults,
} from "@/app/career/presentation/presentationStorage";
import { loadConsultationThreads } from "@/app/career/consultation/consultationStorage";
import { loadCompanyResearchLogs } from "@/app/career/company-research/companyResearchStorage";

import { saveCareerProfileToSupabase } from "@/lib/supabase/careerProfile";
import { saveCareerActivityToSupabase } from "@/lib/supabase/careerActivity";
import { saveCareerValuesToSupabase } from "@/lib/supabase/careerValues";
import {
  upsertCareerSelfAnalysisResultsToSupabase,
  upsertCareerSelfPRsToSupabase,
} from "@/lib/supabase/careerSelfAnalysis";
import { upsertCareerMatchingResultsToSupabase } from "@/lib/supabase/careerMatching";
import { upsertCareerEsLogsToSupabase } from "@/lib/supabase/careerEs";
import {
  upsertCareerInterviewSessionsToSupabase,
  upsertCareerInterviewResultsToSupabase,
} from "@/lib/supabase/careerInterview";
import {
  upsertCareerPresentationSessionsToSupabase,
  upsertCareerPresentationResultsToSupabase,
} from "@/lib/supabase/careerPresentation";
import { upsertCareerConsultationThreadsToSupabase } from "@/lib/supabase/careerConsultation";
import { upsertCareerCompanyResearchLogsToSupabase } from "@/lib/supabase/careerCompanyResearch";

// 1 feature の backfill を flag gate 付きで実行する。run() は never throw（best-effort）。
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

/**
 * 就活版の全機能を初回一括 backfill する。AuthProvider の profileReady 後に
 * fire-and-forget で呼ぶ（await しなくてよい）。
 */
export async function backfillCareerOnce({ userId }: { userId: string }): Promise<void> {
  if (!userId) return;

  await Promise.allSettled([
    once(userId, "careerProfile", async () => {
      const profile = loadBasicInfo();
      if (profile) await saveCareerProfileToSupabase(userId, profile);
    }),
    once(userId, "careerActivity", async () => {
      const activity = loadActivityData();
      if (activity) await saveCareerActivityToSupabase(userId, activity);
    }),
    once(userId, "careerValues", async () => {
      const values = loadCareerValues();
      if (values && !isCareerValuesEmpty(values)) {
        await saveCareerValuesToSupabase(userId, values);
      }
    }),
    once(userId, "careerSelfAnalysis", async () => {
      await upsertCareerSelfAnalysisResultsToSupabase(userId, loadSelfAnalysisLogs());
    }),
    once(userId, "careerSelfPRs", async () => {
      await upsertCareerSelfPRsToSupabase(userId, loadSelfPRs());
    }),
    once(userId, "careerMatching", async () => {
      await upsertCareerMatchingResultsToSupabase(userId, loadMatchingLogs());
    }),
    once(userId, "careerEs", async () => {
      await upsertCareerEsLogsToSupabase(userId, loadEsLogs());
    }),
    once(userId, "careerInterviewSessions", async () => {
      await upsertCareerInterviewSessionsToSupabase(userId, loadInterviewSessions());
    }),
    once(userId, "careerInterviewResults", async () => {
      await upsertCareerInterviewResultsToSupabase(userId, loadInterviewResults());
    }),
    once(userId, "careerPresentationSessions", async () => {
      await upsertCareerPresentationSessionsToSupabase(userId, loadPresentationSessions());
    }),
    once(userId, "careerPresentationResults", async () => {
      await upsertCareerPresentationResultsToSupabase(userId, loadPresentationResults());
    }),
    once(userId, "careerConsultation", async () => {
      await upsertCareerConsultationThreadsToSupabase(userId, loadConsultationThreads());
    }),
    once(userId, "careerCompanyResearch", async () => {
      await upsertCareerCompanyResearchLogsToSupabase(userId, loadCompanyResearchLogs());
    }),
  ]);
}

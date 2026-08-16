"use client";

/**
 * career_company_applications — Application Context（user × company）の durable mirror。
 *
 *   - localStorage（app/career/company/applicationStorage.ts,
 *     key='careerCompanyApplications'）が canonical。本 table は member の durable mirror。
 *     natural key=(user_id, company_id)。
 *   - never throw（best-effort）。env 未設定 / 未ログイン時は no-op。
 *   - 企業の事実（Official）でも本人が得た企業情報（Private Evidence）でもない。
 *     応募文脈だけを持つ（既存 lib/supabase/career*.ts と同形）。
 */

import { devWarn } from "@/lib/devLog";
import { getCareerBrowserSupabaseClient } from "@/lib/careerSupabase/browserClient";
import type { CareerCompanyApplication } from "@/types/careerCompanyApplication";

const TABLE = "career_company_applications";

/** 1 件 upsert（best-effort / never throw）。 */
export async function mirrorCompanyApplication(
  userId: string | null | undefined,
  application: CareerCompanyApplication,
): Promise<void> {
  if (!userId || !application?.companyId) return;
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase.from(TABLE).upsert(
      {
        user_id: userId,
        company_id: application.companyId,
        interest_level: application.interestLevel ?? null,
        job_type: application.jobType ?? null,
        selection_type: application.selectionType ?? null,
        selection_phase: application.selectionPhase ?? null,
        selection_year: application.selectionYear ?? null,
        updated_at: application.updatedAt,
      },
      { onConflict: "user_id,company_id" },
    );
    if (error) devWarn("[careerCompanyApplication] upsert error", error);
  } catch (err) {
    devWarn("[careerCompanyApplication] upsert threw", err);
  }
}

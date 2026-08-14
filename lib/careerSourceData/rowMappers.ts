// PASSAI CAREER — Layer 1 Source Data の row → domain mapper（NEXT-2 / Data Spine）。
//
// 位置づけ:
//   career_* mirror table の row（jsonb 中心・snake_case）を、feature が扱う domain 型へ戻す
//   **純関数のみ**。browser / server どちらからも import できるよう、`'use client'` も
//   `import 'server-only'` も持たず、Supabase client / storage / env に一切依存しない。
//
// なぜ独立 module か（duplicate truth store の防止）:
//   これまで row → domain の変換は lib/supabase/career*.ts（'use client'）の list/load 関数に
//   inline されていた。Layer 1 の **server 側 reader**（serverReader.server.ts）は
//   `'use client'` module を import できないため、そのままでは同じ mapping を二重実装することになる。
//   → mapping を本 module へ切り出し、client mirror（下り restore）と server reader の
//     **両方が同じ 1 実装を共有**する。row 形状の drift は 1 箇所で直る。
//
// 厳守:
//   - 純関数 / deterministic / never-throw（不正 row は安全な既定へ落とす）。
//   - 既存 client mirror の変換結果と **同一**（挙動不変。parity は career-source-reader-qa が検証）。
//   - PII の除去はここでは行わない（Layer 1 は原本。PII 除去は Layer 2 projection の責務）。

import type { CareerProfile } from '@/types/careerProfile';
import type { CareerActivity } from '@/types/careerActivity';
import type {
  CareerValues,
  CareerValuesNotes,
  CareerValuesSelections,
} from '@/types/careerValues';
import type {
  CareerSelfAnalysisLog,
  CareerSelfAnalysisResult,
} from '@/types/careerSelfAnalysis';
import type {
  CareerEsLog,
  CareerEsResult,
  CareerEsSelectionType,
} from '@/types/careerEs';
import type {
  CareerInterviewFinalResult,
  CareerInterviewMode,
  CareerInterviewResult,
  CareerInterviewTurn,
  CareerInterviewType,
} from '@/types/careerInterview';
import type { CompanyResearchSnapshot } from '@/types/careerCompanyResearch';

// ── 共通 helper ────────────────────────────────────────────────────
function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ── career_profiles / career_activities（data jsonb に domain 全体を格納） ──
export type CareerJsonDataRow = {
  data: unknown;
  updated_at?: string | null;
};

/** career_profiles.data → CareerProfile（object でなければ null）。 */
export function rowToCareerProfile(row: CareerJsonDataRow | null | undefined): CareerProfile | null {
  if (!row || !isObject(row.data)) return null;
  return row.data as unknown as CareerProfile;
}

/** career_activities.data → CareerActivity（object でなければ null）。 */
export function rowToCareerActivity(
  row: CareerJsonDataRow | null | undefined,
): CareerActivity | null {
  if (!row || !isObject(row.data)) return null;
  return row.data as unknown as CareerActivity;
}

// ── career_values（8 カテゴリを flat column で保持） ────────────────
export type CareerValuesRow = {
  priorities: unknown;
  avoidances: unknown;
  industries: unknown;
  job_types: unknown;
  work_styles: unknown;
  company_types: unknown;
  career_goals: unknown;
  culture_preferences: unknown;
  notes: unknown;
  overall_note: string | null;
  updated_at: string | null;
};

// ★ 単一 string literal（`+` 連結にしない）。Supabase client は select 文字列の **literal 型**から
//   戻り値型を推論するため、連結すると型が `string` に落ちて row 型推論が壊れる。
export const CAREER_VALUES_SELECT_COLUMNS =
  'user_id, priorities, avoidances, industries, job_types, work_styles, company_types, career_goals, culture_preferences, notes, overall_note, updated_at' as const;

export function rowToCareerValuesSelections(row: CareerValuesRow): CareerValuesSelections {
  return {
    priorities: strArray(row.priorities),
    avoidances: strArray(row.avoidances),
    industries: strArray(row.industries),
    jobTypes: strArray(row.job_types),
    workStyles: strArray(row.work_styles),
    companyTypes: strArray(row.company_types),
    careerGoals: strArray(row.career_goals),
    culturePreferences: strArray(row.culture_preferences),
  };
}

export function rowToCareerValuesNotes(row: CareerValuesRow): CareerValuesNotes {
  const raw = isObject(row.notes) ? row.notes : {};
  const pick = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  return {
    priorities: pick('priorities'),
    avoidances: pick('avoidances'),
    industries: pick('industries'),
    jobTypes: pick('jobTypes'),
    workStyles: pick('workStyles'),
    companyTypes: pick('companyTypes'),
    careerGoals: pick('careerGoals'),
    culturePreferences: pick('culturePreferences'),
  };
}

/** career_values row → CareerValues。 */
export function rowToCareerValues(row: CareerValuesRow): CareerValues {
  return {
    selections: rowToCareerValuesSelections(row),
    notes: rowToCareerValuesNotes(row),
    overallNote: typeof row.overall_note === 'string' ? row.overall_note : '',
    updatedAt: row.updated_at ?? undefined,
  };
}

// ── career_self_analysis_results ───────────────────────────────────
export type CareerSelfAnalysisResultRow = {
  client_id: string;
  user_input: unknown;
  result: unknown;
  created_at: string;
};

export const CAREER_SELF_ANALYSIS_SELECT_COLUMNS =
  'client_id, user_input, result, created_at' as const;

export function rowToCareerSelfAnalysisLog(
  row: CareerSelfAnalysisResultRow,
): CareerSelfAnalysisLog {
  return {
    id: row.client_id,
    createdAt: row.created_at,
    userInput: typeof row.user_input === 'string' ? row.user_input : '',
    result: (row.result ?? {}) as CareerSelfAnalysisResult,
  };
}

// ── career_es_logs（昇格列 + meta jsonb） ──────────────────────────
export type CareerEsLogRow = {
  client_id: string;
  user_input: unknown;
  result: unknown;
  edited_result: unknown | null;
  favorite: boolean;
  submitted: boolean;
  meta: unknown;
  created_at: string;
};

export const CAREER_ES_SELECT_COLUMNS =
  'client_id, user_input, result, edited_result, favorite, submitted, meta, created_at' as const;

export function rowToCareerEsLog(row: CareerEsLogRow): CareerEsLog {
  const meta = (isObject(row.meta) ? row.meta : {}) as Record<string, unknown>;
  const log: CareerEsLog = {
    id: row.client_id,
    createdAt: row.created_at,
    userInput: typeof row.user_input === 'string' ? row.user_input : '',
    result: (row.result ?? {}) as CareerEsResult,
    favorite: row.favorite,
    submitted: row.submitted,
  };
  if (row.edited_result) log.editedResult = row.edited_result as CareerEsResult;
  if (typeof meta.companyName === 'string') log.companyName = meta.companyName;
  if (typeof meta.question === 'string') log.question = meta.question;
  if (typeof meta.charLimit === 'number') log.charLimit = meta.charLimit;
  if (typeof meta.selectionType === 'string')
    log.selectionType = meta.selectionType as CareerEsSelectionType;
  if (typeof meta.industry === 'string') log.industry = meta.industry;
  if (typeof meta.jobType === 'string') log.jobType = meta.jobType;
  if (typeof meta.sourceLogId === 'string') log.sourceLogId = meta.sourceLogId;
  if (meta.sourceType === 'generated' || meta.sourceType === 'review_rewrite')
    log.sourceType = meta.sourceType;
  if (typeof meta.companyResearchLogId === 'string')
    log.companyResearchLogId = meta.companyResearchLogId;
  if (isObject(meta.companyResearchSnapshot))
    log.companyResearchSnapshot =
      meta.companyResearchSnapshot as CareerEsLog['companyResearchSnapshot'];
  return log;
}

// ── career_interview_results ───────────────────────────────────────
export type CareerInterviewResultRow = {
  client_id: string;
  mode: string;
  interview_type: string;
  turns: unknown;
  result: unknown;
  company_research_log_id: string | null;
  company_research_snapshot: unknown;
  created_at: string;
};

export const CAREER_INTERVIEW_RESULT_SELECT_COLUMNS =
  'client_id, mode, interview_type, turns, result, company_research_log_id, company_research_snapshot, created_at' as const;

function interviewTurnsOf(value: unknown): CareerInterviewTurn[] {
  return Array.isArray(value) ? (value as CareerInterviewTurn[]) : [];
}

function companyResearchSnapshotOf(value: unknown): CompanyResearchSnapshot | undefined {
  return isObject(value) ? (value as unknown as CompanyResearchSnapshot) : undefined;
}

export function rowToCareerInterviewResult(
  row: CareerInterviewResultRow,
): CareerInterviewResult {
  const result: CareerInterviewResult = {
    id: row.client_id,
    createdAt: row.created_at,
    mode: row.mode as CareerInterviewMode,
    interviewType: row.interview_type as CareerInterviewType,
    turns: interviewTurnsOf(row.turns),
    result: (row.result ?? {}) as CareerInterviewFinalResult,
  };
  if (typeof row.company_research_log_id === 'string') {
    result.companyResearchLogId = row.company_research_log_id;
  }
  const snap = companyResearchSnapshotOf(row.company_research_snapshot);
  if (snap) result.companyResearchSnapshot = snap;
  return result;
}

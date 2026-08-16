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
import type {
  CompanyResearchSnapshot,
  CareerCompanyResearchLog,
} from '@/types/careerCompanyResearch';
import type { CareerMatchingLog } from '@/types/careerMatching';
import type { CareerMatchEngineResult } from '@/lib/careerMatching';
import type { CareerGdRoomLog } from '@/types/careerGd';
// ★ normalizeGdRoomLog は GD 履歴の正本 normalizer。server 側でも **同じ関数**を使い、
//   client hydrate 経路（lib/supabase/careerGdRoomResults.ts）と表現を一致させる。
import { normalizeGdRoomLog } from '@/app/career/gd/gdRoomLogStorage';
import type { CareerPresentationResult } from '@/types/careerPresentation';
import type { CareerConsultationThread } from '@/types/careerConsultation';

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
  // Company Data Spine の canonical key（Phase A / R4）。旧 meta では欠損。
  if (typeof meta.companyId === 'string' && meta.companyId !== '')
    log.companyId = meta.companyId;
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

// ══════════════════════════════════════════════════════════════════
// Batch 2 — cross-feature source kinds（matching / company_research / presentation / consultation）
// ══════════════════════════════════════════════════════════════════

// ── career_matching_results ────────────────────────────────────────
export type CareerMatchingResultRow = {
  client_id: string;
  user_input: unknown;
  result: unknown;
  created_at: string;
};

export const CAREER_MATCHING_SELECT_COLUMNS =
  'client_id, user_input, result, created_at' as const;

export function rowToCareerMatchingLog(row: CareerMatchingResultRow): CareerMatchingLog {
  return {
    id: row.client_id,
    createdAt: row.created_at,
    userInput: typeof row.user_input === 'string' ? row.user_input : '',
    result: (row.result ?? {}) as CareerMatchEngineResult,
  };
}

// ── career_company_research_logs ───────────────────────────────────
export type CareerCompanyResearchRow = {
  client_id: string;
  company_name: string | null;
  industry: string | null;
  interest_level: unknown;
  input: unknown;
  review: unknown;
  fit_analysis: unknown;
  interview_context_summary: unknown;
  revision_history: unknown;
  favorite: boolean;
  created_at: string;
  updated_at: string | null;
};

export const CAREER_COMPANY_RESEARCH_SELECT_COLUMNS =
  'client_id, company_name, industry, interest_level, input, review, fit_analysis, interview_context_summary, revision_history, favorite, created_at, updated_at' as const;

function companyInterestLevel(v: unknown): CareerCompanyResearchLog['interestLevel'] {
  return v === 'high' || v === 'mid' || v === 'low' || v === 'watch'
    ? (v as CareerCompanyResearchLog['interestLevel'])
    : null;
}

export function rowToCareerCompanyResearchLog(
  row: CareerCompanyResearchRow,
): CareerCompanyResearchLog {
  return {
    id: row.client_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    companyName: row.company_name ?? '',
    industry: row.industry ?? '',
    interestLevel: companyInterestLevel(row.interest_level),
    input: (row.input ?? {}) as CareerCompanyResearchLog['input'],
    review: (row.review ?? {}) as CareerCompanyResearchLog['review'],
    fitAnalysis: (row.fit_analysis ?? {}) as CareerCompanyResearchLog['fitAnalysis'],
    interviewContextSummary:
      typeof row.interview_context_summary === 'string' ? row.interview_context_summary : '',
    revisionHistory: Array.isArray(row.revision_history)
      ? (row.revision_history as CareerCompanyResearchLog['revisionHistory'])
      : [],
    favorite: row.favorite,
  };
}

// ── career_presentation_results ────────────────────────────────────
export type CareerPresentationResultRow = {
  client_id: string;
  presentation_type: string;
  mode: string;
  theme: string;
  time_limit_sec: number | null;
  duration_sec: number | null;
  transcript: string | null;
  result: unknown;
  qa: unknown;
  created_at: string;
};

export const CAREER_PRESENTATION_SELECT_COLUMNS =
  'client_id, presentation_type, mode, theme, time_limit_sec, duration_sec, transcript, result, qa, created_at' as const;

export function rowToCareerPresentationResult(
  row: CareerPresentationResultRow,
): CareerPresentationResult {
  const out = {
    id: row.client_id,
    createdAt: row.created_at,
    presentationType: row.presentation_type,
    mode: row.mode,
    theme: row.theme,
    timeLimitSec: row.time_limit_sec ?? 0,
    durationSec: row.duration_sec ?? 0,
    transcript: row.transcript ?? '',
    result: (row.result ?? {}) as CareerPresentationResult['result'],
  } as CareerPresentationResult;
  if (Array.isArray(row.qa)) out.qa = row.qa as CareerPresentationResult['qa'];
  return out;
}

// ── career_consultation_threads ────────────────────────────────────
export type CareerConsultationThreadRow = {
  client_id: string;
  title: string | null;
  messages: unknown;
  created_at: string;
  updated_at: string | null;
};

export const CAREER_CONSULTATION_SELECT_COLUMNS =
  'client_id, title, messages, created_at, updated_at' as const;

export function rowToCareerConsultationThread(
  row: CareerConsultationThreadRow,
): CareerConsultationThread {
  return {
    id: row.client_id,
    title: row.title ?? '',
    messages: Array.isArray(row.messages)
      ? (row.messages as CareerConsultationThread['messages'])
      : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  } as CareerConsultationThread;
}

// ── Closure Batch: gd_room（**server-authoritative** / authority class 2）─────────
//
// career_gd_room_results は app/api/career/gd/room/[roomId]/result/route.ts が
// `(room_id, user_id)` で upsert する **server 著作**データ。client の localStorage
// （`careerGdRoomLogs`）は表示用 cache であり canonical ではない。
//
// ★ owner-scoped RLS（`auth.uid() = user_id`）で **自分の行だけ**が返る。
//   row には他参加者の raw answer は含まれない（self_feedback / ranking / matching_hints /
//   overall_summary はいずれも server が算出した自分向け projection）。
//   theme / format / 所要時間は本 table に無いため既定値になる
//   （client hydrate 経路 lib/supabase/careerGdRoomResults.ts と同じ割り切り）。
export const CAREER_GD_ROOM_SELECT_COLUMNS =
  'room_id, participant_id, self_feedback, ranking, matching_hints, overall_summary, created_at' as const;

export type CareerGdRoomResultRow = {
  room_id?: unknown;
  participant_id?: unknown;
  self_feedback?: unknown;
  ranking?: unknown;
  matching_hints?: unknown;
  overall_summary?: unknown;
  created_at?: unknown;
};

export function rowToCareerGdRoomLog(row: CareerGdRoomResultRow): CareerGdRoomLog | null {
  const rankingLen = Array.isArray(row.ranking) ? row.ranking.length : 0;
  return normalizeGdRoomLog({
    id: row.room_id,
    roomId: row.room_id,
    participantId: row.participant_id,
    createdAt: row.created_at,
    theme: {},
    format: 'free',
    participantCount: rankingLen,
    humanCount: rankingLen,
    durationSec: 0,
    evaluation: row.self_feedback,
    ranking: row.ranking,
    matchingHints: row.matching_hints,
    consultationSummary: row.overall_summary,
  });
}

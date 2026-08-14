// PASSAI CAREER — Layer 1 Source Data server read の型・定数（NEXT-2 / Data Spine）。
//
// 純粋な型・定数のみ（I/O / env / Supabase 非依存）。server reader と QA が共有する。

import type { CareerProfile } from '@/types/careerProfile';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerEsLog } from '@/types/careerEs';
import type { CareerInterviewResult } from '@/types/careerInterview';

// server 側で読める Layer 1 Source の種別（＝Personal Memory section の由来 Source）。
export type CareerSourceKind =
  | 'profile'
  | 'activity'
  | 'values'
  | 'self_analysis'
  | 'es'
  | 'interview';

export const CAREER_SOURCE_KINDS = [
  'profile',
  'activity',
  'values',
  'self_analysis',
  'es',
  'interview',
] as const satisfies readonly CareerSourceKind[];

// table 名（DDL・client mirror と一致させる）。
export const CAREER_SOURCE_TABLES: Readonly<Record<CareerSourceKind, string>> = {
  profile: 'career_profiles',
  activity: 'career_activities',
  values: 'career_values',
  self_analysis: 'career_self_analysis_results',
  es: 'career_es_logs',
  interview: 'career_interview_results',
};

// 履歴系 Source の 1 request あたり read 上限。
//   ★ 上限に達した Source は `truncated` として扱い、その Source から導いた revision を
//     **freshness の権威にしない**（sourceCount が実体と一致しない可能性があるため）。
//     「読めた範囲で fresh と断定する」ことはしない（fail-open で Memory 不使用へ倒す）。
export const CAREER_SOURCE_LOG_MAX_ROWS = 200;

// 1 request の Source read 全体のソフト上限（超過は打ち切って error 扱い＝fail-open）。
export const CAREER_SOURCE_READ_SOFT_TIMEOUT_MS = 1500;

// 読み出した Layer 1 Source（domain 型のまま。PII 除去は Layer 2 projection の責務）。
export type CareerSourceBundle = {
  profile: CareerProfile | null;
  activity: CareerActivity | null;
  values: CareerValues | null;
  selfAnalysisLogs: CareerSelfAnalysisLog[];
  esLogs: CareerEsLog[];
  interviewResults: CareerInterviewResult[];
};

export const EMPTY_CAREER_SOURCE_BUNDLE: CareerSourceBundle = {
  profile: null,
  activity: null,
  values: null,
  selfAnalysisLogs: [],
  esLogs: [],
  interviewResults: [],
};

// 1 Source の read 結果状態。
//   ok        : 読めた（行が無い場合も ok。空 = 「Source が空」という確定情報）。
//   truncated : 上限まで読めたが全件ではない可能性がある（revision を権威にしない）。
//   error     : table missing / network / RLS 拒否等。revision を権威にしない。
//   skipped   : 要求されなかった。
export type CareerSourceReadStatus = 'ok' | 'truncated' | 'error' | 'skipped';

// 観測用の安全 metadata のみ（本文 / UUID / env / raw error を含めない）。
export type CareerSourceReadMeta = {
  // 認証・env・gate の総合結果。
  outcome: 'skipped' | 'unauthenticated' | 'ok' | 'error';
  // Source 別の read 状態。
  statuses: Readonly<Record<CareerSourceKind, CareerSourceReadStatus>>;
  // 全体の所要時間（観測用。DI 可能な now から算出）。
  durationMs: number | null;
};

export type CareerSourceReadOutcome = {
  bundle: CareerSourceBundle;
  meta: CareerSourceReadMeta;
};

/** 「その Source から導いた revision を freshness の権威にしてよいか」。ok のみ true。 */
export function isSourceRevisionAuthoritative(status: CareerSourceReadStatus): boolean {
  return status === 'ok';
}

export function emptySourceStatuses(): Record<CareerSourceKind, CareerSourceReadStatus> {
  return {
    profile: 'skipped',
    activity: 'skipped',
    values: 'skipped',
    self_analysis: 'skipped',
    es: 'skipped',
    interview: 'skipped',
  };
}

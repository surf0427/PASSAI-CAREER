// STEP-SUPABASE-COMPLETE-03A: backfill flag（初回一括 LS→Supabase 同期の二度手間防止）。
//
// 役割:
//   「この userId / feature の初回 backfill は完了済みか」を localStorage に記録する。
//   backfill 本体（lib/repository/tutorRepository.ts:backfillTutorOnce）が起動時に
//   1 度だけ走るための gate として使う。
//
// 設計方針:
//   - flag は correctness ではなく **最適化**。flag が消えても backfill 本体は
//     冪等 upsert（natural key + ignoreDuplicates）なので再実行は無害。
//   - userId 単位で記録する。匿名 → メール昇格では user_id が不変
//     （lib/supabase/email.ts）なので再実行されない。別 user_id なら新規実行。
//   - safeStorage 経由で SSR / 例外時の落下を防ぐ。
//   - version を持ち、将来 backfill ロジックを更新したいときに世代を上げて
//     再 backfill を強制できる余地を残す。
//
// 保存形式:
//   localStorage key: 'supabaseBackfill'
//   value: { [userId]: { [feature]: { version: number; at: string } } }

import {
  safeGetStorage,
  safeSetStorage,
} from '@/lib/storage/safeStorage';

const BACKFILL_FLAG_KEY = 'supabaseBackfill';

// backfill 対象 feature。以降の feature 追加時にこの union を拡張する。
//   - 'tutor'                   … STEP-SUPABASE-COMPLETE-03A（上り backfill）
//   - 'selfAnalysisLogs'        … STEP-SUPABASE-COMPLETE-04B（上り backfill）
//   - 'selfAnalysisLogsRestore' … STEP-SUPABASE-COMPLETE-04E-1（下り one-way restore）
//   - 'selfPRs'                 … STEP-SUPABASE-COMPLETE-05B（上り backfill）
//   - 'statementReviewHistory'  … STEP-SUPABASE-COMPLETE-06C（上り backfill）
//
// 注: 'selfAnalysisLogs'（上り）と 'selfAnalysisLogsRestore'（下り）は別 feature key。
// 同じ feature 名前空間に「方向」を分けて記録することで、上り backfill 済みでも
// 下り restore を独立に 1 回実行できる。
// 'selfPRs' / 'statementReviewHistory' は上り backfill のみ（restore は delete
// resurrection 回避のため別 STEP）。
export type BackfillFeature =
  | 'tutor'
  | 'selfAnalysisLogs'
  | 'selfAnalysisLogsRestore'
  | 'selfPRs'
  | 'statementReviewHistory'
  // STEP-TUTOR-CONTEXT-PHASE2-REPOSITORY-01: snapshot 型 durable（basic_info /
  // diagnosis / activity）。各 feature は上り backfill と下り restore を別 key で
  // 独立に 1 回実行する（selfAnalysisLogs / selfAnalysisLogsRestore と同方式）。
  | 'basicInfoLog'
  | 'basicInfoLogRestore'
  | 'diagnosisLog'
  | 'diagnosisLogRestore'
  | 'activityLog'
  | 'activityLogRestore'
  // 小論文 essay workspace の上り backfill（restore は別 STEP）。
  | 'essayWorkspaces'
  // 面接練習記録（interview_records）の上り backfill。restore / delete 伝播は別 STEP
  // （delete resurrection 回避。STEP-INTERVIEW-AI-PR1/PR2）。
  | 'interviewPracticeRecords'
  // STEP-CAREER-SUPABASE-01: 就活版（career）各機能の上り backfill（LS→Supabase 初回一括同期）。
  // いずれも localStorage canonical の durable mirror。
  | 'careerProfile'
  | 'careerActivity'
  | 'careerSelfAnalysis'
  | 'careerSelfPRs'
  | 'careerMatching'
  | 'careerEs'
  | 'careerInterviewSessions'
  | 'careerInterviewResults'
  | 'careerPresentationSessions'
  | 'careerPresentationResults'
  | 'careerConsultation'
  // STEP-CAREER-SUPABASE-02: 上り backfill に後から加えた 2 機能（既存 mirror は wired 済みだが
  // 一括 backfill orchestration から漏れていた）。values は 1 ユーザー 1 行、company-research は履歴系。
  | 'careerValues'
  | 'careerCompanyResearch'
  // STEP-CAREER-SUPABASE-02: 下り restore（Supabase→LS の 1 回限りマージ）。マイページが
  // 別端末ログイン時にも durable mirror 由来のログを復元できるようにするための feature key。
  // 上り backfill（'careerX'）とは別 key で「方向」を分けて独立に 1 回実行する
  // （selfAnalysisLogs / selfAnalysisLogsRestore と同方式）。merge-only（local 優先）・never throw。
  | 'careerProfileRestore'
  | 'careerActivityRestore'
  | 'careerValuesRestore'
  | 'careerSelfAnalysisRestore'
  | 'careerMatchingRestore'
  | 'careerEsRestore'
  | 'careerInterviewResultsRestore'
  | 'careerPresentationResultsRestore'
  | 'careerCompanyResearchRestore'
  | 'careerConsultationRestore';

// backfill ロジックの世代。ロジックを変えて再 backfill させたいときに +1 する。
export const BACKFILL_VERSION = 1;

type BackfillEntry = {
  version: number;
  at: string; // ISO
};

// userId → feature → entry。欠損は「未 backfill」として扱う。
type BackfillRecord = Partial<
  Record<string, Partial<Record<BackfillFeature, BackfillEntry>>>
>;

function loadRecord(): BackfillRecord {
  return safeGetStorage<BackfillRecord>(BACKFILL_FLAG_KEY, {});
}

/**
 * 指定 userId / feature の backfill が現行 version で完了済みかを返す。
 * - userId が空文字 / 未記録 → false。
 * - 記録があっても version が古い → false（再 backfill 対象）。
 */
export function backfillDone(
  userId: string,
  feature: BackfillFeature,
): boolean {
  if (!userId) return false;
  const entry = loadRecord()[userId]?.[feature];
  if (!entry) return false;
  return entry.version >= BACKFILL_VERSION;
}

/**
 * 指定 userId / feature の backfill 完了を記録する。
 * - userId が空文字なら no-op。
 * - 他 userId / 他 feature の記録は保持したままマージ更新する。
 */
export function markBackfillDone(
  userId: string,
  feature: BackfillFeature,
): void {
  if (!userId) return;
  const record = loadRecord();
  const forUser = record[userId] ?? {};
  forUser[feature] = {
    version: BACKFILL_VERSION,
    at: new Date().toISOString(),
  };
  record[userId] = forUser;
  safeSetStorage(BACKFILL_FLAG_KEY, record);
}

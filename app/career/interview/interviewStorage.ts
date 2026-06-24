import type {
  CareerInterviewSession,
  CareerInterviewResult,
} from '@/types/careerInterview';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';

// 就活版（career）面接AIの localStorage 保存層。
// 受験版（interview_ai_sessions / interview_ai_results テーブル・DB）とは完全に分離する。
//   - セッション（会話状態）: 'careerInterviewSessions'
//   - 最終結果（評価ログ）  : 'careerInterviewResults'
// DB / Supabase / usage には一切接続しない（localStorage のみ）。
const SESSIONS_KEY = 'careerInterviewSessions';
const RESULTS_KEY = 'careerInterviewResults';

// ── セッション ────────────────────────────────────────────────────

export function loadInterviewSessions(): CareerInterviewSession[] {
  return safeGetStorage<CareerInterviewSession[]>(SESSIONS_KEY, []);
}

export function saveInterviewSessions(sessions: CareerInterviewSession[]): void {
  safeSetStorage(SESSIONS_KEY, sessions);
}

// id があれば置換、無ければ先頭に追加して保存する（最新が先頭）。
export function upsertInterviewSession(session: CareerInterviewSession): void {
  const sessions = loadInterviewSessions();
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    sessions[idx] = session;
    saveInterviewSessions(sessions);
  } else {
    saveInterviewSessions([session, ...sessions]);
  }
}

export function getInterviewSession(id: string): CareerInterviewSession | null {
  return loadInterviewSessions().find((s) => s.id === id) ?? null;
}

// 進行中（in_progress）のセッションを 1 件返す（無ければ null）。再開導線に使う。
export function getInProgressInterviewSession(): CareerInterviewSession | null {
  return loadInterviewSessions().find((s) => s.status === 'in_progress') ?? null;
}

// ── 最終結果 ──────────────────────────────────────────────────────

export function loadInterviewResults(): CareerInterviewResult[] {
  return safeGetStorage<CareerInterviewResult[]>(RESULTS_KEY, []);
}

export function saveInterviewResults(results: CareerInterviewResult[]): void {
  safeSetStorage(RESULTS_KEY, results);
}

// 1 件を先頭に追記して保存する（最新が先頭）。
export function appendInterviewResult(result: CareerInterviewResult): void {
  saveInterviewResults([result, ...loadInterviewResults()]);
}

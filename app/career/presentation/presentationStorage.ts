import type {
  CareerPresentationSession,
  CareerPresentationResult,
  CareerPresentationTarget,
} from '@/types/careerPresentation';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';
import { normalizePresentationTarget } from './presentationModes';
// 所有者名前空間（account switch 隔離）。guest は従来キーのまま、member は所有者 suffix 付き。
// ★ 定数ではなく **呼び出しのたびに** 解決する（module 読み込み時に固定すると、
//   後からログイン/ログアウトしても古い名前空間を掴み続けるため）。
import { careerStorageKey } from '@/lib/careerStorage/owner';

// 就活版（career）プレゼン対策AIの localStorage 保存層。
// 受験版（presentation_sessions / Supabase Storage・DB）とは完全に分離する。
//   - セッション（進行状態）: 'careerPresentationSessions'
//   - 最終結果（評価ログ）  : 'careerPresentationResults'
// DB / Supabase / usage / 課金には一切接続しない（localStorage のみ）。
function SESSIONS_KEY(): string {
  return careerStorageKey('careerPresentationSessions');
}
function RESULTS_KEY(): string {
  return careerStorageKey('careerPresentationResults');
}
// お題生成の前段（/target）で入力する選考文脈の下書き。setup が読む。canonical ではない。
function TARGET_DRAFT_KEY(): string {
  return careerStorageKey('careerPresentationTargetDraft');
}

// ── target 下書き（お題生成の前段の選考文脈）─────────────────────────

export function loadPresentationTargetDraft(): CareerPresentationTarget | null {
  return normalizePresentationTarget(safeGetStorage<unknown>(TARGET_DRAFT_KEY(), null));
}

export function savePresentationTargetDraft(target: CareerPresentationTarget): void {
  safeSetStorage(TARGET_DRAFT_KEY(), target);
}

export function clearPresentationTargetDraft(): void {
  safeSetStorage(TARGET_DRAFT_KEY(), null);
}

// ── セッション ────────────────────────────────────────────────────

export function loadPresentationSessions(): CareerPresentationSession[] {
  return safeGetStorage<CareerPresentationSession[]>(SESSIONS_KEY(), []);
}

export function savePresentationSessions(sessions: CareerPresentationSession[]): void {
  safeSetStorage(SESSIONS_KEY(), sessions);
}

// id があれば置換、無ければ先頭に追加して保存する（最新が先頭）。
export function upsertPresentationSession(session: CareerPresentationSession): void {
  const sessions = loadPresentationSessions();
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    sessions[idx] = session;
    savePresentationSessions(sessions);
  } else {
    savePresentationSessions([session, ...sessions]);
  }
}

export function getPresentationSession(id: string): CareerPresentationSession | null {
  return loadPresentationSessions().find((s) => s.id === id) ?? null;
}

// 進行中（in_progress）のセッションを 1 件返す（無ければ null）。再開導線に使う。
export function getInProgressPresentationSession(): CareerPresentationSession | null {
  return loadPresentationSessions().find((s) => s.status === 'in_progress') ?? null;
}

// ── 最終結果 ──────────────────────────────────────────────────────

export function loadPresentationResults(): CareerPresentationResult[] {
  return safeGetStorage<CareerPresentationResult[]>(RESULTS_KEY(), []);
}

export function savePresentationResults(results: CareerPresentationResult[]): void {
  safeSetStorage(RESULTS_KEY(), results);
}

// 1 件を先頭に追記して保存する（最新が先頭）。
export function appendPresentationResult(result: CareerPresentationResult): void {
  savePresentationResults([result, ...loadPresentationResults()]);
}

// id を指定して結果を置換保存する（Q&A 追記などに使う）。無ければ何もしない。
export function updatePresentationResult(result: CareerPresentationResult): void {
  const results = loadPresentationResults();
  const idx = results.findIndex((r) => r.id === result.id);
  if (idx >= 0) {
    results[idx] = result;
    savePresentationResults(results);
  }
}

import type { PersistedAnalyzeState } from '@/types/analysis';
import type { SelfPR } from '@/types/selfPR';
import type { SelfAnalysisLog } from '@/types/selfAnalysisLog';
import { safeGetStorage, safeSetStorage, safeRemoveStorage } from '@/lib/storage/safeStorage';

// 就活版（career）自己分析の localStorage 保存層。
// 受験版 lib/analyzeStorage.ts / lib/selfPRStorage.ts / lib/selfAnalysisLogStorage.ts を
// そのまま踏襲しつつ、保存キーのみ career 専用に分離する。
//   - 受験版キー: 'analyzeState' / 'selfPRs' / 'selfAnalysisLogs'
//   - 就活版キー: 'careerAnalyzeState' / 'careerSelfPRs' / 'careerSelfAnalysisLogs'
// これにより受験版と就活版のデータが相互に混入しない（独立した土台）。
//
// 本フェーズではハブ画面の「現在地」表示（読み取り）のみが対象。AI壁打ち（run/resume）は
// 受験版 API（/api/summarize 等）に強く依存するため準備中で、これらのキーへ実データを
// 書き込む経路はまだ存在しない（fresh user では常に空 = 現在地はすべて空表示）。
const ANALYZE_KEY = 'careerAnalyzeState';
const SELF_PR_KEY = 'careerSelfPRs';
const SELF_ANALYSIS_LOG_KEY = 'careerSelfAnalysisLogs';

export function saveAnalyzeState(state: PersistedAnalyzeState): void {
  safeSetStorage(ANALYZE_KEY, state);
}
export function loadAnalyzeState(): PersistedAnalyzeState | null {
  return safeGetStorage<PersistedAnalyzeState | null>(ANALYZE_KEY, null);
}
export function clearAnalyzeState(): void {
  safeRemoveStorage(ANALYZE_KEY);
}

export function loadSelfPRs(): SelfPR[] {
  return safeGetStorage<SelfPR[]>(SELF_PR_KEY, []);
}
export function saveSelfPRs(entries: SelfPR[]): void {
  safeSetStorage(SELF_PR_KEY, entries);
}

export function loadSelfAnalysisLogs(): SelfAnalysisLog[] {
  return safeGetStorage<SelfAnalysisLog[]>(SELF_ANALYSIS_LOG_KEY, []);
}
export function saveSelfAnalysisLogs(logs: SelfAnalysisLog[]): void {
  safeSetStorage(SELF_ANALYSIS_LOG_KEY, logs);
}

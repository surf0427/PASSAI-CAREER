import type { CareerMatchingLog } from '@/types/careerMatching';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';

// 就活版（career）企業マッチングAIの結果ログ localStorage 保存層。
// 受験版・他機能とは別キーで完全分離する。DB / Supabase / usage には接続しない。
const MATCHING_LOG_KEY = 'careerMatchingResults';

export function loadMatchingLogs(): CareerMatchingLog[] {
  return safeGetStorage<CareerMatchingLog[]>(MATCHING_LOG_KEY, []);
}

export function saveMatchingLogs(logs: CareerMatchingLog[]): void {
  safeSetStorage(MATCHING_LOG_KEY, logs);
}

// 1 件を先頭に追記して保存する（最新が先頭）。
export function appendMatchingLog(log: CareerMatchingLog): void {
  saveMatchingLogs([log, ...loadMatchingLogs()]);
}

import type { CareerMatchingLog } from '@/types/careerMatching';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';
// 所有者名前空間（account switch 隔離）。guest は従来キーのまま、member は所有者 suffix 付き。
// ★ 定数ではなく **呼び出しのたびに** 解決する（module 読み込み時に固定すると、
//   後からログイン/ログアウトしても古い名前空間を掴み続けるため）。
import { careerStorageKey } from '@/lib/careerStorage/owner';

// 就活版（career）企業マッチングAIの結果ログ localStorage 保存層。
// 受験版・他機能とは別キーで完全分離する。DB / Supabase / usage には接続しない。
function MATCHING_LOG_KEY(): string {
  return careerStorageKey('careerMatchingResults');
}

export function loadMatchingLogs(): CareerMatchingLog[] {
  return safeGetStorage<CareerMatchingLog[]>(MATCHING_LOG_KEY(), []);
}

export function saveMatchingLogs(logs: CareerMatchingLog[]): void {
  safeSetStorage(MATCHING_LOG_KEY(), logs);
}

// 1 件を先頭に追記して保存する（最新が先頭）。
export function appendMatchingLog(log: CareerMatchingLog): void {
  saveMatchingLogs([log, ...loadMatchingLogs()]);
}

import type { CareerEsLog } from '@/types/careerEs';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';

// 就活版（career）ES作成AIの結果ログ localStorage 保存層。
// 受験版（志望理由書 statement 系）の保存キーとは完全に分離する。
//   - 受験版とは別レーンの就活版専用キー: 'careerEsLogs'
// これにより受験版と就活版のデータが相互に混入しない。
const ES_LOG_KEY = 'careerEsLogs';

export function loadEsLogs(): CareerEsLog[] {
  return safeGetStorage<CareerEsLog[]>(ES_LOG_KEY, []);
}

export function saveEsLogs(logs: CareerEsLog[]): void {
  safeSetStorage(ES_LOG_KEY, logs);
}

// 1 件を先頭に追記して保存する（最新が先頭）。run 画面から利用する。
export function appendEsLog(log: CareerEsLog): void {
  saveEsLogs([log, ...loadEsLogs()]);
}

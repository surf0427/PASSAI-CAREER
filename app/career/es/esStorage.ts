import type { CareerEsLog } from '@/types/careerEs';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';

// 就活版（career）ES作成AIの結果ログ localStorage 保存層。
// 受験版（志望理由書 statement 系）の保存キーとは完全に分離する。
//   - 受験版とは別レーンの就活版専用キー: 'careerEsLogs'
// これにより受験版と就活版のデータが相互に混入しない。
const ES_LOG_KEY = 'careerEsLogs';

// 壊れた / 旧スキーマのログを防御的に正規化する。
//   - 既存の必須フィールド（id / createdAt / userInput / result）は維持。
//   - optional な拡張フィールド（companyName / question / favorite 等）は
//     型が合うものだけ採用し、無ければそのまま欠損のままにする。
// これにより「optional field を後から足した」だけでは既存ログが壊れない。
function normalizeEsLog(raw: unknown): CareerEsLog | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.result !== 'object' || r.result === null) {
    return null;
  }
  const log: CareerEsLog = {
    id: r.id,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    userInput: typeof r.userInput === 'string' ? r.userInput : '',
    result: r.result as CareerEsLog['result'],
  };
  if (typeof r.companyName === 'string') log.companyName = r.companyName;
  if (typeof r.question === 'string') log.question = r.question;
  if (typeof r.charLimit === 'number') log.charLimit = r.charLimit;
  if (typeof r.favorite === 'boolean') log.favorite = r.favorite;
  if (typeof r.submitted === 'boolean') log.submitted = r.submitted;
  if (r.editedResult && typeof r.editedResult === 'object') {
    log.editedResult = r.editedResult as CareerEsLog['editedResult'];
  }
  return log;
}

export function loadEsLogs(): CareerEsLog[] {
  const raw = safeGetStorage<unknown[]>(ES_LOG_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeEsLog).filter((l): l is CareerEsLog => l !== null);
}

export function saveEsLogs(logs: CareerEsLog[]): void {
  safeSetStorage(ES_LOG_KEY, logs);
}

// 1 件を先頭に追記して保存する（最新が先頭）。run 画面から利用する。
export function appendEsLog(log: CareerEsLog): void {
  saveEsLogs([log, ...loadEsLogs()]);
}

// 指定 ID の 1 件に部分更新を適用して保存する（お気に入り / 提出済みトグル等）。
// 該当が無ければ何もしない。結果画面から利用する。
export function updateEsLog(id: string, patch: Partial<CareerEsLog>): void {
  const logs = loadEsLogs();
  let changed = false;
  const next = logs.map((log) => {
    if (log.id !== id) return log;
    changed = true;
    return { ...log, ...patch, id: log.id };
  });
  if (changed) saveEsLogs(next);
}

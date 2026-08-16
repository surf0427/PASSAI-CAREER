import type {
  CareerEsLog,
  CareerEsResult,
  CareerEsSelectionType,
} from '@/types/careerEs';
import { normalizeSelectedMaterials } from '@/lib/careerEs/materialCandidates';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';

// SSR / 旧 runtime fallback 付き UUID（run 画面と同方針）。
export function newEsId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ces-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// 空の CareerEsResult 土台。ESトレーニングでは本文を body に持つため result は空で埋める
// （横断メモリ互換のため result 自体は必須。body は保存時に result.answer にも反映する）。
export function emptyEsResult(): CareerEsResult {
  return {
    gakuchika: '',
    selfPr: '',
    motivation: '',
    headline: '',
    appealPoints: [],
    interviewQuestions: [],
    improvements: [],
  };
}

// ES ワークスペース（1 版 = 1 ログ）を作る factory。
//   - 新規（v1）: groupId 未指定なら自分の id を groupId にする。version=1。
//   - 改善（v+1）: groupId / version / sourceLogId を渡して版を積む。
// body は canonical。横断メモリ互換のため result.answer にも body を反映する。
export function createEsWorkspaceLog(params: {
  mode: 'deep' | 'write';
  question?: string;
  charLimit?: number;
  companyName?: string;
  // Company Data Spine の canonical key（Phase A / R4・optional）。
  companyId?: string;
  industry?: string;
  jobType?: string;
  selectionType?: CareerEsSelectionType | null;
  body?: string;
  groupId?: string;
  version?: number;
  sourceLogId?: string;
  deepDive?: CareerEsLog['deepDive'];
}): CareerEsLog {
  const id = newEsId();
  const body = params.body ?? '';
  const log: CareerEsLog = {
    id,
    createdAt: new Date().toISOString(),
    userInput: '',
    result: { ...emptyEsResult(), answer: body },
    body,
    mode: params.mode,
    groupId: params.groupId ?? id,
    version: params.version ?? 1,
  };
  if (params.question?.trim()) log.question = params.question.trim();
  if (typeof params.charLimit === 'number' && params.charLimit > 0) {
    log.charLimit = Math.floor(params.charLimit);
  }
  if (params.companyName?.trim()) log.companyName = params.companyName.trim();
  if (params.companyId?.trim()) log.companyId = params.companyId.trim();
  if (params.industry?.trim()) log.industry = params.industry.trim();
  if (params.jobType?.trim()) log.jobType = params.jobType.trim();
  if (params.selectionType === 'main' || params.selectionType === 'internship') {
    log.selectionType = params.selectionType;
  }
  if (params.sourceLogId) log.sourceLogId = params.sourceLogId;
  if (params.deepDive) log.deepDive = params.deepDive;
  return log;
}

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
  // Company Identity（Phase A / R4）: optional・欠損が正常（旧ログは常に欠損）。
  if (typeof r.companyId === 'string' && r.companyId.trim() !== '') {
    log.companyId = r.companyId.trim();
  }
  if (typeof r.question === 'string') log.question = r.question;
  if (typeof r.charLimit === 'number') log.charLimit = r.charLimit;
  if (r.selectionType === 'main' || r.selectionType === 'internship') {
    log.selectionType = r.selectionType;
  }
  if (typeof r.industry === 'string') log.industry = r.industry;
  if (typeof r.jobType === 'string') log.jobType = r.jobType;
  if (typeof r.favorite === 'boolean') log.favorite = r.favorite;
  if (typeof r.submitted === 'boolean') log.submitted = r.submitted;
  if (r.editedResult && typeof r.editedResult === 'object') {
    log.editedResult = r.editedResult as CareerEsLog['editedResult'];
  }
  // ESトレーニングシステム（本文・添削・版管理）。すべて optional・後方互換。
  if (typeof r.body === 'string') log.body = r.body;
  if (r.review && typeof r.review === 'object') {
    log.review = r.review as CareerEsLog['review'];
  }
  if (typeof r.groupId === 'string') log.groupId = r.groupId;
  if (typeof r.version === 'number' && Number.isFinite(r.version)) {
    log.version = r.version;
  }
  if (r.mode === 'deep' || r.mode === 'write') log.mode = r.mode;
  if (r.deepDive && typeof r.deepDive === 'object') {
    const d = r.deepDive as Record<string, unknown>;
    const turns = Array.isArray(d.turns)
      ? d.turns
          .map((t) => {
            if (!t || typeof t !== 'object') return null;
            const role = (t as { role?: unknown }).role;
            const content = (t as { content?: unknown }).content;
            if ((role === 'question' || role === 'answer') && typeof content === 'string') {
              return { role, content };
            }
            return null;
          })
          .filter((t): t is { role: 'question' | 'answer'; content: string } => t !== null)
      : [];
    const memo = Array.isArray(d.memo)
      ? d.memo.filter((m): m is string => typeof m === 'string')
      : undefined;
    // 選択材料（V1 で追加・optional）。旧ログには存在しないため欠損のままにする。
    const materials = normalizeSelectedMaterials(d.materials);
    log.deepDive = {
      turns,
      ...(memo ? { memo } : {}),
      ...(materials.length > 0 ? { materials } : {}),
    };
  }
  if (typeof r.sourceLogId === 'string') log.sourceLogId = r.sourceLogId;
  if (r.sourceType === 'generated' || r.sourceType === 'review_rewrite') {
    log.sourceType = r.sourceType;
  }
  // 企業研究ログ連携（optional・後方互換）。snapshot は object のみ採用する。
  if (typeof r.companyResearchLogId === 'string') {
    log.companyResearchLogId = r.companyResearchLogId;
  }
  if (r.companyResearchSnapshot && typeof r.companyResearchSnapshot === 'object') {
    log.companyResearchSnapshot = r.companyResearchSnapshot as CareerEsLog['companyResearchSnapshot'];
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

// ── バージョン管理ヘルパー ──────────────────────────────────────────
// ES は（設問＋企業）ごとに groupId でまとめ、その中で version を積む。
// groupId 欠損の旧ログは「自分1件だけのグループ（単独版）」として扱う。

// ID 1 件を取得する（[id] エディタ・詳細画面から利用）。無ければ null。
export function loadEsLogById(id: string): CareerEsLog | null {
  return loadEsLogs().find((l) => l.id === id) ?? null;
}

// あるグループの全版を version 昇順で返す（groupId 欠損ログは id 単独グループ扱い）。
export function loadEsGroupVersions(groupId: string): CareerEsLog[] {
  return loadEsLogs()
    .filter((l) => (l.groupId ?? l.id) === groupId)
    .sort((a, b) => (a.version ?? 1) - (b.version ?? 1));
}

// あるグループの最新版番号を返す（版が無ければ 0）。次版は +1 で採番する。
export function latestEsVersion(groupId: string): number {
  return loadEsGroupVersions(groupId).reduce(
    (max, l) => Math.max(max, l.version ?? 1),
    0,
  );
}

// グループ別に最新版 1 件だけを、新しい順（作成日時降順）で返す。
// history 一覧（結果を見る / 改善する）で「グループ1行＝最新版」を表示するのに使う。
export function loadEsGroupsLatest(): CareerEsLog[] {
  const latestByGroup = new Map<string, CareerEsLog>();
  for (const log of loadEsLogs()) {
    const key = log.groupId ?? log.id;
    const cur = latestByGroup.get(key);
    if (!cur || (log.version ?? 1) > (cur.version ?? 1)) {
      latestByGroup.set(key, log);
    }
  }
  return [...latestByGroup.values()].sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || ''),
  );
}

// 指定 ID の添削結果を保存する（updateEsLog の薄い別名。意図を明示するため用意）。
export function updateEsReview(id: string, review: CareerEsLog['review']): void {
  updateEsLog(id, { review });
}

import {
  ES_DRAFT_SCHEMA_VERSION,
  type CareerEsDraft,
} from '@/types/careerEs';
import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';

// 就活版 ES「作成中ドラフト」の localStorage 保存層（正式ログ careerEsLogs とは別ストア）。
//   - 未完成の深掘りQ&A・材料整理メモ・執筆中本文を保存し、途中離脱→再開を可能にする。
//   - careerEsLogs には未完成状態を書かない（横断機能・履歴への露出防止）。
//   - owner（member=userId / guest=null）単位で分離し、他ユーザーの draft を復元しない。
//   - schemaVersion 不一致・壊れた draft は読み込み時に安全に破棄する（fail-safe）。
const ES_DRAFT_KEY = 'careerEsDrafts';

// 端末あたりの draft 上限（LRU）。作成中の一時データなので控えめに保つ。
const MAX_DRAFTS = 20;

// guest / member を通じて owner を安定比較するための正規化（guest は null）。
function normalizeOwner(ownerId: string | null | undefined): string | null {
  return typeof ownerId === 'string' && ownerId !== '' ? ownerId : null;
}

// 壊れた / 旧スキーマの draft を防御的に正規化する。
//   - schemaVersion 不一致は null（＝破棄）。
//   - 必須フィールド（id / mode / question 等）が欠ければ null。
function normalizeDraft(raw: unknown): CareerEsDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== ES_DRAFT_SCHEMA_VERSION) return null;
  if (typeof r.id !== 'string') return null;
  if (r.mode !== 'deep' && r.mode !== 'write') return null;

  const draft: CareerEsDraft = {
    id: r.id,
    schemaVersion: ES_DRAFT_SCHEMA_VERSION,
    ownerId: normalizeOwner(r.ownerId as string | null | undefined),
    mode: r.mode,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    question: typeof r.question === 'string' ? r.question : '',
  };
  if (typeof r.charLimit === 'number' && Number.isFinite(r.charLimit)) draft.charLimit = r.charLimit;
  if (typeof r.companyName === 'string') draft.companyName = r.companyName;
  if (typeof r.industry === 'string') draft.industry = r.industry;
  if (typeof r.jobType === 'string') draft.jobType = r.jobType;
  if (r.selectionType === 'main' || r.selectionType === 'internship') {
    draft.selectionType = r.selectionType;
  }
  if (typeof r.questionType === 'string') draft.questionType = r.questionType;
  if (Array.isArray(r.deepTurns)) {
    draft.deepTurns = r.deepTurns
      .map((t) => {
        if (!t || typeof t !== 'object') return null;
        const role = (t as { role?: unknown }).role;
        const content = (t as { content?: unknown }).content;
        if ((role === 'question' || role === 'answer') && typeof content === 'string') {
          return { role, content };
        }
        return null;
      })
      .filter((t): t is { role: 'question' | 'answer'; content: string } => t !== null);
  }
  if (Array.isArray(r.memo)) {
    draft.memo = r.memo.filter((m): m is string => typeof m === 'string');
  }
  if (typeof r.organized === 'boolean') draft.organized = r.organized;
  if (typeof r.body === 'string') draft.body = r.body;
  return draft;
}

// 全 draft を読む（内部用・全 owner 混在。壊れた要素は除去）。
// localStorage JSON parse error は safeGetStorage が握るため、ここは配列前提で防御する。
function loadAllDrafts(): CareerEsDraft[] {
  const raw = safeGetStorage<unknown[]>(ES_DRAFT_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeDraft).filter((d): d is CareerEsDraft => d !== null);
}

function saveAllDrafts(drafts: CareerEsDraft[]): void {
  safeSetStorage(ES_DRAFT_KEY, drafts.slice(0, MAX_DRAFTS));
}

// 指定 owner の draft を更新日時の新しい順に返す。
export function loadEsDrafts(ownerId: string | null | undefined): CareerEsDraft[] {
  const owner = normalizeOwner(ownerId);
  return loadAllDrafts()
    .filter((d) => d.ownerId === owner)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// 指定 owner の指定 draft を 1 件返す（owner 境界を越えて他人の draft は返さない）。
export function loadEsDraft(
  id: string,
  ownerId: string | null | undefined,
): CareerEsDraft | null {
  const owner = normalizeOwner(ownerId);
  return loadAllDrafts().find((d) => d.id === id && d.ownerId === owner) ?? null;
}

// draft を upsert する（updatedAt は呼び出し側で設定済みの前提。ownerId は正規化）。
export function saveEsDraft(draft: CareerEsDraft): void {
  const normalized: CareerEsDraft = {
    ...draft,
    schemaVersion: ES_DRAFT_SCHEMA_VERSION,
    ownerId: normalizeOwner(draft.ownerId),
  };
  const rest = loadAllDrafts().filter((d) => d.id !== normalized.id);
  // 最新（今 upsert した draft）を先頭に置く（LRU cap 対象順序を安定させる）。
  saveAllDrafts([normalized, ...rest]);
}

// draft を削除する（正式保存成功時・明示破棄時のみ呼ぶ）。owner 境界を尊重する。
export function deleteEsDraft(id: string, ownerId: string | null | undefined): void {
  const owner = normalizeOwner(ownerId);
  const rest = loadAllDrafts().filter((d) => !(d.id === id && d.ownerId === owner));
  saveAllDrafts(rest);
}

'use client';

// 自己分析「過去の結果を更新する」— 生成中の更新対象を保持する owner-scoped draft slot。
//
// なぜ必要か:
//   member の生成は耐障害 job 経路（202 → poll → 復元）で、リロードや再訪でも
//   controller が pending job を resume して finalize する。その finalize は
//   「どの自己分析の更新か」「備考は何か」を知っている必要があるが、pending slot は
//   **本文を保存しない契約**（lib/careerSelfAnalysis/clientJob/types.ts）なので入れられない。
//   そこで別 key に更新対象だけを置く。
//
// 保存するのは rootId（既存ログの id）と備考のみ。備考は保存成功時に
// CareerSelfAnalysisLog.userInput として canonical へ入る値と同じもので、
// 新しい種類のデータを増やしてはいない。生成の完了・破棄で消す。

import { safeGetStorage, safeSetStorage, safeRemoveStorage } from '@/lib/storage/safeStorage';

const KEY_PREFIX = 'careerSelfAnalysisUpdateDraft:';

export interface SelfAnalysisUpdateDraft {
  version: 1;
  ownerScope: string;
  /** 更新対象 lineage の起点ログ id。 */
  rootId: string;
  /** ユーザーが入力した「追加したいこと・修正したいこと」。 */
  note: string;
}

function keyFor(ownerScope: string): string {
  return `${KEY_PREFIX}${ownerScope}`;
}

export function writeUpdateDraft(ownerScope: string, rootId: string, note: string): void {
  if (!ownerScope || !rootId) return;
  const draft: SelfAnalysisUpdateDraft = { version: 1, ownerScope, rootId, note };
  safeSetStorage(keyFor(ownerScope), draft);
}

/** owner 不一致 / version 不一致 / 壊れた値は採用しない。 */
export function readUpdateDraft(ownerScope: string): SelfAnalysisUpdateDraft | null {
  if (!ownerScope) return null;
  const raw = safeGetStorage<SelfAnalysisUpdateDraft | null>(keyFor(ownerScope), null);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== 1 || raw.ownerScope !== ownerScope) return null;
  if (typeof raw.rootId !== 'string' || raw.rootId === '') return null;
  return { version: 1, ownerScope, rootId: raw.rootId, note: typeof raw.note === 'string' ? raw.note : '' };
}

export function clearUpdateDraft(ownerScope: string): void {
  if (!ownerScope) return;
  safeRemoveStorage(keyFor(ownerScope));
}

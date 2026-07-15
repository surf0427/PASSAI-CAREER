// 自己分析まとめ生成 — pending slot store（Step3 / owner-scoped・versioned）。
//
// key は owner 単位に分ける（PENDING_KEY_PREFIX + ownerScope）。
// 読み取りは「現在の owner」の key のみを見る。version / ownerScope 不一致は採用しない。
// **本文・result・prompt・error・PII は保存しない**（型で最小フィールドに限定）。

import { PENDING_KEY_PREFIX, PENDING_VERSION } from './constants';
import type { PendingSelfAnalysisJob } from './types';

// localStorage 互換の最小 interface（QA で fake 注入）。
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export function keyForOwner(ownerScope: string): string {
  return `${PENDING_KEY_PREFIX}${ownerScope}`;
}

function isValidPending(v: unknown, ownerScope: string): v is PendingSelfAnalysisJob {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    p.version === PENDING_VERSION &&
    p.ownerScope === ownerScope && // 他 owner の record は採用しない
    (typeof p.jobId === 'string' || p.jobId === null) &&
    typeof p.clientFingerprint === 'string' &&
    (p.requestState === 'submitting' || p.requestState === 'running' || p.requestState === 'unknown') &&
    typeof p.createdAt === 'string' &&
    (typeof p.lastCheckedAt === 'string' || p.lastCheckedAt === null) &&
    typeof p.promptRevision === 'string' &&
    typeof p.outputSchemaRevision === 'string'
  );
}

/** 現在 owner の pending を読む（不正・他 owner・version 不一致は null）。 */
export function readPending(storage: StorageLike, ownerScope: string): PendingSelfAnalysisJob | null {
  const raw = storage.getItem(keyForOwner(ownerScope));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isValidPending(parsed, ownerScope) ? parsed : null;
}

/** raw 文字列を現在 owner の pending として解釈（storage event 用）。 */
export function parsePending(raw: string | null, ownerScope: string): PendingSelfAnalysisJob | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isValidPending(parsed, ownerScope) ? parsed : null;
  } catch {
    return null;
  }
}

export function writePending(storage: StorageLike, pending: PendingSelfAnalysisJob): void {
  storage.setItem(keyForOwner(pending.ownerScope), JSON.stringify(pending));
}

export function clearPending(storage: StorageLike, ownerScope: string): void {
  storage.removeItem(keyForOwner(ownerScope));
}

/** logout 用: prefix 配下の全 owner pending を消す。 */
export function clearAllPending(storage: StorageLike): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(PENDING_KEY_PREFIX)) keys.push(k);
  }
  for (const k of keys) storage.removeItem(k);
}

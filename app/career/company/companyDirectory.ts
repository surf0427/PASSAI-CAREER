/**
 * Company Identity — 端末側の「最近使った企業」表示キャッシュ（Phase A / R2）。
 *
 * ★ これは **canonical ではない**。canonical は server の企業マスタ
 *   （career_company_master・authority: global_shared_server_authoritative）。
 *   ここに置くのは companyId → displayName を offline / 未ログインでも描くための
 *   derived cache で、消えても CompanyPicker・各機能の動作に影響しない（再取得できる）。
 *   新しい truth store を作らないための境界コメントであり、実装もそれに従うこと:
 *     - ここを唯一の情報源として企業を「作らない」
 *     - ここの内容で server の displayName を上書きしない（server が優先）
 *
 * localStorage key: 'careerCompanyDirectory'
 */

import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';
import type { CareerCompanyDirectoryEntry } from '@/types/careerCompanyIdentity';

const DIRECTORY_KEY = 'careerCompanyDirectory';

/** キャッシュ上限（LRU）。表示用途なので控えめに保つ。 */
const MAX_ENTRIES = 60;

function normalizeEntry(raw: unknown): CareerCompanyDirectoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.companyId !== 'string' || r.companyId.trim() === '') return null;
  return {
    companyId: r.companyId,
    displayName: typeof r.displayName === 'string' ? r.displayName : '',
    lastUsedAt: typeof r.lastUsedAt === 'string' ? r.lastUsedAt : '',
  };
}

/** 最近使った順（新しい順）で返す。壊れた要素は捨てる。 */
export function loadCompanyDirectory(): CareerCompanyDirectoryEntry[] {
  const raw = safeGetStorage<unknown[]>(DIRECTORY_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeEntry)
    .filter((e): e is CareerCompanyDirectoryEntry => e !== null)
    .sort((a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''));
}

/** companyId から表示名を引く（無ければ ''）。 */
export function lookupCompanyDisplayName(companyId: string): string {
  if (!companyId) return '';
  return loadCompanyDirectory().find((e) => e.companyId === companyId)?.displayName ?? '';
}

/**
 * 企業を「使った」ものとして記録する（選択・登録の直後に呼ぶ）。
 * 既存 entry は displayName を更新し、先頭へ寄せる。
 */
export function touchCompanyInDirectory(companyId: string, displayName: string): void {
  const id = typeof companyId === 'string' ? companyId.trim() : '';
  if (id === '') return;
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  const now = new Date().toISOString();
  const rest = loadCompanyDirectory().filter((e) => e.companyId !== id);
  const previous = loadCompanyDirectory().find((e) => e.companyId === id);
  const entry: CareerCompanyDirectoryEntry = {
    companyId: id,
    // 名前が渡らなかった場合は既存キャッシュ値を保つ（空で潰さない）。
    displayName: name || previous?.displayName || '',
    lastUsedAt: now,
  };
  safeSetStorage(DIRECTORY_KEY, [entry, ...rest].slice(0, MAX_ENTRIES));
}

/** キャッシュから 1 件外す（企業が見つからなくなった場合の掃除）。 */
export function removeCompanyFromDirectory(companyId: string): void {
  if (!companyId) return;
  safeSetStorage(
    DIRECTORY_KEY,
    loadCompanyDirectory().filter((e) => e.companyId !== companyId),
  );
}

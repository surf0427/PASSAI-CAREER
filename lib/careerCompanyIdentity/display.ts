/**
 * Company Identity — 表示名の解決（pure・決定論・never-throw）。
 *
 * 4 機能（企業研究 / ES / 面接 / プレゼン）が同じ分岐を各所に書かないための **唯一の実装**。
 *
 * 契約:
 *   - `companyId` があり directory に名前があれば、それを優先（社名変更に追従できる）。
 *   - 無ければ既存の free-text `companyName` を使う（**後方互換の本体**）。
 *   - どちらも無ければ空文字（呼び出し側が「企業名なし」を描く）。
 *
 * ★ 企業判定ロジック（正規化 / 解決）はここに置かない。それは
 *   `lib/careerCompanyKnowledge/identity.ts` の責務（再実装しない）。
 */

import type { CareerCompanyDirectoryEntry, CareerCompanyRef } from '@/types/careerCompanyIdentity';

/** directory（表示キャッシュ）の最小 lookup 形。Map / Record / 配列のどれでも渡せる。 */
export type CompanyDisplayLookup =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>
  | readonly CareerCompanyDirectoryEntry[]
  | null
  | undefined;

function lookupDisplayName(companyId: string, lookup: CompanyDisplayLookup): string {
  if (!lookup || !companyId) return '';
  try {
    if (Array.isArray(lookup)) {
      const hit = lookup.find((e) => e && e.companyId === companyId);
      return typeof hit?.displayName === 'string' ? hit.displayName.trim() : '';
    }
    if (lookup instanceof Map) {
      const hit = lookup.get(companyId);
      return typeof hit === 'string' ? hit.trim() : '';
    }
    const hit = (lookup as Record<string, unknown>)[companyId];
    return typeof hit === 'string' ? hit.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 企業参照から表示名を決める（pure）。
 *
 * directory が無い / 未取得でも **必ず companyName へ倒れる**ので、
 * offline / 未ログイン / Supabase 未設定でも表示が壊れない。
 */
export function resolveCompanyDisplayName(
  ref: CareerCompanyRef | null | undefined,
  directory?: CompanyDisplayLookup,
): string {
  if (!ref || typeof ref !== 'object') return '';
  const fromDirectory =
    typeof ref.companyId === 'string' ? lookupDisplayName(ref.companyId, directory) : '';
  if (fromDirectory) return fromDirectory;
  return typeof ref.companyName === 'string' ? ref.companyName.trim() : '';
}

/**
 * 企業参照が「登録済み企業に紐付いているか」。
 * 紐付いていなくても機能は使える（free-text fallback）ため、これは表示・導線の判定にだけ使う。
 */
export function hasLinkedCompanyId(ref: CareerCompanyRef | null | undefined): boolean {
  return !!ref && typeof ref.companyId === 'string' && ref.companyId.trim() !== '';
}

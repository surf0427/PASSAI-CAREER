/**
 * Company Knowledge (Layer 5) — company canonical identity / alias（P17-A §6.1）。
 *
 * free-text 企業名を即座に確定 ID へ変換しない。ambiguous / unresolved を型で表現し、
 * alias collision（同一 alias が複数 company を指す）を検出する。
 * synthetic fixture のみ使用。外部企業 DB / API を使わない。pure・決定論。
 */

import type {
  AliasCollision,
  CompanyCanonicalId,
  CompanyIdentityResolution,
  CompanyMasterRecord,
} from '@/types/careerCompanyKnowledge';

/**
 * 企業名を正規化する（大小・前後空白・全角/半角括弧・代表的法人格語を除去）。
 * 決定論。外部辞書は使わない（synthetic 範囲の最小正規化）。
 */
export function normalizeCompanyName(raw: string): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  // 全角空白 → 半角、連続空白畳み込み。
  s = s.replace(/　/g, ' ').replace(/\s+/g, ' ');
  // 代表的な法人格表記を除去（前後どちらでも）。
  const legalTokens = [
    '株式会社',
    '有限会社',
    '合同会社',
    '(株)',
    '（株）',
    'co.,ltd.',
    'co., ltd.',
    'co.,ltd',
    'inc.',
    'inc',
    'ltd.',
    'ltd',
    'corporation',
    'corp.',
    'corp',
  ];
  for (const t of legalTokens) {
    s = s.split(t).join('');
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * master 群から alias collision を検出する（同一 normalized alias が複数 company を指す）。
 * displayName / normalizedName / aliases すべてを alias 候補として扱う。決定論順。
 */
export function detectAliasCollisions(
  master: readonly CompanyMasterRecord[],
): AliasCollision[] {
  const aliasToCompanies = new Map<string, Set<CompanyCanonicalId>>();
  const add = (aliasRaw: string, companyId: CompanyCanonicalId) => {
    const alias = normalizeCompanyName(aliasRaw);
    if (alias === '') return;
    let set = aliasToCompanies.get(alias);
    if (!set) {
      set = new Set<CompanyCanonicalId>();
      aliasToCompanies.set(alias, set);
    }
    set.add(companyId);
  };
  for (const m of master) {
    add(m.displayName, m.companyId);
    add(m.normalizedName, m.companyId);
    for (const a of m.aliases) add(a, m.companyId);
  }
  const collisions: AliasCollision[] = [];
  for (const [alias, ids] of aliasToCompanies) {
    if (ids.size > 1) {
      collisions.push({ alias, companyIds: Array.from(ids).sort() });
    }
  }
  collisions.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
  return collisions;
}

/**
 * free-text 企業名を master に対して解決する（pure・決定論）。
 *
 * - 一意一致 → resolved（matchedAlias を保持）。
 * - 複数一致（alias collision 等）→ ambiguous（自動確定しない）。
 * - 不一致 → unresolved。
 */
export function resolveCompany(
  rawName: string,
  master: readonly CompanyMasterRecord[],
): CompanyIdentityResolution {
  const norm = normalizeCompanyName(rawName);
  if (norm === '') return { status: 'unresolved' };

  const matches: Array<{ id: CompanyCanonicalId; displayName: string; matchedAlias: string | null }> = [];
  for (const m of master) {
    const candidates = new Set<string>([
      normalizeCompanyName(m.displayName),
      normalizeCompanyName(m.normalizedName),
      ...m.aliases.map(normalizeCompanyName),
    ]);
    if (candidates.has(norm)) {
      const matchedAlias =
        normalizeCompanyName(m.displayName) === norm ? null : rawName.trim();
      matches.push({ id: m.companyId, displayName: m.displayName, matchedAlias });
    }
  }

  if (matches.length === 0) return { status: 'unresolved' };
  if (matches.length === 1) {
    return {
      status: 'resolved',
      companyId: matches[0].id,
      displayName: matches[0].displayName,
      matchedAlias: matches[0].matchedAlias,
    };
  }
  // 複数一致は黙って解決しない（ambiguous）。候補は決定論順。
  const uniqueIds = Array.from(new Set(matches.map((x) => x.id))).sort();
  if (uniqueIds.length === 1) {
    const only = matches[0];
    return { status: 'resolved', companyId: only.id, displayName: only.displayName, matchedAlias: only.matchedAlias };
  }
  return { status: 'ambiguous', candidates: uniqueIds };
}

/** resolution が確定 id を持つか（projection / dedup の前提判定）。 */
export function isResolvedIdentity(
  r: CompanyIdentityResolution,
): r is Extract<CompanyIdentityResolution, { status: 'resolved' }> {
  return r.status === 'resolved';
}

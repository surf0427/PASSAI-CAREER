/**
 * Company Identity — 解決結果の境界整形（pure・決定論・never-throw）。
 *
 * ★ 判定そのものは **既存 `resolveCompany`（lib/careerCompanyKnowledge/identity.ts）** が行う。
 *   本 module は「その結果を API 境界の形（displayName 付き）へ写す」だけで、
 *   企業判定ロジックを再実装しない。
 *
 * 不変条件（QA が固定する）:
 *   - `ambiguous` を `resolved` へ **昇格させない**。
 *   - 部分一致した候補は `unresolved.suggestions` として返し、**解決結果として扱わない**
 *     （UI が自動選択したら invariant 違反）。
 */

import { resolveCompany } from '@/lib/careerCompanyKnowledge/identity';
import type { CompanyMasterRecord } from '@/types/careerCompanyKnowledge';
import type {
  CompanyResolveCandidate,
  CompanyResolveResult,
} from '@/types/careerCompanyIdentity';

/** 候補提示の上限（UI が選びきれる件数に抑える）。 */
export const COMPANY_SUGGESTION_LIMIT = 8;

function toCandidate(record: CompanyMasterRecord): CompanyResolveCandidate {
  return { companyId: record.companyId, displayName: record.displayName };
}

/** companyId 順を安定させる（決定論。QA が順序に依存できる）。 */
function sortCandidates(list: CompanyResolveCandidate[]): CompanyResolveCandidate[] {
  return [...list].sort((a, b) =>
    a.displayName === b.displayName
      ? a.companyId.localeCompare(b.companyId)
      : a.displayName.localeCompare(b.displayName),
  );
}

/**
 * free-text 企業名 + DB prefilter 候補 → API 境界の解決結果。
 *
 * @param rawName ユーザーが入力した企業名（正規化前）
 * @param candidates DB prefilter で絞った master record 群（部分一致を含みうる）
 */
export function buildCompanyResolveResult(
  rawName: string,
  candidates: readonly CompanyMasterRecord[],
): CompanyResolveResult {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  // ★ 判定は既存純関数に完全委譲（完全一致のみが resolved になる）。
  const resolution = resolveCompany(rawName, list);

  if (resolution.status === 'resolved') {
    return {
      status: 'resolved',
      companyId: resolution.companyId,
      displayName: resolution.displayName,
      matchedAlias: resolution.matchedAlias,
    };
  }

  const byId = new Map(list.map((r) => [r.companyId, r] as const));

  if (resolution.status === 'ambiguous') {
    // ★ 自動確定しない。候補をそのまま返してユーザーに選ばせる。
    const candidatesOut = resolution.candidates
      .map((id) => byId.get(id))
      .filter((r): r is CompanyMasterRecord => !!r)
      .map(toCandidate);
    return { status: 'ambiguous', candidates: sortCandidates(candidatesOut).slice(0, COMPANY_SUGGESTION_LIMIT) };
  }

  // unresolved: 完全一致は無い。部分一致した prefilter 候補を **参考**として返す。
  return {
    status: 'unresolved',
    suggestions: sortCandidates(list.map(toCandidate)).slice(0, COMPANY_SUGGESTION_LIMIT),
  };
}

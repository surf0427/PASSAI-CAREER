/**
 * Company Knowledge (Layer 5) — evidence aggregation / trend eligibility（P17-B §7）。
 *
 * 複数 contribution を企業の確定事実へ変換せず evidence group にまとめる pure logic。
 *
 * 厳守:
 *   - 単一投稿は trend 不可。
 *   - duplicate 投稿を複数根拠として数えない（independent contributor で判定）。
 *   - 同一 opaque contributor の投稿を独立根拠にしない。
 *   - official と user_experience を混同しない（別 count）。
 *   - conflicting evidence を消さない・confidence を過大評価しない。
 *   - raw contributor count は projection へ出さず bucket 化する。
 *   - threshold は PROVISIONAL policy として注入可能。
 *
 * pure・決定論。
 */

import { classifyPair } from './dedup';
import { contributionCompanyKey } from './contribution';
import { classifyFreshness } from './provenance';
import { CORROBORATION_BUCKETS, MIN_CORROBORATION_FOR_TREND, type CorroborationPolicy } from './policy';
import type {
  AggregatedEvidenceGroup,
  CompanyKnowledgeContribution,
  CorroborationBucket,
  EvidenceGroupKey,
  FreshnessClassification,
  TrendEligibility,
} from '@/types/careerCompanyKnowledge';

function groupKey(c: CompanyKnowledgeContribution): EvidenceGroupKey {
  return {
    companyId: contributionCompanyKey(c),
    contentCategory: c.contentCategory,
    selectionCategory: c.selectionCategory,
    roleCategory: c.roleCategory,
  };
}
function serializeKey(k: EvidenceGroupKey): string {
  return JSON.stringify([k.companyId, k.contentCategory, k.selectionCategory, k.roleCategory]);
}

/** 独立 contributor 数 → 安全 bucket（PROVISIONAL 閾値・生 count は出さない）。 */
export function toCorroborationBucket(
  independentContributors: number,
  policy: CorroborationPolicy = CORROBORATION_BUCKETS,
): CorroborationBucket {
  const n = Number.isFinite(independentContributors) ? Math.max(0, Math.floor(independentContributors)) : 0;
  if (n >= policy.many) return 'many';
  if (n >= policy.several) return 'several';
  if (n >= policy.few) return 'few';
  return 'single';
}

function bestFreshness(a: FreshnessClassification, b: FreshnessClassification): FreshnessClassification {
  const order: FreshnessClassification[] = ['stale', 'unknown', 'aging', 'fresh'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function evaluateTrend(input: {
  independentContributors: number;
  hasConflict: boolean;
  memberCount: number;
  policy: CorroborationPolicy;
}): TrendEligibility {
  if (input.hasConflict) return { eligible: false, reason: 'conflicting' };
  if (input.independentContributors < MIN_CORROBORATION_FOR_TREND) {
    return { eligible: false, reason: input.independentContributors <= 1 ? 'single_report' : 'insufficient_independent' };
  }
  return { eligible: true, bucket: toCorroborationBucket(input.independentContributors, input.policy) };
}

/**
 * contribution 群を evidence group へ集約する（pure・決定論）。
 * group key = company × contentCategory × selectionCategory × roleCategory。
 */
export function buildEvidenceGroups(
  contributions: readonly CompanyKnowledgeContribution[],
  nowIso: string,
  policy: CorroborationPolicy = CORROBORATION_BUCKETS,
): AggregatedEvidenceGroup[] {
  const buckets = new Map<string, CompanyKnowledgeContribution[]>();
  for (const c of contributions) {
    const key = serializeKey(groupKey(c));
    const arr = buckets.get(key);
    if (arr) arr.push(c);
    else buckets.set(key, [c]);
  }

  const groups: AggregatedEvidenceGroup[] = [];
  for (const [, members0] of buckets) {
    const members = [...members0].sort((a, b) =>
      a.contributionId < b.contributionId ? -1 : a.contributionId > b.contributionId ? 1 : 0,
    );
    const contributors = new Set(members.map((m) => m.__contributorOpaqueKey));
    const independent = contributors.size;

    let hasConflict = false;
    for (let i = 0; i < members.length && !hasConflict; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (classifyPair(members[i], members[j]) === 'conflicting') {
          hasConflict = true;
          break;
        }
      }
    }

    const officialCount = members.filter(
      (m) => m.evidenceKind === 'official' || m.evidenceKind === 'company_provided',
    ).length;
    const userExperienceCount = members.filter((m) => m.evidenceKind === 'user_experience').length;

    const observedPeriods = Array.from(new Set(members.map((m) => m.observedPeriod))).sort().reverse();
    const freshness = members
      .map((m) => classifyFreshness(m.observedPeriod, nowIso))
      .reduce<FreshnessClassification>((acc, f) => bestFreshness(acc, f), 'stale');

    const rep = members[0];
    groups.push({
      key: groupKey(rep),
      corroboration: toCorroborationBucket(independent, policy),
      independentContributorCount: independent,
      officialCount,
      userExperienceCount,
      hasConflict,
      observedPeriods,
      freshness,
      trend: evaluateTrend({ independentContributors: independent, hasConflict, memberCount: members.length, policy }),
      representativeId: rep.contributionId,
      memberIds: members.map((m) => m.contributionId),
    });
  }

  // deterministic ordering（key 順）。
  groups.sort((a, b) => (serializeKey(a.key) < serializeKey(b.key) ? -1 : serializeKey(a.key) > serializeKey(b.key) ? 1 : 0));
  return groups;
}

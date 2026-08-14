// PASSAI CAREER — Layer 4 の **source eligibility 表**（Collective Intelligence Closure / `D-C2`）。
//
// 「Event Log があるから全 event を aggregate してよい」を構造的に禁止する（Human 指示 §6）。
// aggregate へ投入しうる source を **明示 allowlist** で列挙し、それ以外は
// `classifyDataClass` の default deny（PERSONAL_ONLY）と合わせて二重に拒否する。
//
// ★ 現時点で eligible なのは **`event.feature_usage` の 1 種類だけ**。
//   これは「いつどの機能を使ったか」という構造化 signal で、本文・スコア・企業・属性を持たない。
//   他はすべて ineligible で、その理由をコードに残す（監査で読める形にする）。
//
// pure / deterministic / never-throw。I/O・env 非依存。

import {
  CAREER_DATA_CLASSES,
  classifyDataClass,
  mayBeAggregated,
  requiredConsentScopeFor,
  type CareerDataClass,
} from '@/lib/careerDataGovernance/dataClassification';
import { FEATURE_USAGE_PREVALENCE } from './policy';
import type { ConsentScope } from '@/types/careerAggregate';

/** 集計方式（raw row を返さないことを型でも示す）。 */
export type AggregationMethod =
  | 'user_level_boolean_unique_count' // 1 user × 1 bucket × 1 feature = boolean 1
  | 'not_aggregated';

export type SourceEligibilityEntry = {
  dataClass: CareerDataClass;
  eligible: boolean;
  /** なぜ eligible / ineligible なのか（監査で読む根拠）。 */
  why: string;
  /** 投入に必要な consent scope（ineligible なら null）。 */
  requiredConsentScope: ConsentScope | null;
  aggregationMethod: AggregationMethod;
  /** 対応する metric（ineligible なら null）。 */
  metricKey: string | null;
};

const ELIGIBLE_ENTRIES: readonly SourceEligibilityEntry[] = [
  {
    dataClass: 'event.feature_usage',
    eligible: true,
    why:
      '構造化 event（feature / event_type / occurred_at→month のみ）。projection allowlist が ' +
      '本文・スコア・企業・属性・exact timestamp を落とすため、個人内容が artifact へ残らない。',
    requiredConsentScope: 'internal_aggregated_analytics',
    aggregationMethod: 'user_level_boolean_unique_count',
    metricKey: FEATURE_USAGE_PREVALENCE.metricKey,
  },
];

/** ineligible の理由（data class 別。列挙されない class は既定文言）。 */
const INELIGIBLE_REASON: Partial<Record<CareerDataClass, string>> = {
  'source.company_research':
    '本人専用の企業研究。共有は Layer 5 の明示 contribution 経路のみ（aggregate 対象外）。',
  'event.signal_summary':
    'Event Signal は本人向けの補助 summary。ability / aptitude / matching / aggregate へ流さない（`D-L3`/`D-L4`）。',
  'contribution.company_knowledge':
    'Layer 5 の寄与。Layer 4 の consent scope（aggregate 系）では **決して**満たされない境界（LAYER5_ONLY_SCOPE）。',
  'raw.free_text': '生本文。匿名化しても再識別リスクが残るため aggregate へ入れない。',
};

const DEFAULT_INELIGIBLE_REASON =
  '用途が明確に定義された aggregate metric が存在しない。用途未定の data は eligible にしない（Human 指示 §6）。';

const BY_CLASS: ReadonlyMap<CareerDataClass, SourceEligibilityEntry> = new Map(
  ELIGIBLE_ENTRIES.map((e) => [e.dataClass, e]),
);

/** 全 data class の eligibility 表（決定論順・docs 生成にも使う）。 */
export const SOURCE_ELIGIBILITY_TABLE: readonly SourceEligibilityEntry[] = CAREER_DATA_CLASSES.map(
  (dataClass): SourceEligibilityEntry => {
    const eligible = BY_CLASS.get(dataClass);
    if (eligible) return eligible;
    return {
      dataClass,
      eligible: false,
      why: INELIGIBLE_REASON[dataClass] ?? DEFAULT_INELIGIBLE_REASON,
      requiredConsentScope: null,
      aggregationMethod: 'not_aggregated',
      metricKey: null,
    };
  },
);

/**
 * その data class を aggregate 入力にしてよいか（**allowlist + 分類の二重判定**）。
 *
 * 片方でも false なら false。未知 class は両方 false になるため確実に拒否される。
 */
export function isAggregateEligibleSource(dataClass: string): boolean {
  const entry = BY_CLASS.get(dataClass as CareerDataClass);
  if (!entry || !entry.eligible) return false;
  // 分類側とも一致していること（表がずれたら安全側へ倒す）。
  if (!mayBeAggregated(dataClass)) return false;
  if (classifyDataClass(dataClass) !== 'ANONYMOUS_AGGREGATABLE') return false;
  // consent scope の宣言も一致していること。
  return entry.requiredConsentScope !== null &&
    entry.requiredConsentScope === requiredConsentScopeFor(dataClass);
}

/** eligible な data class 一覧（決定論順）。 */
export function eligibleAggregateSources(): CareerDataClass[] {
  return SOURCE_ELIGIBILITY_TABLE.filter((e) => e.eligible)
    .map((e) => e.dataClass)
    .sort();
}

/** eligibility 表の entry（未知なら null）。 */
export function sourceEligibilityEntry(dataClass: string): SourceEligibilityEntry | null {
  return SOURCE_ELIGIBILITY_TABLE.find((e) => e.dataClass === dataClass) ?? null;
}

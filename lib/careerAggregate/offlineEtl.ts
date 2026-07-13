/**
 * Aggregated Insight — synthetic offline ETL skeleton（P17-A §5.2）。
 *
 * これは production batch / cron ではない。fixture 入力のみを受け取り、Layer 4 の
 * 「safe row 化 → eligibility → allowlist projection → 集計 → safe artifact」経路を
 * DB 非依存で決定論的に再現する薄い skeleton。
 *
 * 厳守:
 *   - DB client / Supabase / reader を import しない（pure）。
 *   - career_user_events 相当の安全入力（RawAggregateEventInput）から開始する。
 *   - user_id / client_event_id / free text を output（artifact）へ残さない
 *     （projection / pipeline の allowlist に委譲。ETL は allowlist 外 field を drop したことのみ記録）。
 *   - consent ineligible は集計から除外（pipeline の projection reject に委譲）。
 *   - rare-category cohort 値は数値を出さず suppressed（rareCategory guard）。
 *   - deterministic output（artifact 配列は安定順）。
 */

import { AUDIENCE_REQUIRED_SCOPE } from './policy';
import { buildSuppressedArtifact } from './artifact';
import { evaluateRareCategory, type RareCategoryPolicy } from './rareCategory';
import { runFeatureUsagePrevalence } from './pipeline';
import { serializeAggregateReadKey, toAggregateReadKey } from './readRepository';
import type {
  AggregateAudience,
  AggregateQualityStatus,
  CareerEventFeature,
  CohortType,
  ConsentRecord,
  RawAggregateEventInput,
  SafeAggregateArtifact,
} from '@/types/careerAggregate';

/** projection が保持し得る（＝artifact へ流れない dedup 鍵含む）source field。 */
const ALLOWLIST_INPUT_FIELDS: ReadonlySet<string> = new Set<string>([
  'feature',
  'event_type',
  'occurred_at',
  'completion_status',
  // internal dedup 鍵（artifact へは残らないが入力段では読む）。
  'user_id',
  'client_event_id',
]);

export type OfflineEtlTarget = {
  feature: CareerEventFeature;
  cohortType: CohortType;
  cohortValue: string;
  monthBucket: string; // YYYY-MM
  audience: AggregateAudience;
};

export type OfflineEtlInput = {
  rawRows: readonly RawAggregateEventInput[];
  consentByUser: Record<string, ConsentRecord | undefined>;
  accountTypeByUser?: Record<string, string | undefined>;
  cohortByUser?: Record<string, string | undefined>;
  targets: readonly OfflineEtlTarget[];
  window: { sourceWindowStart: string; sourceWindowEnd: string };
  generatedAt: string; // ISO
  now: number; // epoch ms
  qualityStatus?: AggregateQualityStatus;
  rareCategoryPolicy?: RareCategoryPolicy;
  options?: { allowRollUp?: boolean; freshnessDelayHours?: number };
};

export type OfflineEtlResult = {
  /** 決定論順の safe artifact（target ごとに 1 件）。 */
  artifacts: readonly SafeAggregateArtifact[];
  /** allowlist 外で drop された入力 field（allowlist projection の可観測な証跡）。 */
  droppedInputFields: readonly string[];
};

/** rawRows に現れた allowlist 外 field を列挙する（decision の可観測化。決定論順）。 */
export function collectDroppedInputFields(
  rawRows: readonly RawAggregateEventInput[],
): string[] {
  const dropped = new Set<string>();
  for (const row of rawRows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (!ALLOWLIST_INPUT_FIELDS.has(key)) dropped.add(key);
    }
  }
  return Array.from(dropped).sort();
}

/** cohort 値に属する distinct user 数（rare-category support の測定・event 数ではない）。 */
function distinctUsersInCategory(
  rawRows: readonly RawAggregateEventInput[],
  cohortByUser: Record<string, string | undefined> | undefined,
  cohortType: CohortType,
  cohortValue: string,
): number {
  if (cohortType === 'all') return Number.POSITIVE_INFINITY; // all は rare 対象外
  const users = new Set<string>();
  for (const row of rawRows) {
    const u = typeof row.user_id === 'string' ? row.user_id.trim() : '';
    if (u === '') continue;
    if (cohortByUser?.[u] === cohortValue) users.add(u);
  }
  return users.size;
}

/**
 * synthetic ETL を実行する（pure・決定論）。target ごとに safe artifact を 1 件生成する。
 */
export function runOfflineEtl(input: OfflineEtlInput): OfflineEtlResult {
  const droppedInputFields = collectDroppedInputFields(input.rawRows);

  const artifacts: SafeAggregateArtifact[] = [];
  for (const target of input.targets) {
    // rare-category cohort 値は集計前に suppressed（cohort 値の存在自体を数値化しない）。
    const support = distinctUsersInCategory(
      input.rawRows,
      input.cohortByUser,
      target.cohortType,
      target.cohortValue,
    );
    const rare = evaluateRareCategory({
      cohortType: target.cohortType,
      distinctUsersInCategory: support,
      policy: input.rareCategoryPolicy,
    });
    if (rare.rare) {
      artifacts.push(
        buildSuppressedArtifact(
          {
            feature: target.feature,
            cohortType: target.cohortType,
            cohortValue: target.cohortValue,
            timeBucket: target.monthBucket,
            sourceWindowStart: input.window.sourceWindowStart,
            sourceWindowEnd: input.window.sourceWindowEnd,
            generatedAt: input.generatedAt,
            audience: target.audience,
            consentScope: AUDIENCE_REQUIRED_SCOPE[target.audience],
            qualityStatus: input.qualityStatus ?? 'valid',
            rolledUpFrom: null,
          },
          rare.reason,
        ),
      );
      continue;
    }

    artifacts.push(
      runFeatureUsagePrevalence({
        events: input.rawRows,
        consentByUser: input.consentByUser,
        accountTypeByUser: input.accountTypeByUser,
        cohortByUser: input.cohortByUser,
        target,
        window: input.window,
        generatedAt: input.generatedAt,
        now: input.now,
        qualityStatus: input.qualityStatus,
        options: input.options,
      }),
    );
  }

  // deterministic ordering（read 鍵の安定文字列順）。
  artifacts.sort((a, b) => {
    const ka = serializeAggregateReadKey(toAggregateReadKey(a));
    const kb = serializeAggregateReadKey(toAggregateReadKey(b));
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return { artifacts, droppedInputFields };
}

/*
 * scripts/fixtures/careerAggregateFixtures.ts
 *
 * PASSAI CAREER — Aggregated Insight (Layer 4) synthetic fixtures（P14-B・dev-only）。
 *
 * 実データ・DB・Supabase を一切使わない pure な synthetic 入力生成ヘルパ。
 * synthetic user identifier はテスト内部だけで使い、safe artifact へは残さない（QA で検証）。
 * 実在人物・実在ユーザー・実在の小規模企業名は使用しない（u0001 等の合成 ID のみ）。
 */

import type {
  AggregateAudience,
  CareerEventFeature,
  CohortType,
  ConsentRecord,
  RawAggregateEventInput,
} from '@/types/careerAggregate';
import type { FeatureUsagePrevalenceInput } from '@/lib/careerAggregate/pipeline';

// 決定論 now / month / window（マシン時刻非依存）。
export const NOW = Date.parse('2026-07-10T00:00:00.000Z');
export const TARGET_MONTH = '2026-05';
export const EVENT_TS = '2026-05-15T09:00:00.000Z'; // TARGET_MONTH 内・freshness window より十分過去
export const WINDOW = {
  sourceWindowStart: '2026-05-01T00:00:00.000Z',
  sourceWindowEnd: '2026-06-01T00:00:00.000Z',
};
export const GENERATED_AT = '2026-07-01T00:00:00.000Z';

const GRANT_TS = Date.parse('2026-01-01T00:00:00.000Z'); // event より前
const CONSENT_VERSION = 1;

// ── Consent presets ────────────────────────────────────────────────
export const consent = {
  /** user-facing aggregate を有効に grant（eligible）。 */
  fullUserFacing(): ConsentRecord {
    return {
      grantedScopes: ['personal_service_processing', 'user_facing_aggregated_insight'],
      version: CONSENT_VERSION,
      grantedAt: GRANT_TS,
      withdrawnAt: null,
      accountDeleted: false,
    };
  },
  /** personal processing のみ（aggregate 非対象）。 */
  personalOnly(): ConsentRecord {
    return {
      grantedScopes: ['personal_service_processing'],
      version: CONSENT_VERSION,
      grantedAt: GRANT_TS,
      withdrawnAt: null,
      accountDeleted: false,
    };
  },
  /** AI scope のみ（user-facing とは別 scope＝user-facing 用途では scope_mismatch）。 */
  aiOnly(): ConsentRecord {
    return {
      grantedScopes: ['ai_context_aggregated_insight'],
      version: CONSENT_VERSION,
      grantedAt: GRANT_TS,
      withdrawnAt: null,
      accountDeleted: false,
    };
  },
  versionMismatch(): ConsentRecord {
    return { ...consent.fullUserFacing(), version: CONSENT_VERSION + 1 };
  },
  grantedAfterEvent(): ConsentRecord {
    return { ...consent.fullUserFacing(), grantedAt: Date.parse('2026-06-01T00:00:00.000Z') };
  },
  withdrawnBeforeEvent(): ConsentRecord {
    return { ...consent.fullUserFacing(), withdrawnAt: Date.parse('2026-05-01T00:00:00.000Z') };
  },
  withdrawnAfterEvent(): ConsentRecord {
    return { ...consent.fullUserFacing(), withdrawnAt: Date.parse('2026-06-20T00:00:00.000Z') };
  },
  accountDeleted(): ConsentRecord {
    return { ...consent.fullUserFacing(), accountDeleted: true };
  },
  missingTimestamp(): ConsentRecord {
    return { ...consent.fullUserFacing(), grantedAt: null };
  },
  optedOut(): ConsentRecord {
    return { ...consent.fullUserFacing(), optedOut: true };
  },
  none(): undefined {
    return undefined;
  },
};

// ── Event builder ──────────────────────────────────────────────────
export function mkEvent(
  userKey: string,
  opts: {
    feature?: CareerEventFeature | string;
    eventType?: string;
    occurredAt?: string | number;
    clientEventId?: string | null;
    /** prohibited field をあえて混入する（projection が破棄することを検証する用）。 */
    inject?: Record<string, unknown>;
  } = {},
): RawAggregateEventInput {
  const base: RawAggregateEventInput = {
    user_id: userKey,
    client_event_id: opts.clientEventId === undefined ? null : opts.clientEventId,
    feature: opts.feature ?? 'interview',
    event_type: opts.eventType ?? 'feature_completed',
    occurred_at: opts.occurredAt ?? EVENT_TS,
  };
  return opts.inject ? { ...base, ...opts.inject } : base;
}

// ── Cohort builders ────────────────────────────────────────────────
/** k 人が対象 feature を 1 回ずつ利用する events（全員 user-facing 同意）。 */
export function usersEachOneEvent(
  count: number,
  feature: CareerEventFeature = 'interview',
  startIndex = 0,
): { events: RawAggregateEventInput[]; consentByUser: Record<string, ConsentRecord> } {
  const events: RawAggregateEventInput[] = [];
  const consentByUser: Record<string, ConsentRecord> = {};
  for (let i = 0; i < count; i++) {
    const u = `u${String(startIndex + i).padStart(5, '0')}`;
    events.push(mkEvent(u, { feature, clientEventId: `${u}-1` }));
    consentByUser[u] = consent.fullUserFacing();
  }
  return { events, consentByUser };
}

// ── Base pipeline input ────────────────────────────────────────────
export function baseInput(
  over: Partial<FeatureUsagePrevalenceInput> & {
    events: RawAggregateEventInput[];
    consentByUser: Record<string, ConsentRecord | undefined>;
  },
): FeatureUsagePrevalenceInput {
  const target = {
    feature: 'interview' as CareerEventFeature,
    cohortType: 'all' as CohortType,
    cohortValue: 'all',
    monthBucket: TARGET_MONTH,
    audience: 'user_facing' as AggregateAudience,
    ...(over.target ?? {}),
  };
  return {
    events: over.events,
    consentByUser: over.consentByUser,
    accountTypeByUser: over.accountTypeByUser,
    cohortByUser: over.cohortByUser,
    target,
    window: over.window ?? WINDOW,
    generatedAt: over.generatedAt ?? GENERATED_AT,
    now: over.now ?? NOW,
    qualityStatus: over.qualityStatus,
    calculationVersionOverride: over.calculationVersionOverride,
    options: over.options,
  };
}

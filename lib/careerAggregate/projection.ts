/**
 * Default-deny projection — owner event（or synthetic）→ 集計入力最小 field（P14-B / P14-A §Projection）。
 *
 * 原則（P14-A Handoff）:
 *   - default deny。allowlist（feature / event_type / occurred_at→month）だけを **明示コピー**。
 *   - raw input を spread しない。metadata / unknown key / free text / exact timestamp を残さない。
 *   - prohibited field（score_band / company_id / user 本文 等）が入力にあっても artifact へ流さない。
 *   - user_id は internal dedup 鍵としてのみ、client_event_id は duplicate 判定としてのみ保持。
 *     両者とも safe artifact へは残さない（InternalProjectedContribution の `__` key）。
 *
 * production 非接続: pure function。DB / reader / Supabase を import しない。
 */

import { KNOWN_FEATURES } from './policy';
import type {
  AggregateMetricDefinition,
  CareerEventFeature,
  CareerEventType,
  ConsentEligibilityResult,
  ExcludedAccountType,
  ProjectionResult,
  RawAggregateEventInput,
} from '@/types/careerAggregate';

const EXCLUDED_ACCOUNT_SET: ReadonlySet<string> = new Set<ExcludedAccountType>([
  'bot',
  'qa',
  'internal',
]);

/**
 * occurred_at（ISO 文字列 or epoch ms）→ YYYY-MM（UTC・決定論・exact timestamp を残さない）。
 * 不正は null。
 */
export function toMonthBucket(occurredAt: unknown): string | null {
  let ms: number | null = null;
  if (typeof occurredAt === 'number') ms = Number.isFinite(occurredAt) ? occurredAt : null;
  else if (typeof occurredAt === 'string') {
    const t = Date.parse(occurredAt);
    ms = Number.isNaN(t) ? null : t;
  }
  if (ms === null) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${mo}`;
}

function asFeatureOrNull(value: unknown): CareerEventFeature | null {
  return typeof value === 'string' && (KNOWN_FEATURES as readonly string[]).includes(value)
    ? (value as CareerEventFeature)
    : null;
}

function asEventTypeOrNull(
  value: unknown,
  allowed: readonly CareerEventType[],
): CareerEventType | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as CareerEventType)
    : null;
}

/**
 * raw event を 1 件 projection する（pure・default deny）。
 *
 * @param input.raw        raw event 相当（prohibited field 混入可・無視される）
 * @param input.eligibility consent eligibility 判定結果（ineligible は reject）
 * @param input.metric     metric 定義（許可 event_type を規定）
 * @param input.accountType 送信元 account 種別（bot / qa / internal は除外）
 */
export function projectAggregateContribution(input: {
  raw: RawAggregateEventInput;
  eligibility: ConsentEligibilityResult;
  metric: AggregateMetricDefinition;
  accountType?: string | null;
}): ProjectionResult {
  const { raw, eligibility, metric } = input;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'malformed_input' };
  }

  // consent ineligible は集計へ入れない（projection 段で明示 reject）。
  if (!eligibility || eligibility.eligible !== true) {
    return { ok: false, reason: 'consent_ineligible' };
  }

  // bot / QA / internal account は寄与させない。
  if (typeof input.accountType === 'string' && EXCLUDED_ACCOUNT_SET.has(input.accountType)) {
    return { ok: false, reason: 'excluded_account' };
  }

  const feature = asFeatureOrNull(raw.feature);
  if (!feature) return { ok: false, reason: 'unsupported_feature' };

  const eventType = asEventTypeOrNull(raw.event_type, metric.allowedEventTypes);
  if (!eventType) return { ok: false, reason: 'unsupported_event_type' };

  const monthBucket = toMonthBucket(raw.occurred_at);
  if (monthBucket === null) return { ok: false, reason: 'invalid_timestamp' };

  // user_id / client_event_id は internal dedup 鍵としてのみ保持（文字列化。それ以外は空扱い）。
  const dedupUserKey = typeof raw.user_id === 'string' && raw.user_id.trim() !== '' ? raw.user_id.trim() : '';
  if (dedupUserKey === '') return { ok: false, reason: 'malformed_input' }; // dedup できない寄与は採用しない
  const dedupEventKey =
    typeof raw.client_event_id === 'string' && raw.client_event_id.trim() !== ''
      ? raw.client_event_id.trim()
      : null;

  // ★ allowlist 分だけを **明示コピー**（raw spread なし・prohibited field は一切参照しない）。
  return {
    ok: true,
    contribution: {
      __dedupUserKey: dedupUserKey,
      __dedupEventKey: dedupEventKey,
      feature,
      eventType,
      monthBucket,
    },
  };
}

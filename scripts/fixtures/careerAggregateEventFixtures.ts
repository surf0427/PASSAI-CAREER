/*
 * scripts/fixtures/careerAggregateEventFixtures.ts
 *
 * PASSAI CAREER — Aggregated Insight offline ETL synthetic fixtures（P17-A §5.2・dev-only）。
 *
 * career_user_events 相当の「安全入力 + 禁止 field 混入」raw rows を生成し、
 * ETL の allowlist projection（禁止 field を output へ残さない）と rare-category を検証する。
 * DB / Supabase / 実データを使わない。合成 ID（u00001 等）のみ。
 */

import { consent } from './careerAggregateFixtures';
import type {
  CareerEventFeature,
  ConsentRecord,
  RawAggregateEventInput,
} from '@/types/careerAggregate';

export const ETL_MONTH = '2026-05';
export const ETL_EVENT_TS = '2026-05-15T09:00:00.000Z';
export const ETL_NOW = Date.parse('2026-07-10T00:00:00.000Z');
export const ETL_WINDOW = {
  sourceWindowStart: '2026-05-01T00:00:00.000Z',
  sourceWindowEnd: '2026-06-01T00:00:00.000Z',
};
export const ETL_GENERATED_AT = '2026-07-01T00:00:00.000Z';

/** 禁止 field を **わざと**混入した raw row（ETL が output へ残さないことを検証）。 */
export function mkRawRowWithProhibited(
  userKey: string,
  feature: CareerEventFeature = 'interview',
): RawAggregateEventInput {
  return {
    user_id: userKey,
    client_event_id: `${userKey}-1`,
    feature,
    event_type: 'feature_completed',
    occurred_at: ETL_EVENT_TS,
    // ↓ 禁止 field（projection allowlist が破棄する）。
    company_id: '00000000-0000-0000-0000-000000000000',
    score_band: 'A',
    weakness_category: 'logic',
    industry: 'it',
    metadata: 'should-be-dropped',
    text: 'raw free text that must never reach artifact',
  } as RawAggregateEventInput;
}

/** k 人が feature を 1 回ずつ利用する raw rows（全員 user-facing 同意・禁止 field 混入）。 */
export function etlUsers(
  count: number,
  feature: CareerEventFeature = 'interview',
  startIndex = 0,
): { rawRows: RawAggregateEventInput[]; consentByUser: Record<string, ConsentRecord> } {
  const rawRows: RawAggregateEventInput[] = [];
  const consentByUser: Record<string, ConsentRecord> = {};
  for (let i = 0; i < count; i++) {
    const u = `u${String(startIndex + i).padStart(5, '0')}`;
    rawRows.push(mkRawRowWithProhibited(u, feature));
    consentByUser[u] = consent.fullUserFacing();
  }
  return { rawRows, consentByUser };
}

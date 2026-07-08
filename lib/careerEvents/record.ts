"use client";

/**
 * recordCareerEvent — career_user_events への fire-and-forget 記録（STEP-CAREER-EVENTLOG-P1）。
 *
 *   - 既存 mirror helper（lib/supabase/career*.ts）と同じ boundary 設計:
 *       * getBrowserSupabaseClient() 経由（anon key + user session、RLS で owner に閉じる）。
 *       * never throw（best-effort）。userId が空（guest）/ env 未設定なら no-op。
 *       * 呼び出し側は `void recordCareerEvent(...)` で await しない。
 *   - Event Log は本文を持たない。metadata / ラベルは sanitize で allowlist 通過分のみ保存する。
 *   - 失敗しても元機能（UI / AI 結果 / localStorage canonical / 既存 mirror）を一切壊さない。
 */

import { devWarn } from '@/lib/devLog';
import { getBrowserSupabaseClient } from '@/lib/supabase/browserClient';
import {
  CAREER_EVENT_TYPES,
  CAREER_EVENT_FEATURES,
  CAREER_SCORE_BANDS,
  type CareerEventInput,
  type CareerScoreBand,
} from '@/types/careerEvents';
import { sanitizeLabel, sanitizeMetadata } from './sanitize';

const TABLE = 'career_user_events';

// company_id は uuid 列。client 側のログ id は uuid とは限らないため uuid のみ採用（他は null）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value.trim()) ? value.trim() : null;
}

function asScoreBandOrNull(value: unknown): CareerScoreBand | null {
  return typeof value === 'string' && (CAREER_SCORE_BANDS as readonly string[]).includes(value)
    ? (value as CareerScoreBand)
    : null;
}

/**
 * イベントを 1 件記録する（best-effort / never throw / await 不要）。
 * event_type / feature が未知なら no-op。guest / env 未設定でも no-op。
 */
export async function recordCareerEvent(
  userId: string | null | undefined,
  input: CareerEventInput,
): Promise<void> {
  try {
    if (!userId) return; // guest は Event Log を持たない（localStorage 専用）
    if (!input || typeof input !== 'object') return;
    if (!(CAREER_EVENT_FEATURES as readonly string[]).includes(input.feature)) return;
    if (!(CAREER_EVENT_TYPES as readonly string[]).includes(input.eventType)) return;

    const supabase = getBrowserSupabaseClient();
    if (!supabase) return; // env 未設定 = mirror 無効 = no-op

    // occurred_at / created_at は DB 側 default now()（サーバ時刻）に委ねる。
    const row = {
      user_id: userId,
      event_type: input.eventType,
      feature: input.feature,
      client_event_id: sanitizeLabel(input.clientEventId, 128),
      company_id: asUuidOrNull(input.companyId),
      industry: sanitizeLabel(input.industry),
      job_type: sanitizeLabel(input.jobType),
      selection_phase: sanitizeLabel(input.selectionPhase),
      score_band: asScoreBandOrNull(input.scoreBand),
      weakness_category: sanitizeLabel(input.weaknessCategory),
      next_action: sanitizeLabel(input.nextAction),
      completion_status: sanitizeLabel(input.completionStatus),
      metadata: sanitizeMetadata(input.metadata),
    };

    const { error } = await supabase.from(TABLE).insert(row);
    if (error) devWarn('[careerEvents] insert error', error);
  } catch (err) {
    devWarn('[careerEvents] record threw', err);
  }
}

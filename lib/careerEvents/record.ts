"use client";

/**
 * recordCareerEvent — career_user_events への fire-and-forget 記録（STEP-CAREER-EVENTLOG-P1）。
 *
 *   - 既存 mirror helper（lib/supabase/career*.ts）と同じ boundary 設計:
 *       * getCareerBrowserSupabaseClient() 経由（anon key + user session、RLS で owner に閉じる）。
 *       * never throw（best-effort）。userId が空（guest）/ env 未設定なら no-op。
 *       * 呼び出し側は `void recordCareerEvent(...)` で await しない。
 *   - Event Log は本文を持たない。metadata / ラベルは sanitize で allowlist 通過分のみ保存する。
 *   - 失敗しても元機能（UI / AI 結果 / localStorage canonical / 既存 mirror）を一切壊さない。
 */

import { devWarn } from '@/lib/devLog';
import { getCareerBrowserSupabaseClient } from '@/lib/careerSupabase/browserClient';
import {
  CAREER_EVENT_TYPES,
  CAREER_EVENT_FEATURES,
  CAREER_SCORE_BANDS,
  type CareerEventInput,
  type CareerEventMetadata,
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

// career_user_events へ insert する snake_case row。occurred_at / created_at は
// クライアントから送らず DB 側 default now()（サーバ時刻）に委ねる（列に含めない）。
export type CareerEventInsertRow = {
  user_id: string;
  event_type: string;
  feature: string;
  client_event_id: string | null;
  company_id: string | null;
  industry: string | null;
  job_type: string | null;
  selection_phase: string | null;
  score_band: CareerScoreBand | null;
  weakness_category: string | null;
  next_action: string | null;
  completion_status: string | null;
  metadata: CareerEventMetadata;
};

// 実際に row を書き込む adapter。既定は browser Supabase client。QA では stub を注入して
// row 構築（純関数）と error isolation（never throw）を DB 非依存で検査する。
export type CareerEventInsert = (row: CareerEventInsertRow) => Promise<void>;

/**
 * (userId, input) から insert row を構築する **純関数**（DB / env / secret 非依存）。
 *   - guest（userId 空）/ 非 object / 未知 feature / 未知 event_type は `null`（＝記録しない）。
 *   - client_event_id / 各ラベルは sanitize（長文・改行・本文混入を drop）。
 *   - company_id は uuid のみ採用、score_band は S/A/B/C/D のみ、metadata は allowlist scalar のみ。
 *   - user_id は引数（＝認証 user）からのみ設定。occurred_at / created_at は含めない。
 * この純関数化により writer の row 契約を決定論的 QA で回帰固定する（P9-G）。
 */
export function buildCareerEventInsertRow(
  userId: string | null | undefined,
  input: CareerEventInput,
): CareerEventInsertRow | null {
  if (!userId) return null; // guest は Event Log を持たない（localStorage 専用）
  if (!input || typeof input !== 'object') return null;
  if (!(CAREER_EVENT_FEATURES as readonly string[]).includes(input.feature)) return null;
  if (!(CAREER_EVENT_TYPES as readonly string[]).includes(input.eventType)) return null;

  return {
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
}

// 既定の insert adapter（browser Supabase client 経由）。env 未設定なら no-op。
async function insertViaBrowserClient(row: CareerEventInsertRow): Promise<void> {
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return; // env 未設定 = mirror 無効 = no-op
  const { error } = await supabase.from(TABLE).insert(row);
  if (error) devWarn('[careerEvents] insert error', error);
}

/**
 * イベントを 1 件記録する（best-effort / never throw / await 不要）。
 * event_type / feature が未知なら no-op。guest / env 未設定でも no-op。
 * 第 3 引数 `insert` は QA 用の注入 seam（本番呼び出しは 2 引数で既定 adapter を使う）。
 */
export async function recordCareerEvent(
  userId: string | null | undefined,
  input: CareerEventInput,
  insert: CareerEventInsert = insertViaBrowserClient,
): Promise<void> {
  try {
    const row = buildCareerEventInsertRow(userId, input);
    if (!row) return; // guest / 未知 feature / 未知 event_type / 非 object は記録しない
    await insert(row);
  } catch (err) {
    devWarn('[careerEvents] record threw', err);
  }
}

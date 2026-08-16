'use client';

/**
 * career_user_events の本人向け read helper（P9-B）。
 *
 *   - 既存 mirror helper（lib/supabase/career*.ts の list*）と同じ boundary 設計:
 *       * getCareerBrowserSupabaseClient() 経由（anon key + user session、RLS で owner に閉じる）。
 *       * never throw（best-effort）。userId が空（guest）/ env 未設定なら **空配列**。
 *       * fetch error は握りつぶし空配列を返す（呼び出し側 mypage を壊さない）。
 *   - owner scope（.eq('user_id', ...) + RLS 二重）で occurred_at desc 直近 N 件のみ取得。
 *   - user_id / company_id / created_at は取得しない（本人表示に不要 & 特定リスク低減）。
 *   - 取得値は本文なし観測ログ（書き込み側 sanitize 済）。表示整形は lib/careerEvents/timeline.ts。
 *   - AI prompt / context / body には一切渡さない。
 */

import { devWarn } from '@/lib/devLog';
import { getCareerBrowserSupabaseClient } from '@/lib/careerSupabase/browserClient';
import type { RecentCareerEventRow } from './timeline';

const TABLE = 'career_user_events';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// 取得 column（timeline の RecentCareerEventRow と対）。user_id / company_id は含めない。
const SELECT_COLUMNS =
  'id, event_type, feature, industry, job_type, selection_phase, ' +
  'score_band, weakness_category, next_action, completion_status, metadata, occurred_at';

/**
 * 本人の直近 career event を occurred_at 降順で返す（member only / never throw / 失敗時は []）。
 */
export async function listRecentCareerEvents(
  userId: string | null | undefined,
  limit: number = DEFAULT_LIMIT,
): Promise<RecentCareerEventRow[]> {
  if (!userId) return []; // guest は Event Log を持たない
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) return []; // env 未設定 = mirror 無効 = 空

  const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || DEFAULT_LIMIT));

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select(SELECT_COLUMNS)
      .eq('user_id', userId) // RLS に加えた明示 owner filter（既存 list* と同方針）
      .order('occurred_at', { ascending: false })
      .limit(safeLimit);
    if (error) {
      devWarn('[careerEvents] read error', error);
      return [];
    }
    // 動的 select 文字列のため戻り型が広い。owner scope の観測ログ行として扱う。
    return (data ?? []) as unknown as RecentCareerEventRow[];
  } catch (err) {
    devWarn('[careerEvents] read threw', err);
    return [];
  }
}

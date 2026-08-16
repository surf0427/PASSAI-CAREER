/**
 * Data Spine DB boundary — CAREER service-role read port（P17-E2 §3・server-only）。
 *
 * default-deny table（RLS enabled / policy 0）を **server-only の service-role** で read するための
 * 限定 factory。CAREER 専用（Project B）の service-role factory
 * （lib/careerSupabase/serviceRoleClient）を **再利用**する。受験版 Project A は参照しない。
 *
 * 厳守:
 *   - server-only（`import 'server-only'` + 既存 factory の window guard）。
 *   - service-role client を **DataSpineReadPort としてのみ**返す（raw client を上位へ出さない）。
 *   - service-role key / URL / secret をログ・戻り値へ出さない。
 *   - 生成失敗（key 未設定等）は raw error を出さず `misconfigured` / `unavailable` へ写像。
 *   - service-role は RLS を bypass するため、query 側の synthetic-only 制約で安全性を担保する
 *     （読み手の責務。本 module は read port 化のみ）。
 *   - write / batch は提供しない（synthetic seed は operator が SQL Editor で手動投入）。
 */

import 'server-only';

import { getCareerServiceRoleSupabaseClient } from '@/lib/careerSupabase/serviceRoleClient';
import { adaptReadPort, type SupabaseLikeClient } from './client';
import type { PrivilegedReadResult } from '@/lib/careerAggregate/server/runtimeTypes';

export type { PrivilegedReadResult };

/**
 * service-role read port を得る（never-throw）。
 * - key/url 未設定 → misconfigured（raw error を出さない）。
 * - browser 文脈 → 既存 factory の guard が throw → catch して unavailable。
 * 返すのは DataSpineReadPort のみ（raw SupabaseClient は封じ込める）。
 */
export function getSharedServiceRoleReadPort(): PrivilegedReadResult {
  try {
    const client = getCareerServiceRoleSupabaseClient(); // 未設定なら throw（key/url）
    const read = adaptReadPort(client as unknown as SupabaseLikeClient);
    return { status: 'available', read };
  } catch {
    // raw error message / secret を外へ出さない。判別結果のみ返す。
    return { status: 'misconfigured' };
  }
}

'use client';

/**
 * PASSAI CAREER — Layer 1 mirror の owner-scoped 削除（D-R2 closure / reset semantics）。
 *
 * 位置づけ:
 *   将来 reset / delete UI を足すときに、「localStorage だけ消えて mirror に古いデータが残る」
 *   状態を作らせないための primitive。**失敗を握りつぶさず typed に返す** ことが本 module の要件。
 *
 * 安全上の位置づけ（重要）:
 *   read 側の安全性は source-sync veto が既に構造的に担保している
 *   （client が空になれば revision が変わり mirror と不一致 → Memory は使われない）。
 *   本 module は「mirror にゴミを残さない」ための **衛生** であり、read 安全性の前提ではない。
 *   したがって delete が失敗しても AI が古いデータを見ることはない（QA T3 が固定）。
 *
 * 厳守:
 *   - owner-scoped browser client（RLS 権威）。service role を使わない。
 *   - never-throw。失敗は `ok:false` として **返す**（silent swallow 禁止）。
 *   - 任意 userId を信用しない（呼び出し側が session 由来 userId を渡す。RLS が最終権威）。
 */

import { getCareerBrowserSupabaseClient } from '@/lib/careerSupabase/browserClient';
import { CAREER_SOURCE_TABLES, type CareerSourceKind } from './types';

export type MirrorDeleteOutcome =
  | { kind: CareerSourceKind; ok: true }
  | { kind: CareerSourceKind; ok: false; reason: 'no_client' | 'guest' | 'delete_failed' };

export type MirrorDeleteReport = {
  outcomes: MirrorDeleteOutcome[];
  /** 1 件でも失敗したか。呼び出し側はこれを **無視してはいけない**（UI で silent success にしない）。 */
  hasFailure: boolean;
};

/**
 * 指定 Source kind の owner 行を mirror から削除する（never-throw・冪等）。
 * 行が存在しない場合も ok（delete は冪等）。
 */
export async function deleteCareerSourceMirrors(
  userId: string | null | undefined,
  kinds: readonly CareerSourceKind[],
): Promise<MirrorDeleteReport> {
  const outcomes: MirrorDeleteOutcome[] = [];
  if (kinds.length === 0) return { outcomes, hasFailure: false };

  if (!userId) {
    for (const kind of kinds) outcomes.push({ kind, ok: false, reason: 'guest' });
    return { outcomes, hasFailure: true };
  }
  const supabase = getCareerBrowserSupabaseClient();
  if (!supabase) {
    for (const kind of kinds) outcomes.push({ kind, ok: false, reason: 'no_client' });
    return { outcomes, hasFailure: true };
  }

  for (const kind of kinds) {
    try {
      const { error } = await supabase
        .from(CAREER_SOURCE_TABLES[kind])
        .delete()
        .eq('user_id', userId);
      outcomes.push(error ? { kind, ok: false, reason: 'delete_failed' } : { kind, ok: true });
    } catch {
      outcomes.push({ kind, ok: false, reason: 'delete_failed' });
    }
  }
  return { outcomes, hasFailure: outcomes.some((o) => !o.ok) };
}

/**
 * Data Spine DB boundary — shared server client → port adapter（P17-E §4）。
 *
 * server-only。既存の shared server Supabase client factory（lib/supabase/serverClient）を
 * **再利用**して DataSpine port へ変換する。本モジュールは client を新規実装しない・env 値を読まない
 * （factory 内部の env 解決には触れない）・URL/key/session をログに出さない。
 *
 * 厳守:
 *   - browser client を使わない / client component から import しない。
 *   - raw Supabase client を repository より上へ漏らさない（port only を返す）。
 *   - never-throw（client 取得失敗・null は null port bundle を返す）。
 *   - write/batch port は synthetic test operation 以外からまだ呼ばない（呼び出し側の責務）。
 *   - anon client + RLS default-deny のため、read は permission_denied → unavailable に fail-closed
 *     で写像される（実 synthetic read には別途 scoped policy が必要。Operator Packet 参照）。
 */

import 'server-only';

import { getServerSupabaseClient } from '@/lib/supabase/serverClient';
import { adaptBatchPort, adaptReadPort, adaptWritePort, type SupabaseLikeClient } from './client';
import type {
  DataSpineBatchPort,
  DataSpineReadPort,
  DataSpineWritePort,
} from './types';

export type SharedDataSpinePorts = {
  read: DataSpineReadPort;
  write: DataSpineWritePort;
  /** privileged batch port は anon client 上では RLS で書けない（default-deny）。synthetic 手動 seed は SQL Editor 側。 */
  batch: DataSpineBatchPort;
};

/**
 * shared server client から DataSpine port bundle を得る（never-throw）。
 * client が null（env 未設定）なら null を返す（呼び出し側は unavailable として扱う）。
 * raw client は外へ出さない。
 */
export async function getSharedDataSpinePorts(): Promise<SharedDataSpinePorts | null> {
  try {
    const client = await getServerSupabaseClient();
    if (!client) return null;
    // 構造的に SupabaseLikeClient と一致（.from().select()/insert()/update()/upsert()）。raw は封じ込める。
    const like = client as unknown as SupabaseLikeClient;
    return {
      read: adaptReadPort(like),
      write: adaptWritePort(like),
      batch: adaptBatchPort(like),
    };
  } catch {
    return null;
  }
}

/** read port のみ（shadow read はこれだけを使う）。 */
export async function getSharedDataSpineReadPort(): Promise<DataSpineReadPort | null> {
  const ports = await getSharedDataSpinePorts();
  return ports ? ports.read : null;
}

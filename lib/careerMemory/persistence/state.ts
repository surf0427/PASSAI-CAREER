// PASSAI CAREER — Personal Memory 状態モデル（P16-A Stage 3）。
//
// DB 保存 status（fresh/stale/failed）と read 時の source revision / schema version 比較から、
// 完全な状態（missing/rebuilding/unsupported_version 含む）と「書くべきか（compare-and-set）」を導く。
// 純関数・deterministic・I/O なし。

import {
  CAREER_PERSONAL_MEMORY_SCHEMA_VERSION,
  type CareerPersonalMemoryDerivedState,
} from './schema';

// read 済み現在行の最小メタ（repository の CareerPersonalMemoryReadRow の部分集合）。
export type CurrentMemoryMeta = {
  schemaVersion: number;
  sourceRevision: string;
  status: 'fresh' | 'stale' | 'failed';
  generatedAt: string;
} | null;

// 期待値（Source から算出した現行 revision）。
export type ExpectedMemoryMeta = {
  sourceRevision: string;
};

// 現在行 + 期待 revision から状態を導出する。
export function deriveMemoryState(
  current: CurrentMemoryMeta,
  expected: ExpectedMemoryMeta,
): CareerPersonalMemoryDerivedState {
  if (current === null) return 'missing';
  if (current.schemaVersion !== CAREER_PERSONAL_MEMORY_SCHEMA_VERSION) return 'unsupported_version';
  if (current.status === 'failed') return 'failed';
  if (current.sourceRevision !== expected.sourceRevision) return 'stale';
  return 'fresh';
}

// prompt に使ってよいか（fresh のみ。stale/failed/missing/unsupported は request-time fallback）。
export function isUsableForPrompt(state: CareerPersonalMemoryDerivedState): boolean {
  return state === 'fresh';
}

// compare-and-set: 書くべきか判定（idempotency / stale overwrite 防止 / out-of-order 防止）。
//   - unchanged: 現在が fresh かつ revision 一致 → 書かない。
//   - stale_write: 既存 generatedAt が今回より新しい（＝より新しい write が既にある）→ 書かない。
//   - それ以外（missing/stale/failed/unsupported/version 変化/revision 変化）→ 書く。
export type WriteDecision =
  | { write: true }
  | { write: false; reason: 'unchanged' | 'stale_write' };

export function decideWrite(
  current: CurrentMemoryMeta,
  expectedRevision: string,
  now: string,
): WriteDecision {
  if (current !== null) {
    const versionOk = current.schemaVersion === CAREER_PERSONAL_MEMORY_SCHEMA_VERSION;
    // 同一版・同一 revision・fresh → 変化なし（idempotent skip）。
    if (versionOk && current.status === 'fresh' && current.sourceRevision === expectedRevision) {
      return { write: false, reason: 'unchanged' };
    }
    // out-of-order 防止: 既存の generatedAt が今回より後（新しい write が既にある）→ 上書きしない。
    if (current.generatedAt !== '' && now < current.generatedAt) {
      return { write: false, reason: 'stale_write' };
    }
  }
  return { write: true };
}

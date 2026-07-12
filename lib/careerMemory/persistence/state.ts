// PASSAI CAREER — Personal Memory 状態モデル（P16-A Stage 3 / P16-C cross-device hardening）。
//
// DB 保存 status（fresh/stale/failed）と read 時の source revision / schema version 比較から、
// 完全な状態（missing/rebuilding/unsupported_version 含む）と「書くべきか（compare-and-set）」を導く。
// 純関数・deterministic・I/O なし。
//
// ★ 正しさの権威（P16-C 明文化）:
//   Personal Memory は再構築可能な **cache** であり source of truth ではない。cross-device で古い Memory が
//   書かれ得るが、**prompt に使ってよいかは read 時に「Memory.sourceRevision == その端末の現 Source から算出した
//   revision」で判定**する（deriveMemoryState → isUsableForPrompt が fresh のみ許可）。revision 不一致（stale）は
//   prompt に使わず request-time fallback + rebuild。よって **write の順序保証は correctness の前提ではない**。
//   write 側の out-of-order 判定は churn 削減の best-effort であり、**client 書込時刻（generatedAt）を権威にしない**。
//   順序の手掛かりには Source データの新しさ（sourceUpdatedAt = Source の createdAt/updatedAt 由来）を使う。

import {
  CAREER_PERSONAL_MEMORY_SCHEMA_VERSION,
  type CareerPersonalMemoryDerivedState,
} from './schema';

// read 済み現在行の最小メタ（repository の CareerPersonalMemoryReadRow の部分集合）。
export type CurrentMemoryMeta = {
  schemaVersion: number;
  sourceRevision: string;
  status: 'fresh' | 'stale' | 'failed';
  // Source データの新しさ（log 系は max(createdAt)、base 等は null）。out-of-order 判定の手掛かり。
  sourceUpdatedAt: string | null;
  // 観測用の書込時刻（compare-and-set の権威には **しない**。cross-device の client 時計はずれ得るため）。
  generatedAt: string;
} | null;

// 期待値（今回 Source から算出した現行 revision と Source の新しさ）。
export type ExpectedMemoryMeta = {
  sourceRevision: string;
  // 今回書こうとしている Memory の由来 Source の新しさ（無ければ null）。
  sourceUpdatedAt: string | null;
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
//   ★ これが cross-device の correctness 権威（古い Memory は revision 不一致で fresh にならない＝使われない）。
export function isUsableForPrompt(state: CareerPersonalMemoryDerivedState): boolean {
  return state === 'fresh';
}

// compare-and-set: 書くべきか判定（idempotency / stale overwrite 防止・best-effort）。
//   - unchanged: 現在が fresh かつ revision 一致 → 書かない。
//   - stale_write: **Source データの新しさ**で判定。今回の由来 Source（expected.sourceUpdatedAt）が、既存が
//     由来した Source（current.sourceUpdatedAt）より **古い**ときだけ上書きしない（古い Source 由来 Memory で
//     新しい Source 由来 Memory を潰さない）。両者の sourceUpdatedAt が揃わない（base 等 null）ときは順序判定
//     不能 → revision 差があれば書く（last-writer。read 時 revision 検証が correctness を担保）。
//   - client 書込時刻（generatedAt）は判定に使わない（cross-device の client 時計はずれ得るため）。
//   - それ以外（missing/stale/failed/unsupported/version 変化/revision 変化）→ 書く。
export type WriteDecision =
  | { write: true }
  | { write: false; reason: 'unchanged' | 'stale_write' };

export function decideWrite(
  current: CurrentMemoryMeta,
  expected: ExpectedMemoryMeta,
): WriteDecision {
  if (current !== null) {
    const versionOk = current.schemaVersion === CAREER_PERSONAL_MEMORY_SCHEMA_VERSION;
    // 同一版・同一 revision・fresh → 変化なし（idempotent skip）。
    if (versionOk && current.status === 'fresh' && current.sourceRevision === expected.sourceRevision) {
      return { write: false, reason: 'unchanged' };
    }
    // out-of-order 防止（best-effort・Source データの新しさ基準）: 両者に sourceUpdatedAt があり、今回の
    //   Source が既存より **厳密に古い**ときだけ skip。client 時計は権威にしない。
    if (
      current.sourceUpdatedAt !== null &&
      expected.sourceUpdatedAt !== null &&
      expected.sourceUpdatedAt < current.sourceUpdatedAt
    ) {
      return { write: false, reason: 'stale_write' };
    }
  }
  return { write: true };
}

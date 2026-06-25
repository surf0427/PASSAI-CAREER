// PASSAI 就活版 — avoidances キャップ（減点ではなく上限）。純粋関数。
//
// 例: ユーザーが「全国転勤がある」を避けたい & 企業が nationwide_transfer フラグを持つ
//     → マッチ度は最大 70 まで（95 にはならない）。
// 複数該当時は最も厳しい（最小の）キャップを採用する。

import { AVOIDANCE_FLAG_MAP, capForFlag } from './weights';
import type { AppliedCap } from './types';

export function applyAvoidanceCaps(
  matchTotal: number,
  avoidances: string[],
  companyFlags: string[],
): { total: number; appliedCaps: AppliedCap[] } {
  const flagSet = new Set(companyFlags);
  const appliedCaps: AppliedCap[] = [];

  for (const avoidance of avoidances) {
    const flag = AVOIDANCE_FLAG_MAP[avoidance];
    if (!flag) continue;
    if (flagSet.has(flag)) {
      appliedCaps.push({ flag, label: avoidance, cap: capForFlag(flag) });
    }
  }

  if (appliedCaps.length === 0) return { total: matchTotal, appliedCaps: [] };

  const cap = Math.min(...appliedCaps.map((c) => c.cap));
  return { total: Math.min(matchTotal, cap), appliedCaps };
}

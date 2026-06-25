// PASSAI 就活版 — 活躍可能性（入社後にどれだけ活躍できそうか）の決定的スコア。
// 純粋関数。AI/UI/route 非依存。match/readiness とは独立に計算する（流用しない）。
//
// 性格・強み・モチベーション源泉・ストレス相性・成長志向 と、職務/社風の成功要因の相性。
// 絶対評価（required 無し）。

import { buildBreakdown, type BreakdownInput } from './core';
import { SUCCESS_AXES, SUCCESS_AXIS_LABELS, SUCCESS_WEIGHTS } from './weights';
import type { CompanyEngineInput, ScoreBreakdown, ScoreSignal } from './types';

function findSignal(signals: ScoreSignal[], key: string): ScoreSignal | undefined {
  return signals.find((s) => s.key === key);
}

export function scoreSuccess(company: CompanyEngineInput): ScoreBreakdown {
  const items: BreakdownInput[] = SUCCESS_AXES.map((axis) => {
    const key = `success:${axis}`;
    const sig = findSignal(company.successSignals, key);
    return {
      key,
      label: SUCCESS_AXIS_LABELS[axis],
      value: sig ? sig.value : 0,
      weight: SUCCESS_WEIGHTS[axis],
      present: !!sig && sig.present,
      source: sig ? sig.source : 'absent',
      rationale: sig ? sig.rationale : '',
    };
  });
  return buildBreakdown(items);
}

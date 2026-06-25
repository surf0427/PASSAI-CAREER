// PASSAI 就活版 — マッチ度（価値観・性格・活動との相性）の決定的スコア。
// 純粋関数。AI/UI/route 非依存。total = items の重み付き合算。

import { buildBreakdown, type BreakdownInput } from './core';
import { MATCH_AXES, MATCH_AXIS_LABELS } from './weights';
import type { CompanyEngineInput, MatchProfile, ScoreBreakdown, ScoreSignal } from './types';

function findSignal(signals: ScoreSignal[], key: string): ScoreSignal | undefined {
  return signals.find((s) => s.key === key);
}

// マッチ度を計算する（キャップ未適用。キャップは caps.ts で別途）。
export function scoreMatch(profile: MatchProfile, company: CompanyEngineInput): ScoreBreakdown {
  const items: BreakdownInput[] = MATCH_AXES.map((axis) => {
    const key = `match:${axis}`;
    const sig = findSignal(company.matchSignals, key);
    const weight = profile.matchWeights[key] ?? 1;
    return {
      key,
      label: MATCH_AXIS_LABELS[axis],
      value: sig ? sig.value : 0,
      weight,
      present: !!sig && sig.present,
      source: sig ? sig.source : 'absent',
      rationale: sig ? sig.rationale : '',
      // マッチは絶対評価（required 無し）。
    };
  });
  return buildBreakdown(items);
}

// PASSAI 就活版 — 選考準備度（内定可能性ではない）の決定的スコア。
// 純粋関数。AI/UI/route 非依存。
//
// 各 readiness シグナルを「企業バー（要求ライン）」に対して評価する（受験版 calcItemFit 同型）。
// 高ティア企業ほど required が高く、同じ準備でも準備度は下がる。
// 欠損シグナル（SPI 未受験など）は重みから除外し、confidence を下げる（0 点扱いしない）。

import { buildBreakdown, type BreakdownInput } from './core';
import {
  BAR_REQUIRED_BY_TIER,
  READINESS_KEYS,
  READINESS_LABELS,
  READINESS_WEIGHTS,
  type ReadinessKey,
} from './weights';
import type { CompanyEngineInput, ScoreBreakdown, ScoreSignal } from './types';

function findSignal(signals: ScoreSignal[], key: string): ScoreSignal | undefined {
  return signals.find((s) => s.key === key);
}

export function scoreReadiness(company: CompanyEngineInput): ScoreBreakdown {
  const required = BAR_REQUIRED_BY_TIER[company.barTier];
  const items: BreakdownInput[] = READINESS_KEYS.map((key: ReadinessKey) => {
    const sigKey = `readiness:${key}`;
    const sig = findSignal(company.readinessSignals, sigKey);
    return {
      key: sigKey,
      label: READINESS_LABELS[key],
      value: sig ? sig.value : 0,
      weight: READINESS_WEIGHTS[key],
      present: !!sig && sig.present,
      source: sig ? sig.source : 'absent',
      rationale: sig ? sig.rationale : '',
      required,
    };
  });
  return buildBreakdown(items);
}

// PASSAI 就活版 — 不足能力の優先度（サーバ計算）と改善ロードマップ。純粋関数。
//
// 不足優先度は AI に並べさせず、選考準備度への「感度」から決める:
//   各 readiness シグナルを要求ラインまで引き上げたら準備度が何点上がるか（Δ）を計算し、
//   Δ が大きい順に並べる。欠損シグナル（未着手）は伸びしろが大きく上位に来やすい。
// ロードマップは優先度順に並べ、各ステップを PASSAI の機能へ接続する。

import { scoreReadiness } from './scoreReadiness';
import {
  BAR_REQUIRED_BY_TIER,
  READINESS_KEYS,
  READINESS_LABELS,
  featureLinkFor,
  type ReadinessKey,
} from './weights';
import type { CompanyEngineInput, Gap, RoadmapStep, ScoreSignal } from './types';

const IMPROVE_MARGIN = 8; // 要求ラインを少し超える水準まで改善する想定

function cloneSignals(signals: ScoreSignal[]): ScoreSignal[] {
  return signals.map((s) => ({ ...s }));
}

// 1 社分の不足能力を優先度付きで返す。
export function analyzeGaps(company: CompanyEngineInput): Gap[] {
  const base = scoreReadiness(company).total;
  const target = Math.min(100, BAR_REQUIRED_BY_TIER[company.barTier] + IMPROVE_MARGIN);

  const gaps: Gap[] = READINESS_KEYS.map((key: ReadinessKey) => {
    const sigKey = `readiness:${key}`;
    const current = company.readinessSignals.find((s) => s.key === sigKey);
    const currentValue = current && current.present ? current.value : 0;

    // 既に十分（要求ラインを満たす）なら改善対象から外す（Δ=0）。
    if (current && current.present && currentValue >= target) {
      return {
        key: sigKey,
        label: READINESS_LABELS[key],
        current: currentValue,
        present: true,
        deltaIfImproved: 0,
        feature: featureLinkFor(key),
        priority: 0,
      };
    }

    // このシグナルだけを target まで引き上げて準備度を再計算 → Δ が優先度。
    const improved = cloneSignals(company.readinessSignals).filter((s) => s.key !== sigKey);
    improved.push({
      key: sigKey,
      value: target,
      present: true,
      source: current?.source === 'measured' ? 'measured' : 'ai_inferred',
      rationale: '改善後の想定値',
    });
    const newTotal = scoreReadiness({ ...company, readinessSignals: improved }).total;
    const delta = Math.max(0, newTotal - base);

    return {
      key: sigKey,
      label: READINESS_LABELS[key],
      current: currentValue,
      present: !!current && current.present,
      deltaIfImproved: delta,
      feature: featureLinkFor(key),
      priority: delta,
    };
  });

  // Δ が大きい順。Δ 同値は readiness の定義順で安定ソート（決定的）。
  return gaps
    .filter((g) => g.deltaIfImproved > 0)
    .sort((a, b) => b.priority - a.priority || keyOrder(a.key) - keyOrder(b.key));
}

function keyOrder(sigKey: string): number {
  const k = sigKey.replace('readiness:', '') as ReadinessKey;
  const idx = READINESS_KEYS.indexOf(k);
  return idx === -1 ? 999 : idx;
}

// 優先度順に上位 topN を改善ロードマップ化する。
export function buildRoadmap(gaps: Gap[], topN = 4): RoadmapStep[] {
  return gaps.slice(0, topN).map((gap, i) => ({
    order: i + 1,
    label: gap.label,
    feature: gap.feature,
    reason: gap.present
      ? `現状 ${gap.current} 点。強化すると選考準備度が約 +${gap.deltaIfImproved} 見込み。`
      : `未着手のため伸びしろが大きい（選考準備度 約 +${gap.deltaIfImproved} 見込み）。`,
    expectedReadinessGain: gap.deltaIfImproved,
  }));
}

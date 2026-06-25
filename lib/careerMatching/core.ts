// PASSAI 就活版 — スコアリングエンジンの共有プリミティブ（純粋関数のみ）。
//
// 受験版 lib/matching/calculateScore.ts と同じ「重み付き寄与の合算」パターンを踏襲しつつ、
// 就活版向けに (1) 0〜100 スケール (2) 欠損(present:false)の重み除外 (3) confidence 算出
// を加える。AI・UI・route に依存しない。

import type {
  Confidence,
  ScoreBreakdown,
  ScoreBreakdownItem,
  SignalSource,
} from './types';

// 0〜100 に丸める（NaN/非数は 0）。受験版・就活版 route と同名・同挙動。
export function clampScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// 1 シグナルの適合度（0.0〜1.0）。
// required（その企業の要求ライン）があれば「満たせば 1.0・不足は比例で減点」。
// required が無ければ value をそのまま 0〜1 に正規化（マッチ/活躍など絶対評価）。
export function calcFit(value: number, required?: number): number {
  const v = Math.max(0, Math.min(100, value));
  if (required === undefined || required <= 0) return v / 100;
  if (v >= required) return 1;
  return Math.max(0, v / required);
}

export type BreakdownInput = {
  key: string;
  label: string;
  value: number;
  weight: number;
  present: boolean;
  source: SignalSource;
  rationale: string;
  required?: number; // 企業バー（readiness で使用）。未指定なら絶対評価。
};

// present×measured 比率から確信度を決める。
function computeConfidence(items: BreakdownInput[]): Confidence {
  if (items.length === 0) return 'low';
  const present = items.filter((i) => i.present);
  const presentRatio = present.length / items.length;
  const measuredCount = present.filter(
    (i) => i.source === 'measured' || i.source === 'verified_fact',
  ).length;
  const measuredRatio = present.length === 0 ? 0 : measuredCount / present.length;
  if (presentRatio >= 0.7 && measuredRatio >= 0.5) return 'high';
  if (presentRatio >= 0.4) return 'mid';
  return 'low';
}

// 重み付き寄与から ScoreBreakdown を組み立てる。
// total = Σ contribution（最大 100）。欠損は重み合計から除外し、残りで按分する
// （= 未入力でもスコアが 0 に潰れず、入力済みの範囲で評価される）。
export function buildBreakdown(items: BreakdownInput[]): ScoreBreakdown {
  const active = items.filter((i) => i.present);
  const totalWeight = active.reduce((sum, i) => sum + i.weight, 0) || 1;

  const breakdownItems: ScoreBreakdownItem[] = active.map((i) => {
    const fit = calcFit(i.value, i.required);
    const maxContribution = (i.weight / totalWeight) * 100;
    return {
      key: i.key,
      label: i.label,
      value: Math.round(Math.max(0, Math.min(100, i.value))),
      weight: i.weight,
      contribution: Math.round(fit * maxContribution),
      source: i.source,
      rationale: i.rationale,
    };
  });

  const total = Math.min(
    100,
    breakdownItems.reduce((sum, i) => sum + i.contribution, 0),
  );

  return {
    items: breakdownItems,
    total: Math.round(total),
    confidence: computeConfidence(items),
    missingKeys: items.filter((i) => !i.present).map((i) => i.key),
  };
}

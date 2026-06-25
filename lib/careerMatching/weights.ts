// PASSAI 就活版 — 重み・ラベル・キャップ・接続先の正本（純粋データ + 純粋関数）。
//
// 固定重みではなく、careerValues の priorities を「マッチ軸の加点重み」に変換する。
// avoidances は減点ではなく「企業属性フラグに該当したらマッチ度に上限キャップ」を掛ける。
// 重み・キャップ・接続先はすべてここに集約し、将来の学習結果の注入点もここに限定する。

import type {
  CareerFeatureKey,
  CompanyBarTier,
  FeatureLink,
  SignalWeights,
} from './types';

// ── マッチ軸（company と本人の相性の観点） ──
export const MATCH_AXES = [
  'values',
  'culture',
  'workstyle',
  'growth',
  'stability',
  'compensation',
  'industry_job_fit',
] as const;
export type MatchAxis = (typeof MATCH_AXES)[number];

export const MATCH_AXIS_LABELS: Record<MatchAxis, string> = {
  values: '価値観の一致',
  culture: '社風・人間関係',
  workstyle: '働き方',
  growth: '成長環境・裁量',
  stability: '安定性',
  compensation: '待遇・年収志向',
  industry_job_fit: '業界・職種の一致',
};

// priorities の選択ラベルに含まれるキーワード → 加点するマッチ軸。
// 部分一致で判定するため、選択肢が増えても拾える（careerValuesCategories.ts と疎結合）。
const PRIORITY_KEYWORD_TO_AXIS: Array<{ kw: string; axis: MatchAxis }> = [
  { kw: '年収', axis: 'compensation' },
  { kw: '初任給', axis: 'compensation' },
  { kw: '昇給', axis: 'compensation' },
  { kw: 'ボーナス', axis: 'compensation' },
  { kw: '福利厚生', axis: 'compensation' },
  { kw: '補助', axis: 'compensation' },
  { kw: '退職金', axis: 'compensation' },
  { kw: '成長', axis: 'growth' },
  { kw: '裁量', axis: 'growth' },
  { kw: '研修', axis: 'growth' },
  { kw: '専門性', axis: 'growth' },
  { kw: '市場価値', axis: 'growth' },
  { kw: '独立', axis: 'growth' },
  { kw: '休', axis: 'workstyle' },
  { kw: '残業', axis: 'workstyle' },
  { kw: '有給', axis: 'workstyle' },
  { kw: 'リモート', axis: 'workstyle' },
  { kw: 'フレックス', axis: 'workstyle' },
  { kw: '勤務地', axis: 'workstyle' },
  { kw: '転勤', axis: 'workstyle' },
  { kw: 'ワークライフバランス', axis: 'workstyle' },
  { kw: '安定', axis: 'stability' },
  { kw: '大手', axis: 'stability' },
  { kw: '知名度', axis: 'stability' },
  { kw: 'ホワイト', axis: 'stability' },
  { kw: '人間関係', axis: 'culture' },
  { kw: '社風', axis: 'culture' },
  { kw: '評価', axis: 'culture' },
  { kw: '実力', axis: 'culture' },
  { kw: '社会貢献', axis: 'values' },
  { kw: '好きなこと', axis: 'values' },
  { kw: '英語', axis: 'values' },
  { kw: 'グローバル', axis: 'values' },
  { kw: '海外', axis: 'values' },
];

const BASE_MATCH_WEIGHT = 1.0;
const PRIORITY_BOOST = 0.6; // priorities で選ばれた軸 1 件ごとの加点

// priorities → マッチ軸の重み（全軸 1.0 から、選ばれた軸を加点）。
// 同じ入力なら必ず同じ重み（決定的）。
export function deriveMatchWeights(priorities: string[]): SignalWeights {
  const weights: SignalWeights = {};
  for (const axis of MATCH_AXES) weights[`match:${axis}`] = BASE_MATCH_WEIGHT;
  for (const p of priorities) {
    for (const { kw, axis } of PRIORITY_KEYWORD_TO_AXIS) {
      if (p.includes(kw)) weights[`match:${axis}`] += PRIORITY_BOOST;
    }
  }
  return weights;
}

// ── readiness（選考準備度）シグナル ──
export const READINESS_KEYS = [
  'es',
  'interview',
  'gakuchika',
  'self_understanding',
  'spi',
  'presentation',
  'english',
  'certifications',
] as const;
export type ReadinessKey = (typeof READINESS_KEYS)[number];

export const READINESS_LABELS: Record<ReadinessKey, string> = {
  es: 'ES（エントリーシート）',
  interview: '面接力',
  gakuchika: 'ガクチカ・実績',
  self_understanding: '自己理解の深さ',
  spi: 'SPI・適性検査',
  presentation: 'プレゼン力',
  english: '英語・語学',
  certifications: '資格・スキル',
};

// 選考で効きやすい要素を厚めに。
export const READINESS_WEIGHTS: Record<ReadinessKey, number> = {
  es: 1.4,
  interview: 1.4,
  gakuchika: 1.3,
  self_understanding: 1.0,
  spi: 1.1,
  presentation: 0.8,
  english: 0.8,
  certifications: 0.8,
};

// 企業バー（選考難易度ティア → 各 readiness シグナルの要求ライン 0〜100）。
// 高ティアほど要求が高く、同じ準備でも準備度は下がる（= 相対的な厳しさ）。
export const BAR_REQUIRED_BY_TIER: Record<CompanyBarTier, number> = {
  S: 85,
  A: 72,
  B: 60,
  C: 50,
};

// ── success（活躍可能性）軸 ──
export const SUCCESS_AXES = [
  'strength_fit',
  'culture_fit',
  'motivation_fit',
  'stress_tolerance',
  'growth_mindset',
] as const;
export type SuccessAxis = (typeof SUCCESS_AXES)[number];

export const SUCCESS_AXIS_LABELS: Record<SuccessAxis, string> = {
  strength_fit: '強みの活かしやすさ',
  culture_fit: '社風への適応',
  motivation_fit: 'モチベーションの源泉との一致',
  stress_tolerance: 'ストレス耐性・相性',
  growth_mindset: '成長志向の一致',
};

export const SUCCESS_WEIGHTS: Record<SuccessAxis, number> = {
  strength_fit: 1.3,
  culture_fit: 1.1,
  motivation_fit: 1.1,
  stress_tolerance: 1.0,
  growth_mindset: 1.0,
};

// ── avoidances → 企業属性フラグ（キャップ判定） ──
// AI にはこの value（フラグ）の語彙を渡し、該当する企業属性を companyFlags として返させる。
// avoidance の選択ラベル（careerValuesCategories.ts の B カテゴリ）と 1:1 対応。
export const AVOIDANCE_FLAG_MAP: Record<string, string> = {
  残業が多い: 'high_overtime',
  休日出勤がある: 'holiday_work',
  有給が取りづらい: 'hard_to_take_leave',
  全国転勤がある: 'nationwide_transfer',
  地方転勤がある: 'regional_transfer',
  勤務地が選べない: 'fixed_location',
  ノルマが厳しい: 'strong_quota',
  営業色が強すぎる: 'heavy_sales',
  体育会系すぎる: 'militaristic',
  飲み会が多い: 'many_drinking',
  上下関係が厳しい: 'strict_hierarchy',
  離職率が高い: 'high_turnover',
  給与が低い: 'low_salary',
  昇給しにくい: 'slow_raise',
  年功序列すぎる: 'seniority_based',
  実力主義すぎる: 'too_meritocratic',
  評価基準が不透明: 'opaque_evaluation',
  口コミが悪い: 'bad_reviews',
  業界の将来性が低い: 'low_industry_growth',
  会社の安定性が低い: 'low_stability',
  単純作業が多い: 'monotonous',
  ルーティンワークが多い: 'routine_heavy',
  顧客対応が多すぎる: 'heavy_customer',
  クレーム対応が多い: 'complaint_heavy',
  夜勤がある: 'night_shift',
  シフト制: 'shift_work',
  土日勤務: 'weekend_work',
  肉体労働が多い: 'physical_labor',
  プレッシャーが強すぎる: 'high_pressure',
  成果主義が強すぎる: 'too_meritocratic_result',
  社風が古い: 'old_culture',
  '女性/若手が活躍しにくい': 'hard_for_women_young',
  ハラスメント体質がありそう: 'possible_harassment',
  競争が激しすぎる: 'too_competitive',
};

// AI に渡すフラグ語彙（重複排除）。
export const COMPANY_FLAG_VOCAB: readonly string[] = Array.from(
  new Set(Object.values(AVOIDANCE_FLAG_MAP)),
);

// キャップ値。原則 70。本人の納得感に大きく関わる重い項目は 60。
const HARD_CAP_FLAGS = new Set(['high_turnover', 'possible_harassment']);
export const DEFAULT_CAP = 70;
export const HARD_CAP = 60;

export function capForFlag(flag: string): number {
  return HARD_CAP_FLAGS.has(flag) ? HARD_CAP : DEFAULT_CAP;
}

// ── 不足能力 → PASSAI 内の接続先機能 ──
// 未実装機能（spi/presentation/gd）は最も近い既存ページへ誘導し、ラベルで明示する。
export const FEATURE_LINKS: Record<ReadinessKey, FeatureLink> = {
  es: { featureKey: 'es', href: '/career/es', label: 'ESを作成・改善する' },
  interview: { featureKey: 'interview', href: '/career/interview', label: '面接練習をする' },
  gakuchika: { featureKey: 'activity', href: '/career/activity', label: '活動整理で実績を深掘る' },
  self_understanding: {
    featureKey: 'self-analysis',
    href: '/career/self-analysis',
    label: '自己分析を深める',
  },
  spi: { featureKey: 'spi', href: '/career/home', label: 'SPI・適性検査対策（準備中）' },
  presentation: { featureKey: 'presentation', href: '/career/home', label: 'プレゼン対策（準備中）' },
  english: { featureKey: 'english', href: '/career/activity', label: '語学・資格を活動整理に追加' },
  certifications: { featureKey: 'activity', href: '/career/activity', label: '資格・スキルを追加する' },
};

export function featureLinkFor(key: string): FeatureLink {
  return (
    FEATURE_LINKS[key as ReadinessKey] ?? {
      featureKey: 'self-analysis' as CareerFeatureKey,
      href: '/career/home',
      label: '次のアクションを確認する',
    }
  );
}

export function normalizeBarTier(value: unknown): CompanyBarTier {
  return value === 'S' || value === 'A' || value === 'B' || value === 'C'
    ? value
    : 'B';
}

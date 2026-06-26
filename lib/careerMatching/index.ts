// PASSAI 就活版 — 企業マッチング スコアリングエンジン 公開エントリ。
//
// 利用側は `import { ... } from '@/lib/careerMatching'` で参照する。内部ファイルを直接
// import しない（受験版 lib/matching/ との混同・密結合を避けるため）。
// 本モジュールは純粋ロジックのみ（AI / UI / API route / DB 非依存）。

// 型・定数
export type {
  SignalSource,
  AiMatchingSignal,
  ScoreSignal,
  ScoreBreakdownItem,
  Confidence,
  ScoreBreakdown,
  AppliedCap,
  CompanyBarTier,
  SignalWeights,
  CareerFeatureKey,
  FeatureLink,
  Gap,
  RoadmapStep,
  MatchProfile,
  CompanyEngineInput,
  EngineInput,
  CompanyScore,
  SimulationChange,
  SimulationInput,
  SimulationResult,
  CareerMatchEngineResult,
} from './types';
export { CAREER_MATCHING_SCHEMA_VERSION, READINESS_DISCLAIMER } from './types';

// 重み・ラベル・キャップ・接続先（route がシグナル整形に使う）
export {
  MATCH_AXES,
  MATCH_AXIS_LABELS,
  deriveMatchWeights,
  READINESS_KEYS,
  READINESS_LABELS,
  READINESS_WEIGHTS,
  BAR_REQUIRED_BY_TIER,
  SUCCESS_AXES,
  SUCCESS_AXIS_LABELS,
  AVOIDANCE_FLAG_MAP,
  COMPANY_FLAG_VOCAB,
  FEATURE_LINKS,
  featureLinkFor,
  normalizeBarTier,
} from './weights';

// コア
export { clampScore, calcFit, buildBreakdown } from './core';

// スコア関数（3スコア独立）
export { scoreMatch } from './scoreMatch';
export { scoreReadiness } from './scoreReadiness';
export { scoreSuccess } from './scoreSuccess';

// キャップ・不足優先度・ロードマップ
export { applyAvoidanceCaps } from './caps';
export { analyzeGaps, buildRoadmap } from './roadmap';

// エンジン本体・順位付け・シミュレーション
export { scoreCompany, rankCompanies, runCareerMatch } from './engine';
export { simulateChanges } from './simulation';

// measured readiness のアンチコラプション層（既存データ → readiness シグナル）
export type { MeasuredReadinessInput, MeasuredReadinessSignal } from './measuredReadiness';
export { buildMeasuredReadiness, mergeReadinessSignals } from './measuredReadiness';

// PASSAI 就活版 — 企業マッチング 決定的スコアリングエンジンの型
//
// 就活版独自のスコアリングモジュール。受験版 lib/matching/ とは完全に分離する
// （別エンジン・型・重みを共有しない）。AI には依存しない純粋ロジックの型のみを置く。
//
// 設計契約（docs/principles/ai_score_contract.md・docs/matching/career_matching_phase3_implementation.md）:
//   - AI は小スコア（AiMatchingSignal）と根拠のみ返す。
//   - 総合スコア・順位・不足優先度・ロードマップ・シミュレーションはすべて本モジュールの
//     純粋関数がサーバ側で計算する。
//   - 同じ入力なら必ず同じ出力（決定的）。
//   - 欠損データ（present:false）は 0 点ではなく「重みから除外」し confidence に反映する。

// ── スコアの版数（永続化データの後方互換に使う） ──
export const CAREER_MATCHING_SCHEMA_VERSION = 1;

// 「選考準備度」に必須で添える注記（合否非保証）。
export const READINESS_DISCLAIMER =
  '選考準備度は現時点の準備状況の目安であり、合否を保証するものではありません。';

// ── シグナルの出所（事実/推測の分離） ──
// measured: 既存機能データから決定的に算出（事実寄り） / ai_inferred: AI の推測判断 /
// user_input: ユーザー入力由来 / verified_fact: 出典付き事実（将来の CompanyFacts 用） /
// absent: データ無し（present:false）。
export type SignalSource =
  | 'measured'
  | 'ai_inferred'
  | 'user_input'
  | 'verified_fact'
  | 'absent';

// AI が返してよい唯一のスコア表現。総合点・順位は含めない。
export type AiMatchingSignal = {
  key: string; // 'match:*' | 'readiness:*' | 'success:*' の制御語彙
  value: number; // 0〜100（部分スコアのみ）
  rationale: string; // なぜこの値か（Explainability）
  source: 'ai_inferred' | 'user_input' | 'verified_fact';
};

// エンジンが受け取る解決済みシグナル。
export type ScoreSignal = {
  key: string;
  value: number; // 0〜100
  present: boolean;
  source: SignalSource;
  rationale: string;
};

// ── スコア内訳（match / readiness / success で共通） ──
export type ScoreBreakdownItem = {
  key: string;
  label: string;
  value: number; // 本人の素のシグナル値（0〜100）
  weight: number;
  contribution: number; // 100点満点中の寄与点
  source: SignalSource;
  rationale: string;
};

export type Confidence = 'high' | 'mid' | 'low';

export type ScoreBreakdown = {
  items: ScoreBreakdownItem[];
  total: number; // 0〜100。items の重み付き寄与の合算（キャップ適用は別工程）。
  confidence: Confidence; // present×measured 比率から算出
  missingKeys: string[]; // present:false だったキー
};

// ── avoidances キャップ（減点ではなく上限） ──
export type AppliedCap = {
  flag: string; // 企業属性フラグ
  label: string; // 該当した避けたい条件（日本語）
  cap: number; // この企業のマッチ度上限
};

// 企業の選考難易度ティア（MVP は AI 推測、将来は内定者データで較正）。
export type CompanyBarTier = 'S' | 'A' | 'B' | 'C';

export type SignalWeights = Record<string, number>;

// ── 不足能力・ロードマップ ──
// PASSAI 内の接続先機能。
export type CareerFeatureKey =
  | 'es'
  | 'interview'
  | 'activity'
  | 'self-analysis'
  | 'consultation'
  | 'spi'
  | 'presentation'
  | 'gd'
  | 'english';

export type FeatureLink = {
  featureKey: CareerFeatureKey;
  href: string;
  label: string;
};

export type Gap = {
  key: string; // readiness シグナルキー
  label: string;
  current: number; // 現在値（present:false は 0）
  present: boolean;
  deltaIfImproved: number; // 改善した場合の選考準備度の上昇幅（感度）
  feature: FeatureLink;
  priority: number; // = deltaIfImproved（大きいほど優先）
};

export type RoadmapStep = {
  order: number;
  label: string;
  feature: FeatureLink;
  reason: string;
  expectedReadinessGain: number;
};

// ── エンジンの入出力 ──
// ユーザー側の統合プロファイル（重みの源泉。決定的）。
export type MatchProfile = {
  matchWeights: SignalWeights; // priorities 由来のマッチ軸重み
  avoidances: string[]; // 避けたい条件（生ラベル）
  schemaVersion: number;
};

// 企業 1 社分のエンジン入力。
export type CompanyEngineInput = {
  company: string;
  matchSignals: ScoreSignal[];
  readinessSignals: ScoreSignal[];
  successSignals: ScoreSignal[];
  barTier: CompanyBarTier;
  companyFlags: string[]; // avoidances キャップ判定用の企業属性フラグ
  matchReasons: string[];
  strengthsUsed: string[];
  attentionPoints: string[];
  nextActions: string[];
};

export type EngineInput = {
  profile: MatchProfile;
  companies: CompanyEngineInput[];
};

// 企業 1 社分の最終スコア（UI はこれを描画するだけ）。
export type CompanyScore = {
  company: string;
  match: ScoreBreakdown; // キャップ適用後の total を持つ
  matchUncapped: number; // キャップ前のマッチ度（説明用）
  appliedCaps: AppliedCap[];
  readiness: ScoreBreakdown; // 表示名は「選考準備度」
  success: ScoreBreakdown; // 表示名は「活躍可能性」
  barTier: CompanyBarTier;
  gaps: Gap[];
  roadmap: RoadmapStep[];
  matchReasons: string[];
  strengthsUsed: string[];
  attentionPoints: string[];
  nextActions: string[];
};

// シミュレーション（MVP は土台のみ）。
export type SimulationChange = {
  key: string; // 変更するシグナルキー
  toValue: number; // 改善後の値（0〜100）
};

export type SimulationInput = {
  base: EngineInput;
  changes: SimulationChange[];
};

export type SimulationResult = {
  before: CompanyScore[];
  after: CompanyScore[];
  rankingDelta: Array<{ company: string; from: number; to: number }>;
  scoreDelta: Array<{
    company: string;
    match: number;
    readiness: number;
    success: number;
  }>;
};

// エンジン全体の出力（永続化単位）。AI 由来のテキストとサーバ計算のスコアを束ねる。
export type CareerMatchEngineResult = {
  schemaVersion: number;
  profileSummary: string;
  careerType: string;
  recommendedIndustries: string[];
  recommendedJobs: string[];
  developmentAreas: string[];
  nextSteps: string[];
  companies: CompanyScore[];
  readinessDisclaimer: string;
};

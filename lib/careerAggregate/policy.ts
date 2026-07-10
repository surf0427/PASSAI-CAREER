/**
 * Aggregated Insight (Layer 4) — 中心 policy 定数（P14-B / P14-A Handoff 準拠）。
 *
 * すべて P14-A 監査で確定した値を **唯一の設計根拠**として固定する。cohort 閾値は全て
 * `PROVISIONAL`（実データ分布未確認・法務未確認）で、絶対的安全値としては扱わない。
 *
 * production 非接続: 本ファイルは定数のみ。DB / API / AI / matching / consultation / mypage
 *   へは接続しない。production consumer から import されない状態を維持する。
 */

import {
  CAREER_EVENT_FEATURES,
  type CareerEventFeature,
  type CareerEventType,
} from '@/types/careerEvents';
import type {
  AggregateConsumer,
  AggregateMetricDefinition,
  CohortThresholdPolicy,
  CohortType,
  ConsentScope,
  ConsumerCapability,
  ExcludedAccountType,
  SuppressionReason,
} from '@/types/careerAggregate';

// ── Field allowlist / prohibited（P14-A Handoff §Field allowlist）───────────
/** projection が直接残せる field（変換不要でそのまま許可）。 */
export const ALLOWED_SOURCE_FIELDS: readonly string[] = ['feature', 'event_type'];

/** 変換後にのみ許可される field。 */
export const ALLOWED_AFTER_TRANSFORM_FIELDS: readonly string[] = [
  'occurred_at', // → month bucket（exact timestamp は残さない）
  'completion_status', // → boolean 化する場合のみ（初期 metric では未使用）
];

/**
 * projection / artifact へ **決して**流してはいけない field（default-deny の明示リスト）。
 * このリストは「網羅」ではなく明示禁止であり、projection は allowlist 方式（ここに無い key も破棄）。
 */
export const PROHIBITED_SOURCE_FIELDS: readonly string[] = [
  'user_id',
  'hashed_user_id',
  'client_event_id',
  'id',
  'created_at',
  'company_id',
  'score_band',
  'weakness_category',
  'next_action',
  'metadata',
  'industry',
  'job_type',
  'selection_phase',
  // 自由記述 / 本文系（Event Log には元々入らないが二重防御で明示）。
  'text',
  'body',
  'content',
  'answer',
  'transcript',
  'matching_score',
  'matching_ranking',
  'readiness',
  'success_prediction',
];

// ── Consent scopes（P14-A Handoff §Consent policy / Option C）────────────
export const CONSENT_SCOPES: readonly ConsentScope[] = [
  'personal_service_processing',
  'internal_aggregated_analytics',
  'user_facing_aggregated_insight',
  'ai_context_aggregated_insight',
  'externally_shared_insight',
  'company_knowledge_contribution',
];

/** Layer 5 境界。Layer 4 contract では eligibility が **決して**満たさない scope。 */
export const LAYER5_ONLY_SCOPE: ConsentScope = 'company_knowledge_contribution';

/** 現在の consent policy version（DB は作らない。判定契約の固定値）。 */
export const CURRENT_CONSENT_POLICY_VERSION = 1;

/** audience → 必要 consent scope（purpose limitation を型で固定）。 */
export const AUDIENCE_REQUIRED_SCOPE: Record<
  'internal' | 'user_facing' | 'ai_context',
  ConsentScope
> = {
  internal: 'internal_aggregated_analytics',
  user_facing: 'user_facing_aggregated_insight',
  ai_context: 'ai_context_aggregated_insight',
};

// ── Cohort thresholds（P14-A §Cohort policy・全て PROVISIONAL）──────────
export const COHORT_THRESHOLDS: CohortThresholdPolicy = {
  absoluteLowerBound: 10, // これ未満は常に suppressed
  internal: 20,
  userFacing: 50, // first insight は user-facing threshold を適用
  aiContext: 100, // 最保守（AI は言い換えで漏洩し得る）
  status: 'PROVISIONAL',
};

/** 初期許可 cohort type。graduation_year は単独のみ・他属性と交差禁止。 */
export const ALLOWED_COHORT_TYPES: readonly CohortType[] = ['all', 'graduation_year'];

/**
 * 初期禁止 dimension（P14-A では industry / job_type / selection_phase は将来条件付きだが、
 * P14-B の初期 contract では **禁止**へ倒す）。任意 metadata / 任意複合 dimension も禁止。
 */
export const PROHIBITED_DIMENSIONS: readonly string[] = [
  'company',
  'industry',
  'job_type',
  'selection_type',
  'selection_stage',
  'selection_phase',
  'university',
  'faculty',
  'department',
  'gender',
  'score_band',
  'metadata',
];

/** roll-up 許可（graduation_year は不足時 all へ集約可能。all は roll-up 先なし）。 */
export function rollUpCohortCandidate(cohortType: CohortType): CohortType | null {
  return cohortType === 'graduation_year' ? 'all' : null;
}

// ── Contribution bounding（P14-A §Contribution rule）────────────────────
/** 集計から除外する account 種別（bot / QA / internal）。 */
export const EXCLUDED_ACCOUNT_TYPES: readonly ExcludedAccountType[] = ['bot', 'qa', 'internal'];

/** freshness delay（直近 h 時間内の event は incomplete window として除外）。 */
export const FRESHNESS_DELAY_HOURS = 48;

/** aggregate TTL（generated_at からの有効期間。stale 判定・cache 失効の基準）。 */
export const AGGREGATE_TTL_HOURS = 24 * 8; // 週次 batch を跨がない範囲

// ── First metric definition（P14-A §First insight・PROVISIONAL）──────────
/** この metric で projection が受け入れる正式 event_type（実 enum に存在する値のみ）。 */
export const FEATURE_USAGE_PREVALENCE_EVENT_TYPES: readonly CareerEventType[] = [
  'feature_started',
  'feature_completed',
];

export const FEATURE_USAGE_PREVALENCE: AggregateMetricDefinition = {
  metricKey: 'feature_usage_prevalence',
  displayName: 'この時期の一般的な準備傾向',
  calculationVersion: 'feature_usage_prevalence@1',
  allowedEventTypes: FEATURE_USAGE_PREVALENCE_EVENT_TYPES,
  contributionUnit: 'user_level_boolean',
  allowedCohortTypes: ['all', 'graduation_year'],
  timeBucket: 'month',
  status: 'PROVISIONAL',
};

/** feature 語彙（projection の feature 妥当性検証に使う。単一 source）。 */
export const KNOWN_FEATURES: readonly CareerEventFeature[] = CAREER_EVENT_FEATURES;

// ── Disclaimer / wording（P14-A §AI policy / §Safe renderer）─────────────
export const AGGREGATE_DISCLAIMER_KEY = 'aggregate_general_trend_v1';

/** 非因果・非評価の固定 disclaimer（必ず付与する）。 */
export const AGGREGATE_DISCLAIMER =
  'これは十分な人数を含む匿名集計上の一般的な利用傾向であり、' +
  'あなたの能力・準備度・適性・選考結果を示すものではありません。' +
  '本人の入力や状況を最優先し、準備の参考情報としてのみ利用してください。';

/** cohort 不足時に許可される唯一の user-facing 文言（数値は返さない）。 */
export const INSUFFICIENT_DATA_MESSAGE = '十分なデータがありません。';

/**
 * renderer が **決して**生成してはいけない表現（QA で固定）。
 * 個人評価・因果・能力/合否の断定・属性適性・比較を禁止する。
 */
export const PROHIBITED_RENDER_PHRASES: readonly string[] = [
  '遅れています',
  '遅れている',
  '準備不足',
  '能力が低い',
  '能力が高い',
  '合格可能性が高い',
  '合格します',
  '受かった',
  '向いています',
  '不足しています',
  '平均より下',
  '平均より上',
  '優秀',
];

// ── Legal review markers（コードで法的結論を確定しない）──────────────────
export const LEGAL_REVIEW_REQUIRED = 'LEGAL_REVIEW_REQUIRED' as const;

/** コードで結論を出さず法務確認へ委ねる論点（技術設計判断と分離）。 */
export const LEGAL_REVIEW_TOPICS: readonly string[] = [
  'explicit_opt_in_required_scope',
  'anonymized_or_pseudonymized_classification',
  'aggregate_created_before_withdrawal_handling',
  'contribution_removal_after_withdrawal',
  'aggregate_recomputation_after_account_deletion',
  'retention_period',
  'minor_user_handling',
];

// ── Suppression reasons（列挙の単一 source）──────────────────────────────
export const SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  'below_absolute_minimum',
  'below_audience_threshold',
  'rare_category',
  'prohibited_dimension',
  'unsupported_dimension_intersection',
  'unsafe_time_granularity',
  'consent_ineligible',
  'stale_source',
  'incomplete_batch',
  'invalid_calculation_version',
  'quality_check_failed',
  'complementary_suppression_required',
];

// ── Consumer capability boundary（P14-A §Consumer boundary）───────────────
/**
 * 将来条件付きで許可可能な consumer / 初期禁止 / matching 恒久禁止 を明示 allowlist 化する。
 * P14-B では全 consumer が `not_connected`。
 */
export const CONSUMER_CAPABILITIES: readonly ConsumerCapability[] = [
  { consumer: 'mypage', futureAllowed: true, currentConnection: 'not_connected', permanentlyProhibited: false, note: 'user-facing reference insight（k>=50・suppress 済のみ）' },
  { consumer: 'consultation', futureAllowed: true, currentConnection: 'not_connected', permanentlyProhibited: false, note: 'supplemental insight（最下位補助・disclaimer 必須）' },
  { consumer: 'onboarding', futureAllowed: true, currentConnection: 'not_connected', permanentlyProhibited: false, note: 'general example' },
  { consumer: 'notification', futureAllowed: true, currentConnection: 'not_connected', permanentlyProhibited: false, note: 'general timing' },
  { consumer: 'internal_analytics', futureAllowed: true, currentConnection: 'not_connected', permanentlyProhibited: false, note: 'privacy-safe internal（k>=20）' },
  { consumer: 'ai_context', futureAllowed: true, currentConnection: 'not_connected', permanentlyProhibited: false, note: 'k>=100・AI scope・suppress 済・disclaimer 必須（今回非接続）' },
  { consumer: 'es', futureAllowed: false, currentConnection: 'not_connected', permanentlyProhibited: false, note: '初期禁止' },
  { consumer: 'interview', futureAllowed: false, currentConnection: 'not_connected', permanentlyProhibited: false, note: '初期禁止' },
  { consumer: 'presentation', futureAllowed: false, currentConnection: 'not_connected', permanentlyProhibited: false, note: '初期禁止' },
  { consumer: 'gd', futureAllowed: false, currentConnection: 'not_connected', permanentlyProhibited: false, note: '初期禁止' },
  { consumer: 'company_research', futureAllowed: false, currentConnection: 'not_connected', permanentlyProhibited: false, note: '初期禁止' },
  { consumer: 'self_analysis', futureAllowed: false, currentConnection: 'not_connected', permanentlyProhibited: false, note: '初期禁止' },
  // matching は恒久禁止。adapter / mapper / converter を作らない。
  { consumer: 'matching', futureAllowed: false, currentConnection: 'not_connected', permanentlyProhibited: true, note: '恒久禁止（score / ranking / readiness / success / candidate generation / prompt / context 一切）' },
];

/** consumer が現在 aggregate を受け取れるか（capability の currentConnection から導出）。
 *  P14-B では全 capability が not_connected のため常に false（production 非接続）。 */
export function isConsumerConnected(consumer: AggregateConsumer): boolean {
  return CONSUMER_CAPABILITIES.some(
    (c) => c.consumer === consumer && c.currentConnection !== 'not_connected',
  );
}

/** matching への使用が恒久禁止であることを型/実行時の両方で保証するヘルパ。 */
export function isPermanentlyProhibitedConsumer(consumer: AggregateConsumer): boolean {
  return CONSUMER_CAPABILITIES.some((c) => c.consumer === consumer && c.permanentlyProhibited);
}

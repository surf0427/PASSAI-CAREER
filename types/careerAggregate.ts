/**
 * Aggregated Insight (Layer 4) — privacy / consent / cohort **contract types**（P14-B）。
 *
 * 位置づけ（P14-A decision C / P14-B start GO・production 非接続限定）:
 *   将来の「匿名・集計された集合知（Layer 4）」実装で、禁止データ・少数 cohort・consent 不整合・
 *   matching 誤接続が起きないよう、**型・policy・pure function・synthetic QA を先に固定**する。
 *   本ファイルは **型のみ**（repo 規約: 型は types/）。ロジックは lib/careerAggregate/*。
 *
 * 重要な分離:
 *   - personal Event Signal（L2 / lib/careerMemory/eventSignals.ts）と本 domain は **別物**。
 *     CareerEventSignalSummary を Layer 4 公開型として流用しない（P14-A Handoff）。
 *   - 本 domain は **cross-user 集計の契約**であり、owner-scoped Event Signal の傾向表示ではない。
 *   - feature / event_type の語彙だけは単一の source（types/careerEvents.ts）を type-only 参照する。
 *
 * production 非接続（P14-B 禁止範囲）: DB / SQL / migration / API / cron / service-role / 実データ /
 *   AI 接続 / matching 接続 / consultation・mypage 接続 は **本 series では作らない**。
 */

import type { CareerEventFeature, CareerEventType } from '@/types/careerEvents';

// ── Metric ─────────────────────────────────────────────────────────
/** 初期 pilot metric key（固定・1 種のみ・PROVISIONAL）。 */
export type AggregateMetricKey = 'feature_usage_prevalence';

/** metric 計算版（version mismatch を型で扱えるようにする）。 */
export type CalculationVersion = `${AggregateMetricKey}@${number}`;

/** metric 定義（fixed metric / fixed input / fixed dimension）。 */
export type AggregateMetricDefinition = {
  metricKey: AggregateMetricKey;
  displayName: string;
  calculationVersion: CalculationVersion;
  /** projection が受け入れる event_type（この metric で許可された正式 enum のみ）。 */
  allowedEventTypes: readonly CareerEventType[];
  /** 集計単位（初期は unique-user boolean 固定）。 */
  contributionUnit: 'user_level_boolean';
  /** metric が許可する cohort type。 */
  allowedCohortTypes: readonly CohortType[];
  /** time bucket 粒度（初期は month 固定）。 */
  timeBucket: TimeBucketGranularity;
  status: PolicyStatus;
};

// ── Consent ────────────────────────────────────────────────────────
/** Option C（目的別・段階的 opt-in）の consent scope。 */
export type ConsentScope =
  | 'personal_service_processing'
  | 'internal_aggregated_analytics'
  | 'user_facing_aggregated_insight'
  | 'ai_context_aggregated_insight'
  | 'externally_shared_insight'
  // Layer 5 境界。Layer 4 contract 上は常に非対象（eligibility で決して満たさない）。
  | 'company_knowledge_contribution';

/** aggregate の想定 audience（scope と 1:1 で対応させ purpose limitation を型で固定）。 */
export type AggregateAudience = 'internal' | 'user_facing' | 'ai_context';

/** consent 状態（DB は作らない。判定入力の pure な形のみ）。 */
export type ConsentRecord = {
  /** grant 済み scope（明示 opt-in のみ。privacy notice 閲覧・利用規約包括同意は含めない）。 */
  grantedScopes: readonly ConsentScope[];
  /** grant 済み consent policy version。 */
  version: number;
  /** grant 時刻（epoch ms）。未取得は null（＝ineligible 材料）。 */
  grantedAt: number | null;
  /** 撤回時刻（epoch ms）。未撤回は null。 */
  withdrawnAt: number | null;
  /** account 削除済みか。 */
  accountDeleted: boolean;
  /** 明示 opt-out（default off）。 */
  optedOut?: boolean;
};

/** eligibility 判定結果（eligible or 具体的 ineligible 理由）。 */
export type ConsentEligibilityStatus =
  | 'eligible'
  | 'missing_consent'
  | 'scope_mismatch'
  | 'version_mismatch'
  | 'granted_after_event'
  | 'withdrawn_before_event'
  | 'account_deleted'
  | 'invalid_timestamp'
  | 'unsupported_purpose';

export type ConsentEligibilityResult = {
  eligible: boolean;
  status: ConsentEligibilityStatus;
  /** 判定に用いた required scope（監査・provenance 用）。 */
  requiredScope: ConsentScope;
};

// ── Cohort / Suppression ───────────────────────────────────────────
/** 初期許可 cohort type（company / industry / job_type / 属性交差は禁止）。 */
export type CohortType = 'all' | 'graduation_year';

/** time bucket 粒度（初期 pilot は month のみ。exact / day / week は禁止）。 */
export type TimeBucketGranularity = 'month';

/** policy 値の確定状態（暫定 policy を型で保持する）。 */
export type PolicyStatus = 'PROVISIONAL' | 'FIXED';

/** aggregate の品質状態（stale / incomplete / failed は valid として返さない）。 */
export type AggregateQualityStatus = 'valid' | 'stale' | 'incomplete' | 'failed';

/** suppression 理由（数値を返さない理由の列挙）。 */
export type SuppressionReason =
  | 'below_absolute_minimum'
  | 'below_audience_threshold'
  | 'rare_category'
  | 'prohibited_dimension'
  | 'unsupported_dimension_intersection'
  | 'unsafe_time_granularity'
  | 'consent_ineligible'
  | 'stale_source'
  | 'incomplete_batch'
  | 'invalid_calculation_version'
  | 'quality_check_failed'
  | 'complementary_suppression_required';

/** cohort 閾値 policy（audience 別・全て PROVISIONAL）。 */
export type CohortThresholdPolicy = {
  absoluteLowerBound: number;
  internal: number;
  userFacing: number;
  aiContext: number;
  status: PolicyStatus;
};

/** cohort guard の判定結果。suppressed の場合は数値を持たせない。 */
export type CohortDecision =
  | { suppressed: false; audience: AggregateAudience; thresholdApplied: number }
  | { suppressed: true; reason: SuppressionReason; rollUpCandidate: CohortType | null };

// ── Projection ─────────────────────────────────────────────────────
/**
 * projection 入力（owner event 相当 or synthetic）。
 * prohibited field（score_band / company_id / metadata / user 本文 等）が混じっていても、
 * projection は allowlist 分だけを明示コピーし、これらは **一切 artifact へ流さない**。
 */
export type RawAggregateEventInput = {
  user_id?: unknown;
  client_event_id?: unknown;
  feature?: unknown;
  event_type?: unknown;
  occurred_at?: unknown;
  completion_status?: unknown;
  // 他の任意 key（prohibited 含む）が存在し得るが projection は無視する。
  [key: string]: unknown;
};

/** 除外対象 account 種別（bot / QA / internal は集計へ寄与させない）。 */
export type ExcludedAccountType = 'bot' | 'qa' | 'internal';

export type ProjectionRejectReason =
  | 'malformed_input'
  | 'unsupported_feature'
  | 'unsupported_event_type'
  | 'invalid_timestamp'
  | 'excluded_account'
  | 'consent_ineligible';

/**
 * 集計内部だけで扱う projected contribution。
 * 先頭 `__` の identity key は **dedup 内部専用**で、safe artifact へは決してコピーしない。
 */
export type InternalProjectedContribution = {
  /** user_id 由来。unique-user dedup 鍵としてのみ使用。artifact へ残さない。 */
  __dedupUserKey: string;
  /** client_event_id 由来。duplicate / retry 判定にのみ使用。artifact へ残さない。 */
  __dedupEventKey: string | null;
  feature: CareerEventFeature;
  eventType: CareerEventType;
  /** occurred_at を bucket 化した YYYY-MM（exact timestamp は保持しない）。 */
  monthBucket: string;
};

export type ProjectionResult =
  | { ok: true; contribution: InternalProjectedContribution }
  | { ok: false; reason: ProjectionRejectReason };

/** contribution bounding 後の user-level boolean（1 user × 1 bucket × 1 feature）。 */
export type BoundedContribution = {
  __dedupUserKey: string;
  feature: CareerEventFeature;
  monthBucket: string;
};

// ── Safe Aggregate Artifact ────────────────────────────────────────
/** sample size は生の小 count を出さず bucket 表示にする。 */
export type SampleSizeBucket = '50–99' | '100–199' | '200–499' | '500+';

export type AggregateProvenance = {
  metricKey: AggregateMetricKey;
  calculationVersion: CalculationVersion;
  consentScope: ConsentScope;
  audience: AggregateAudience;
  policyStatus: PolicyStatus;
  /** graduation_year → all へ roll-up した場合の元 cohort（監査用）。 */
  rolledUpFrom: CohortType | null;
  /**
   * Closure Batch（`D-C2`）: この aggregate の入力になった **data class**。
   * 「どの分類の data から作られたか」を artifact 自身から追えるようにする（Human 指示 §10）。
   * optional は後方互換のため。未設定は「未記録」であり「任意 source 可」ではない。
   */
  sourceDataClass?: string | null;
  /** Closure Batch: retention / policy の版（どの policy 下で保持しているか）。 */
  retentionPolicyVersion?: string | null;
};

/** 全 variant 共通の非数値メタ（識別子・exact time・raw を含めない）。 */
export type SafeAggregateArtifactBase = {
  metricKey: AggregateMetricKey;
  calculationVersion: CalculationVersion;
  /** prevalence 対象の feature（allowlist field・非識別）。 */
  feature: CareerEventFeature;
  cohortType: CohortType;
  /** coarse cohort 値（'all' もしくは卒年等の粗い値）。個人を絞り込む細粒度を持たない。 */
  cohortValue: string;
  timeBucket: string; // YYYY-MM（exact timestamp ではない）
  sourceWindowStart: string; // ISO（batch window。exact event time ではない）
  sourceWindowEnd: string; // ISO
  generatedAt: string; // ISO
  expiresAt: string; // ISO
  consentScope: ConsentScope;
  provenance: AggregateProvenance;
  qualityStatus: AggregateQualityStatus;
  disclaimerKey: string;
};

/** 十分な cohort があり数値を公開できる状態。 */
export type ValidAggregateArtifact = SafeAggregateArtifactBase & {
  kind: 'valid';
  numerator: number;
  denominator: number;
  /** numerator / denominator（0..1）。 */
  prevalence: number;
  sampleSizeBucket: SampleSizeBucket;
  suppression: { suppressed: false };
};

/** eligible contributor が 0 の既知ゼロ状態（suppressed とは区別する）。数値 ratio は持たない。 */
export type ZeroAggregateArtifact = SafeAggregateArtifactBase & {
  kind: 'zero';
  denominator: 0;
  suppression: { suppressed: false };
};

/** cohort 不足・品質不良等で数値を返さない状態。numerator / denominator / ratio を **持たない**。 */
export type SuppressedAggregateArtifact = SafeAggregateArtifactBase & {
  kind: 'suppressed';
  suppression: { suppressed: true; reason: SuppressionReason };
};

export type SafeAggregateArtifact =
  | ValidAggregateArtifact
  | ZeroAggregateArtifact
  | SuppressedAggregateArtifact;

// ── Safe Renderer ──────────────────────────────────────────────────
/** user-facing / AI-safe renderer の出力（数値の生表示はせず語彙化 + 固定 disclaimer）。 */
export type SafeRenderedAggregate = {
  /** 表示可能な一般傾向文（valid のみ）。suppressed / zero は neutral 文言。 */
  text: string;
  /** 常に付与する非因果・非評価 disclaimer。 */
  disclaimer: string;
  /** render された artifact の種別（consumer 側の分岐用）。 */
  kind: SafeAggregateArtifact['kind'];
};

/** AI へ渡してよい最小 context 契約（今回 AI へは接続しない）。 */
export type AiSafeAggregateContext = {
  metricDescription: string;
  cohortDescription: string;
  coarseTimeWindow: string;
  sufficientCohort: true; // 不十分な cohort は context 自体を作らない
  sampleSizeBucket: SampleSizeBucket;
  nonCausalDisclaimer: string;
  nonEvaluativeDisclaimer: string;
  calculationVersion: CalculationVersion;
};

// ── Consumer capability boundary ───────────────────────────────────
export type AggregateConsumer =
  | 'mypage'
  | 'consultation'
  | 'onboarding'
  | 'notification'
  | 'internal_analytics'
  | 'ai_context'
  | 'es'
  | 'interview'
  | 'presentation'
  | 'gd'
  | 'company_research'
  | 'self_analysis'
  | 'matching';

export type ConsumerCapability = {
  consumer: AggregateConsumer;
  /** 将来条件付きで許可可能か（初期禁止 / matching は恒久禁止）。 */
  futureAllowed: boolean;
  /** 現在の接続状態（P14-B では全 consumer NOT_CONNECTED）。 */
  currentConnection: 'not_connected';
  /** matching は恒久禁止フラグ。 */
  permanentlyProhibited: boolean;
  note: string;
};

// re-export（consumer が careerEvents を再 import せずに語彙を扱えるよう）。
export type { CareerEventFeature, CareerEventType };
